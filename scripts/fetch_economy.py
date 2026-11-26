#!/usr/bin/env python3
"""Build data/economy.json from economy.yml.

Sources:
  fred      FRED CSV download (fred.stlouisfed.org), no API key
  yahoo     Yahoo Finance via yfinance
  eurostat  Eurostat dissemination API (JSON-stat)
  derived   spread / ratio of two other indicators

All series are aligned on calendar months (last observation of each month).
The cycle score maps selected indicators onto [-1, 1] and averages them.

Usage:  python scripts/fetch_economy.py [--config economy.yml] [--out data/economy.json]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml
from curl_cffi import requests as http

ROOT = Path(__file__).resolve().parent.parent
FRED_START = "1985-01-01"
# FRED's CDN rejects plain HTTP clients; impersonating a browser's TLS works.
SESSION = http.Session(impersonate="chrome")

Series = list[tuple[str, float]]  # [(YYYY-MM-DD, value)], sorted
Monthly = dict[int, float]        # {month index: value}


# --------------------------------------------------------------------------- months
def midx(date: str) -> int:
    return int(date[:4]) * 12 + int(date[5:7]) - 1


def mstr(i: int) -> str:
    return f"{i // 12:04d}-{i % 12 + 1:02d}"


def to_monthly(series: Series) -> Monthly:
    out: Monthly = {}
    for d, v in series:  # sorted, so the last value of each month wins
        out[midx(d)] = v
    return out


# --------------------------------------------------------------------------- sources
def get(url: str, retries: int = 3, timeout: int = 60):
    for attempt in range(retries):
        try:
            r = SESSION.get(url, timeout=timeout)
            if r.status_code == 200:
                return r
            err = f"HTTP {r.status_code}"
        except Exception as exc:  # noqa: BLE001
            err = str(exc)
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{url[:90]}: {err}")


def fetch_fred(series_id: str) -> Series:
    r = get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={FRED_START}")
    rows = list(csv.reader(io.StringIO(r.text)))[1:]
    out = []
    for row in rows:
        if len(row) >= 2 and row[1] not in ("", "."):
            try:
                out.append((row[0], float(row[1])))
            except ValueError:
                pass
    if not out:
        raise RuntimeError(f"FRED {series_id}: no data")
    return out


def fetch_yahoo(symbol: str) -> Series:
    import yfinance as yf  # imported lazily: heavy

    t = yf.Ticker(symbol)
    long = t.history(period="max", interval="1mo", auto_adjust=False)
    recent = t.history(period="2y", interval="1d", auto_adjust=False)
    if recent.empty and long.empty:
        raise RuntimeError(f"Yahoo {symbol}: no data")
    cut = recent.index[0].strftime("%Y-%m-%d") if not recent.empty else "9999"
    out: dict[str, float] = {}
    for frame, only_before in ((long, True), (recent, False)):
        for ts, v in frame["Close"].items():
            d = ts.strftime("%Y-%m-%d")
            if v is None or math.isnan(v) or (only_before and d >= cut):
                continue
            out[d] = float(v)
    return sorted(out.items())


def fetch_eurostat(dataset: str, params: dict) -> Series:
    q = "&".join(f"{k}={v}" for k, v in params.items())
    r = get(f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset}?{q}&sinceTimePeriod=1990-01")
    d = r.json()
    inv = {v: k for k, v in d["dimension"]["time"]["category"]["index"].items()}
    out = []
    for k, v in d.get("value", {}).items():
        period = inv[int(k)]  # "2026-09" or "2026-Q3"
        if "Q" in period:
            y, q_ = period.split("-Q")
            period = f"{y}-{int(q_) * 3:02d}"
        out.append((period + "-01", float(v)))
    if not out:
        raise RuntimeError(f"Eurostat {dataset} {params}: no data")
    return sorted(out)


def source_url(ind: dict) -> str | None:
    s, sid = ind.get("source"), ind.get("series")
    if s == "fred":
        return f"https://fred.stlouisfed.org/series/{sid}"
    if s == "yahoo":
        return f"https://finance.yahoo.com/quote/{sid}"
    if s == "eurostat":
        return f"https://ec.europa.eu/eurostat/databrowser/view/{sid}/default/table"
    return None


# --------------------------------------------------------------------------- transforms
def apply_transform(m: Monthly, transform: str, smooth: int | None) -> Monthly:
    out: Monthly = {}
    for i, v in m.items():
        if transform == "level":
            out[i] = v
        elif transform == "yoy":
            p = m.get(i - 12)
            if p:
                out[i] = (v / p - 1) * 100
        elif transform == "diff":
            p = m.get(i - 1)
            if p is not None:
                out[i] = v - p
        elif transform == "diff12":
            p = m.get(i - 12)
            if p is not None:
                out[i] = v - p
        else:
            raise ValueError(f"unknown transform {transform}")
    if smooth and smooth > 1:
        sm: Monthly = {}
        for i in out:
            window = [out.get(i - k) for k in range(smooth)]
            if all(w is not None for w in window):
                sm[i] = sum(window) / smooth
        out = sm
    return out


def scale_series(m: Monthly, k: float | None) -> Monthly:
    return {i: v * k for i, v in m.items()} if k else m


def score_value(v: float, bear: float, bull: float) -> float:
    s = -1 + 2 * (v - bear) / (bull - bear)
    return max(-1.0, min(1.0, s))


def ffill(m: Monthly, start: int, end: int, limit: int) -> Monthly:
    out: Monthly = {}
    last_i, last_v = None, None
    for i in range(min([start] + list(m)), end + 1):
        if i in m:
            last_i, last_v = i, m[i]
        if i >= start and last_i is not None and i - last_i <= limit:
            out[i] = last_v
    return out


def nearest_before(series: Series, date: str) -> tuple[str, float] | None:
    best = None
    for d, v in series:
        if d <= date:
            best = (d, v)
        else:
            break
    return best


def detect_freq(series: Series) -> str:
    """D/W/M/Q from the median gap between the last observations."""
    tail = [dt.date.fromisoformat(d) for d, _ in series[-12:]]
    gaps = sorted((b - a).days for a, b in zip(tail, tail[1:]))
    if not gaps:
        return "M"
    g = gaps[len(gaps) // 2]
    return "D" if g <= 4 else "W" if g <= 10 else "M" if g <= 45 else "Q"


def rnd(x, n=4):
    return None if x is None else round(x, n)


# --------------------------------------------------------------------------- main build
def build(config: dict) -> dict:
    settings = config.get("settings") or {}
    cyc_cfg = config.get("cycle") or {}
    yc_cfg = config.get("yield_curve") or {}
    indicators = config.get("indicators") or []

    # 1. collect fetch jobs -------------------------------------------------
    jobs: dict[tuple, dict] = {}
    for ind in indicators:
        s = ind.get("source")
        if s == "fred":
            jobs[("fred", ind["series"])] = {}
        elif s == "yahoo":
            jobs[("yahoo", ind["series"])] = {"fallback": ind.get("fallback")}
        elif s == "eurostat":
            jobs[("eurostat", ind["series"], json.dumps(ind.get("params") or {}, sort_keys=True))] = {}
    for t in yc_cfg.get("tenors") or []:
        jobs[("fred", t["series"])] = {}
    rec_id = cyc_cfg.get("recession_series")
    if rec_id:
        jobs[("fred", rec_id)] = {}

    def run(key):
        kind = key[0]
        try:
            if kind == "fred":
                return key, fetch_fred(key[1]), None
            if kind == "eurostat":
                return key, fetch_eurostat(key[1], json.loads(key[2])), None
            try:
                return key, fetch_yahoo(key[1]), None
            except Exception as exc:  # noqa: BLE001
                fb = jobs[key].get("fallback")
                if not fb:
                    raise
                print(f"  ~ Yahoo {key[1]} failed ({exc}); using FRED {fb}", file=sys.stderr)
                return key, fetch_fred(fb), f"fallback:FRED {fb}"
        except Exception as exc:  # noqa: BLE001
            print(f"  ! {key}: {exc}", file=sys.stderr)
            return key, None, str(exc)

    print(f"Fetching {len(jobs)} series…")
    raw: dict[tuple, Series | None] = {}
    notes: dict[tuple, str | None] = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for key, data, note in pool.map(run, list(jobs)):
            raw[key], notes[key] = data, note

    def raw_for(ind) -> tuple[Series | None, str | None]:
        s = ind["source"]
        if s == "eurostat":
            key = ("eurostat", ind["series"], json.dumps(ind.get("params") or {}, sort_keys=True))
        else:
            key = (s, ind["series"])
        return raw.get(key), notes.get(key)

    # 2. per-indicator monthly series ----------------------------------------
    now = dt.datetime.now(dt.timezone.utc)
    cur_m = midx(now.strftime("%Y-%m-%d"))
    base: dict[str, Monthly] = {}   # pre-transform (scaled) monthly
    disp: dict[str, Monthly] = {}   # displayed (transformed) monthly
    out_inds = []
    spark_from = cur_m - 12 * int(settings.get("sparkline_years", 10))

    for ind in indicators:
        iid = ind["id"]
        rec = {
            "id": iid, "name": ind.get("name", iid), "category": ind.get("category"),
            "units": ind.get("units", ""), "decimals": ind.get("decimals", 2),
            "change": ind.get("change", "abs"), "info": (ind.get("info") or "").strip(),
            "source": ind.get("source"), "series": ind.get("series"), "url": source_url(ind),
            "transform": ind.get("transform", "level"),
        }
        try:
            last_date = None
            if ind["source"] == "derived":
                a, b = disp.get(ind["a"]), disp.get(ind["b"])
                if a is None or b is None:
                    raise RuntimeError(f"needs indicators '{ind['a']}' and '{ind['b']}' (listed earlier, with data)")
                common = sorted(set(a) & set(b))
                if ind.get("op") == "ratio":
                    m = {i: a[i] / b[i] for i in common if b[i]}
                else:
                    m = {i: a[i] - b[i] for i in common}
                m = scale_series(m, ind.get("scale"))
                rec["note"] = None
            else:
                series, note = raw_for(ind)
                if series is None:
                    raise RuntimeError(note or "fetch failed")
                rec["note"] = note
                m = scale_series(to_monthly(series), ind.get("scale"))
                last_date = series[-1][0]
            base[iid] = m
            d = apply_transform(m, ind.get("transform", "level"), ind.get("smooth"))
            if not d:
                raise RuntimeError("no data after transform")
            disp[iid] = d
            last_m = max(d)
            value = d[last_m]
            transform = ind.get("transform", "level")
            if ind["source"] == "derived":
                freq = "M"
            else:
                series, _ = raw_for(ind)
                freq = detect_freq(series)
            plain_daily = freq in ("D", "W") and transform == "level" and not ind.get("smooth")
            if plain_daily and ind["source"] != "derived":
                value = series[-1][1] * (ind.get("scale") or 1)  # true latest observation
            step = 3 if freq == "Q" else 1
            rec.update({
                "value": rnd(value, 6),
                "freq": freq,
                "date": last_date if plain_daily else mstr(last_m),
                "prev_short": rnd(d.get(last_m - step), 6),
                "short_label": "1Q" if freq == "Q" else "1M",
                "prev_12m": rnd(d.get(last_m - 12), 6),
                "spark": [[mstr(i), rnd(d[i], 4)] for i in sorted(d) if i >= spark_from],
            })
        except Exception as exc:  # noqa: BLE001
            rec.update({"value": None, "error": str(exc), "spark": []})
            print(f"  ! {iid}: {exc}", file=sys.stderr)
        out_inds.append(rec)

    # 3. cycle score ---------------------------------------------------------
    start = midx(settings.get("history_start", "1990-01") + "-01")
    limit = int(settings.get("ffill_months", 4))
    comp_scores: dict[str, Monthly] = {}
    weights: dict[str, float] = {}
    for ind, rec in zip(indicators, out_inds):
        c = ind.get("cycle")
        if not c or ind["id"] not in base:
            continue
        series = apply_transform(base[ind["id"]], c.get("transform", ind.get("transform", "level")),
                                 c.get("smooth", ind.get("smooth")))
        if not series:
            continue
        sc = {i: score_value(v, float(c["bear"]), float(c["bull"])) for i, v in series.items()}
        comp_scores[ind["id"]] = ffill(sc, start, cur_m, limit)
        weights[ind["id"]] = float(c.get("weight", 1))
        latest_i = max(series)
        rec["cycle"] = {
            "weight": weights[ind["id"]], "bear": c["bear"], "bull": c["bull"],
            "input": rnd(series[latest_i], 4), "input_date": mstr(latest_i),
            "input_transform": c.get("transform", ind.get("transform", "level")),
            "score": rnd(sc[latest_i], 3),
            "stale": cur_m - latest_i > limit,
        }

    total_w = sum(weights.values()) or 1
    raw_comp: Monthly = {}
    for i in range(start, cur_m + 1):
        num = den = 0.0
        for cid, sc in comp_scores.items():
            if i in sc:
                num += weights[cid] * sc[i]
                den += weights[cid]
        if den >= 0.3 * total_w:
            raw_comp[i] = num / den
    smooth_n = int(cyc_cfg.get("smoothing_months", 3))
    comp = apply_transform(raw_comp, "level", smooth_n) if smooth_n > 1 else raw_comp
    mom_n = int(cyc_cfg.get("momentum_months", 6))

    cycle_out = {"info": (cyc_cfg.get("info") or "").strip(), "history": [], "components": []}
    if comp:
        last_i = max(comp)
        score = comp[last_i]
        prev = comp.get(last_i - mom_n)
        momentum = score - prev if prev is not None else 0.0
        if score >= 0:
            phase = "Expansion" if momentum >= 0 else "Late cycle"
        else:
            phase = "Recovery" if momentum >= 0 else "Contraction"
        cur_den = sum(weights[c] for c, sc in comp_scores.items() if last_i in sc)
        comps = []
        for cid, sc in comp_scores.items():
            if last_i in sc:
                rec = next(r for r in out_inds if r["id"] == cid)
                comps.append({
                    "id": cid, "name": rec["name"], "score": rnd(sc[last_i], 3),
                    "weight": weights[cid], "contribution": rnd(weights[cid] * sc[last_i] / cur_den, 4),
                })
        comps.sort(key=lambda c: c["contribution"])
        cycle_out.update({
            "score": rnd(score, 3), "momentum": rnd(momentum, 3), "momentum_months": mom_n,
            "phase": phase, "month": mstr(last_i),
            "history": [[mstr(i), rnd(comp[i], 3)] for i in sorted(comp)],
            "components": comps,
            "coverage": rnd(cur_den / total_w, 3),
        })

    recessions = []
    if rec_id and raw.get(("fred", rec_id)):
        run_start = None
        rm = to_monthly(raw[("fred", rec_id)])
        for i in sorted(rm):
            if i < start:
                continue
            if rm[i] >= 1 and run_start is None:
                run_start = i
            elif rm[i] < 1 and run_start is not None:
                recessions.append([mstr(run_start), mstr(i - 1)])
                run_start = None
        if run_start is not None:
            recessions.append([mstr(run_start), mstr(max(rm))])
    cycle_out["recessions"] = recessions

    # 4. yield curve -----------------------------------------------------------
    curve = {"info": (yc_cfg.get("info") or "").strip(), "tenors": [], "snapshots": []}
    tenors = yc_cfg.get("tenors") or []
    series_by = {t["series"]: raw.get(("fred", t["series"])) for t in tenors}
    latest_dates = [s[-1][0] for s in series_by.values() if s]
    if latest_dates:
        ref = max(latest_dates)
        ref_d = dt.date.fromisoformat(ref)
        targets = [("Today", ref), ("6 months ago", (ref_d - dt.timedelta(days=182)).isoformat()),
                   ("1 year ago", (ref_d - dt.timedelta(days=365)).isoformat())]
        curve["tenors"] = [{"label": t["label"], "years": t["years"]} for t in tenors]
        for label, target in targets:
            vals, date_used = [], None
            for t in tenors:
                s = series_by.get(t["series"])
                hit = nearest_before(s, target) if s else None
                vals.append(rnd(hit[1], 3) if hit else None)
                if hit and (date_used is None or hit[0] > date_used):
                    date_used = hit[0]
            curve["snapshots"].append({"label": label, "date": date_used, "values": vals})

    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "categories": config.get("categories") or [],
        "indicators": out_inds,
        "cycle": cycle_out,
        "yield_curve": curve,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "economy.yml"))
    ap.add_argument("--out", default=str(ROOT / "data" / "economy.json"))
    args = ap.parse_args()
    with open(args.config, encoding="utf-8") as fh:
        config = yaml.safe_load(fh) or {}

    data = build(config)
    ok = [i for i in data["indicators"] if i.get("value") is not None]
    print(f"Indicators with data: {len(ok)}/{len(data['indicators'])}")
    c = data["cycle"]
    if "score" in c:
        print(f"Cycle score {c['score']:+.2f} ({c['phase']}, {c['momentum']:+.2f} over {c['momentum_months']}m), coverage {c['coverage']:.0%}")
    if len(ok) < len(data["indicators"]) / 2:
        print("Too many failures; keeping previous data.", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
