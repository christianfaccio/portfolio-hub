#!/usr/bin/env python3
"""Fetch news for every topic in topics.yml and write data/news.json.

Sources per topic:
  * Google News RSS search, once per configured language
  * any extra RSS/Atom feeds listed under the topic

Outputs:
  data/news.json                        latest edition (what the page shows)
  data/archive/YYYY-MM-DD-<edition>.json past editions
  data/archive/index.json               list of archived editions

Usage:  python scripts/fetch_news.py [--config topics.yml] [--out data]
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import feedparser
import yaml

ROOT = Path(__file__).resolve().parent.parent
USER_AGENT = "Mozilla/5.0 (compatible; portfolio-hub-news/1.0)"
TIMEOUT = 20

DEFAULT_EDITIONS = {
    "en": {"hl": "en-US", "gl": "US", "ceid": "US:en"},
    "it": {"hl": "it", "gl": "IT", "ceid": "IT:it"},
}


# --------------------------------------------------------------------------- helpers
def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def clean_text(raw: str | None, limit: int = 280) -> str:
    if not raw:
        return ""
    text = re.sub(r"<[^>]+>", " ", raw)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[: limit - 1].rsplit(" ", 1)[0] + "…"
    return text


def norm_title(title: str) -> str:
    t = re.sub(r"[^\w\s]", "", title.lower())
    return re.sub(r"\s+", " ", t).strip()[:90]


def fetch_feed(url: str, retries: int = 3):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return feedparser.parse(resp.read())
        except urllib.error.HTTPError as exc:
            # Google News rate-limits bursts: back off and retry
            if exc.code in (429, 503) and attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            raise


def matches_any(source: str, needles: list[str]) -> bool:
    s = source.lower()
    return any(n in s for n in needles)


def interleave_by_lang(items: list[dict]) -> list[dict]:
    """Round-robin across languages so one language doesn't fill the card."""
    groups: dict[str, list] = {}
    for a in items:
        groups.setdefault(a["lang"] or "feed", []).append(a)
    out, queues = [], list(groups.values())
    while queues:
        for q in list(queues):
            out.append(q.pop(0))
            if not q:
                queues.remove(q)
    return out


def google_news_url(query: str, edition: dict, lookback_hours: int) -> str:
    days = max(1, round(lookback_hours / 24))
    q = f"{query} when:{days}d"
    params = urllib.parse.urlencode(
        {"q": q, "hl": edition["hl"], "gl": edition["gl"], "ceid": edition["ceid"]}
    )
    return f"https://news.google.com/rss/search?{params}"


def entry_time(entry) -> dt.datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        t = entry.get(key)
        if t:
            return dt.datetime(*t[:6], tzinfo=dt.timezone.utc)
    return None


# --------------------------------------------------------------------------- jobs
def build_jobs(config: dict) -> list[dict]:
    """One job per (topic, source). Returns flat list with back-references."""
    settings = config.get("settings", {}) or {}
    editions = {**DEFAULT_EDITIONS, **(settings.get("editions") or {})}
    default_langs = settings.get("languages") or ["en"]
    lookback = int(settings.get("lookback_hours", 36))

    jobs = []
    for s_idx, section in enumerate(config.get("sections") or []):
        for t_idx, topic in enumerate(section.get("topics") or []):
            langs = topic.get("languages") or default_langs
            query = topic.get("query")
            if query:
                for lang in langs:
                    q = query.get(lang) if isinstance(query, dict) else query
                    if not q:
                        continue
                    if lang not in editions:
                        print(f"  ! no edition configured for language '{lang}'", file=sys.stderr)
                        continue
                    jobs.append({
                        "key": (s_idx, t_idx),
                        "kind": "google",
                        "lang": lang,
                        "url": google_news_url(q, editions[lang], lookback),
                    })
            for feed in topic.get("feeds") or []:
                if isinstance(feed, str):
                    feed = {"url": feed}
                jobs.append({
                    "key": (s_idx, t_idx),
                    "kind": "feed",
                    "lang": feed.get("lang", ""),
                    "url": feed["url"],
                    "keywords": [k.lower() for k in feed.get("keywords") or []],
                })
    return jobs


def run_job(job: dict) -> list[dict]:
    try:
        parsed = fetch_feed(job["url"])
    except Exception as exc:  # network errors should never kill the whole run
        print(f"  ! {job['url'][:90]}: {exc}", file=sys.stderr)
        return []

    feed_title = clean_text(parsed.feed.get("title", ""), 80)
    items = []
    for e in parsed.entries:
        title = clean_text(e.get("title", ""), 300)
        link = e.get("link", "")
        if not title or not link:
            continue
        source = ""
        src = e.get("source")
        if src and hasattr(src, "get"):
            source = src.get("title", "")
        if job["kind"] == "google":
            # Google News titles look like "Headline - Source"
            if source and title.endswith(f" - {source}"):
                title = title[: -len(source) - 3]
            summary = ""  # Google's summary just repeats the title
        else:
            source = source or feed_title
            summary = clean_text(e.get("summary") or e.get("description"))
            if job.get("keywords"):
                hay = f"{title} {summary}".lower()
                if not any(k in hay for k in job["keywords"]):
                    continue
        published = entry_time(e)
        items.append({
            "title": title,
            "link": link,
            "source": source,
            "published": published.isoformat() if published else None,
            "lang": job["lang"],
            "summary": summary,
        })
    return items


# --------------------------------------------------------------------------- main
def build_edition(config: dict) -> dict:
    settings = config.get("settings", {}) or {}
    lookback = int(settings.get("lookback_hours", 36))
    default_max = int(settings.get("max_items_per_topic", 10))
    preferred = [x.lower() for x in settings.get("preferred_sources") or []]
    blocked = [x.lower() for x in settings.get("blocked_sources") or []]
    only_preferred = bool(settings.get("only_preferred_sources", False))
    cutoff = now_utc() - dt.timedelta(hours=lookback)

    jobs = build_jobs(config)
    print(f"Fetching {len(jobs)} feeds…")
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(run_job, jobs))

    raw: dict[tuple, list] = {}
    for job, items in zip(jobs, results):
        raw.setdefault(job["key"], []).extend(items)

    sections_out = []
    for s_idx, section in enumerate(config.get("sections") or []):
        seen_in_section: set[str] = set()
        topics_out = []
        for t_idx, topic in enumerate(section.get("topics") or []):
            exclude = [w.lower() for w in topic.get("exclude") or []]
            limit = int(topic.get("max_items", default_max))
            items = raw.get((s_idx, t_idx), [])

            candidates = []
            for a in items:
                if a["published"] and dt.datetime.fromisoformat(a["published"]) < cutoff:
                    continue
                if exclude and any(w in a["title"].lower() for w in exclude):
                    continue
                if blocked and matches_any(a["source"], blocked):
                    continue
                a["preferred"] = bool(preferred) and matches_any(a["source"], preferred)
                if only_preferred and not a["preferred"]:
                    continue
                candidates.append(a)

            # preferred sources first, newest first within each group
            candidates.sort(key=lambda a: (a["preferred"], a["published"] or ""), reverse=True)
            kept = []
            for a in interleave_by_lang(candidates):
                key = norm_title(a["title"])
                if key in seen_in_section:
                    continue
                seen_in_section.add(key)
                kept.append(a)
                if len(kept) >= limit:
                    break
            # show the final card newest-first
            kept.sort(key=lambda a: a["published"] or "", reverse=True)
            topics_out.append({
                "name": topic.get("name", "Untitled"),
                "tag": topic.get("tag", ""),
                "articles": kept,
            })
        sections_out.append({
            "id": section.get("id") or f"section-{s_idx}",
            "title": section.get("title", "Untitled"),
            "description": section.get("description", ""),
            "topics": topics_out,
        })

    generated = now_utc()
    return {
        "generated_at": generated.isoformat(timespec="seconds"),
        "edition": "morning" if generated.hour < 12 else "evening",
        "sections": sections_out,
    }


def write_outputs(edition: dict, out_dir: Path, archive_days: int) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    archive_dir = out_dir / "archive"
    archive_dir.mkdir(exist_ok=True)

    payload = json.dumps(edition, ensure_ascii=False, indent=1)
    (out_dir / "news.json").write_text(payload, encoding="utf-8")

    generated = dt.datetime.fromisoformat(edition["generated_at"])
    name = f"{generated.date().isoformat()}-{edition['edition']}.json"
    (archive_dir / name).write_text(payload, encoding="utf-8")

    # prune + rebuild index
    oldest = (generated - dt.timedelta(days=archive_days)).date()
    entries = []
    for f in sorted(archive_dir.glob("????-??-??-*.json"), reverse=True):
        try:
            day = dt.date.fromisoformat(f.name[:10])
        except ValueError:
            continue
        if day < oldest:
            f.unlink()
            continue
        entries.append({"file": f.name, "date": f.name[:10], "edition": f.stem[11:]})
    (archive_dir / "index.json").write_text(json.dumps(entries, indent=1), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "topics.yml"))
    ap.add_argument("--out", default=str(ROOT / "data"))
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as fh:
        config = yaml.safe_load(fh) or {}

    edition = build_edition(config)
    total = sum(len(t["articles"]) for s in edition["sections"] for t in s["topics"])
    for s in edition["sections"]:
        counts = ", ".join(f"{t['name']}={len(t['articles'])}" for t in s["topics"]) or "no topics"
        print(f"  {s['title']}: {counts}")
    print(f"Total articles: {total}")

    has_topics = any(s["topics"] for s in edition["sections"])
    if has_topics and total == 0:
        print("No articles fetched; keeping previous data.", file=sys.stderr)
        return 1

    archive_days = int((config.get("settings") or {}).get("archive_days", 30))
    write_outputs(edition, Path(args.out), archive_days)
    print(f"Wrote {args.out}/news.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
