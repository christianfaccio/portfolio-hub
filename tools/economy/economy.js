// Economy dashboard: renders data/economy.json (built by scripts/fetch_economy.py).
(function () {
  const ROOT = document.body.dataset.root || "./";
  const SVGNS = "http://www.w3.org/2000/svg";
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ---------- theme & links (shared look with the News page) ----------
  const savedTheme = store.get("ph.theme", "");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("#theme-toggle").addEventListener("click", () => {
    const isDark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = isDark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("ph.theme", next);
    renderAll(); // charts read CSS colors at draw time
  });
  const editUrl = `https://github.com/${window.SITE.repo}/edit/main/economy.yml`;
  $("#edit-config").href = editUrl;

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null) n.append(c);
    return n;
  }
  function s(tag, attrs = {}, ...children) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    for (const c of children.flat()) if (c != null) n.append(c);
    return n;
  }
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const midx = (m) => +m.slice(0, 4) * 12 + (+m.slice(5, 7) - 1);
  const monthLabel = (m) => new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1)
    .toLocaleDateString("en-GB", { month: "short", year: "numeric" });
  const signed = (x, d = 2) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d);

  function fmtNum(v, dec) {
    return v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function fmtValue(v, ind, withUnits = true) {
    if (v == null) return "–";
    const n = fmtNum(v, ind.decimals);
    if (!withUnits || !ind.units) return n;
    if (ind.units === "$") return "$" + n;
    if (ind.units === "%") return n + "%";
    return n + " " + ind.units;
  }
  function fmtChange(ind, prev) {
    if (prev == null || ind.value == null) return "–";
    if (ind.change === "pct") {
      if (!prev) return "–";
      return signed((ind.value / prev - 1) * 100, 1) + "%";
    }
    const unit = ind.units === "%" ? " pp" : ind.units && ind.units !== "$" ? " " + ind.units : "";
    return signed(ind.value - prev, ind.decimals) + unit;
  }

  // Diverging color for a score in [-1, 1]: bear ← mid → bull (interpolated in RGB).
  function hex2rgb(h) { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function divColor(x) {
    const mid = hex2rgb(css("--mid")), pole = hex2rgb(css(x >= 0 ? "--bull" : "--bear"));
    const t = Math.abs(clamp(x, -1, 1));
    const c = mid.map((m, i) => Math.round(m + (pole[i] - m) * t));
    return `rgb(${c.join(",")})`;
  }

  // ---------- tooltip ----------
  const tip = $("#tooltip");
  function showTip(evt, nodes) {
    tip.replaceChildren(...nodes);
    tip.hidden = false;
    const pad = 14, r = tip.getBoundingClientRect();
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- info popovers ----------
  let openPop = null;
  function closePop() {
    if (!openPop) return;
    openPop.pop.remove();
    openPop.btn.setAttribute("aria-expanded", "false");
    openPop = null;
  }
  document.addEventListener("click", (e) => {
    if (openPop && !openPop.pop.contains(e.target) && e.target !== openPop.btn) closePop();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePop(); hideTip(); } });
  addEventListener("resize", closePop);

  function infoButton(title, text, footNodes) {
    const btn = el("button", { class: "info-btn", type: "button", "aria-label": `About ${title}`, "aria-expanded": "false" }, "i");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openPop && openPop.btn === btn) return closePop();
      closePop();
      const paras = (text || "No description yet. Add an `info:` field in economy.yml.").split(/\n\s*\n/)
        .map((p) => el("p", {}, p.trim()));
      const pop = el("div", { class: "popover", role: "dialog", "aria-label": title },
        el("div", { class: "pop-title" }, title), ...paras,
        footNodes && footNodes.length ? el("div", { class: "pop-foot" }, ...footNodes) : null);
      document.body.append(pop);
      const r = btn.getBoundingClientRect(), pw = pop.offsetWidth;
      let left = r.left + scrollX - 8;
      left = clamp(left, scrollX + 16, scrollX + document.documentElement.clientWidth - pw - 16);
      pop.style.left = left + "px";
      pop.style.top = r.bottom + scrollY + 8 + "px";
      btn.setAttribute("aria-expanded", "true");
      openPop = { btn, pop };
    });
    return btn;
  }

  // ---------- generic line chart ----------
  // opts: { series:[{name,color,points:[[x,y]...]}], xFmt(x), yFmt(y), xTicks:[x], bands:[[x0,x1]],
  //         zero:bool, divergingFill:bool, yDomain:[min,max], compact:bool, xLabel(x) }
  function lineChart(container, opts) {
    container.replaceChildren();
    const W = container.clientWidth || 300, H = container.clientHeight || 200;
    const compact = !!opts.compact;
    const m = compact ? { t: 4, r: 4, b: 4, l: 4 } : { t: 10, r: opts.rightPad ?? 12, b: 24, l: 40 };
    const all = opts.series.flatMap((sr) => sr.points.filter((p) => p[1] != null));
    if (!all.length) return;
    const xs = all.map((p) => p[0]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let [y0, y1] = opts.yDomain || [Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))];
    if (!opts.yDomain) {
      if (opts.zero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
      const padY = (y1 - y0 || 1) * 0.08; y0 -= padY; y1 += padY;
    }
    const X = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
    const Y = (y) => m.t + (1 - (y - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` });

    // recession / highlight bands
    for (const [b0, b1] of opts.bands || []) {
      if (b1 < x0 || b0 > x1) continue;
      const a = X(Math.max(b0, x0)), b = X(Math.min(b1 + 1, x1));
      svg.append(s("rect", { x: a, y: m.t, width: Math.max(2, b - a), height: H - m.t - m.b, fill: css("--rec-band") }));
    }
    // grid + y axis labels
    if (!compact) {
      const g = s("g", { class: "grid" });
      const ticks = niceTicks(y0, y1, 5);
      for (const t of ticks) {
        g.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
        g.append(s("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end" }, opts.yFmt ? opts.yFmt(t) : String(t)));
      }
      for (const t of opts.xTicks || []) {
        if (t < x0 || t > x1) continue;
        g.append(s("text", { x: X(t), y: H - 6, "text-anchor": "middle" }, opts.xLabel ? opts.xLabel(t) : String(t)));
      }
      svg.append(g);
    }
    if (opts.zero && y0 < 0 && y1 > 0) svg.append(s("line", { class: "zero", x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0) }));

    // diverging area fill (single series): above zero = bull, below = bear
    if (opts.divergingFill) {
      const pts = opts.series[0].points.filter((p) => p[1] != null);
      const id = "clip" + Math.random().toString(36).slice(2);
      const area = `M${X(pts[0][0])},${Y(0)} ` + pts.map((p) => `L${X(p[0])},${Y(p[1])}`).join(" ") + ` L${X(pts.at(-1)[0])},${Y(0)} Z`;
      const defs = s("defs", {},
        s("clipPath", { id: id + "a" }, s("rect", { x: 0, y: 0, width: W, height: Y(0) })),
        s("clipPath", { id: id + "b" }, s("rect", { x: 0, y: Y(0), width: W, height: H })));
      svg.append(defs,
        s("path", { d: area, fill: css("--bull"), "fill-opacity": 0.22, "clip-path": `url(#${id}a)` }),
        s("path", { d: area, fill: css("--bear"), "fill-opacity": 0.22, "clip-path": `url(#${id}b)` }));
    }

    // lines
    for (const sr of opts.series) {
      let d = "", pen = false;
      for (const [x, y] of sr.points) {
        if (y == null) { pen = false; continue; }
        d += (pen ? "L" : "M") + X(x).toFixed(1) + "," + Y(y).toFixed(1);
        pen = true;
      }
      svg.append(s("path", { d, fill: "none", stroke: sr.color, "stroke-width": compact ? 1.5 : 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      if (opts.markers) for (const [x, y] of sr.points) if (y != null) svg.append(s("circle", { cx: X(x), cy: Y(y), r: 3, fill: sr.color, class: "dot" }));
      if (opts.directLabels) {
        const last = [...sr.points].reverse().find((p) => p[1] != null);
        if (last) svg.append(s("text", { x: X(last[0]) + 6, y: Y(last[1]) + 4, style: "fill: var(--text); font-weight: 600" }, sr.name));
      }
    }

    // hover layer: crosshair + dots + tooltip
    const cross = s("line", { class: "crosshair", y1: m.t, y2: H - m.b, visibility: "hidden" });
    const dots = opts.series.map((sr) => s("circle", { r: 4, fill: sr.color, class: "dot", visibility: "hidden" }));
    const hit = s("rect", { class: "hit", x: 0, y: 0, width: W, height: H });
    svg.append(cross, ...dots, hit);
    const xsSorted = [...new Set(xs)].sort((a, b) => a - b);
    function onMove(evt) {
      const r = svg.getBoundingClientRect();
      const px = (evt.clientX - r.left) * (W / r.width);
      const target = x0 + ((px - m.l) / (W - m.l - m.r)) * (x1 - x0);
      let best = xsSorted[0];
      for (const x of xsSorted) if (Math.abs(x - target) < Math.abs(best - target)) best = x;
      cross.setAttribute("x1", X(best)); cross.setAttribute("x2", X(best)); cross.setAttribute("visibility", "visible");
      const rows = [];
      opts.series.forEach((sr, i) => {
        const p = sr.points.find((q) => q[0] === best);
        if (p && p[1] != null) {
          dots[i].setAttribute("cx", X(best)); dots[i].setAttribute("cy", Y(p[1])); dots[i].setAttribute("visibility", "visible");
          rows.push(el("div", { class: "tt-row" },
            opts.series.length > 1 ? el("i", { style: `background:${sr.color}` }) : null,
            opts.series.length > 1 ? sr.name + ": " : "", el("b", {}, opts.yFmt ? opts.yFmt(p[1], true) : String(p[1]))));
        } else dots[i].setAttribute("visibility", "hidden");
      });
      showTip(evt, [el("div", { class: "tt-date" }, opts.xFmt ? opts.xFmt(best) : String(best)), ...rows]);
    }
    hit.addEventListener("pointermove", onMove);
    hit.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); hideTip();
    });
    container.append(svg);
  }

  function niceTicks(a, b, n) {
    const span = b - a || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => span / k <= n) || mag * 10;
    const out = [];
    for (let t = Math.ceil(a / step) * step; t <= b + 1e-9; t += step) out.push(+t.toFixed(10));
    return out;
  }

  // ---------- gauge ----------
  function gauge(container, score) {
    container.replaceChildren();
    const W = 300, H = 170, cx = 150, cy
      = 150, R = 120, th = 20;
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Cycle score ${score.toFixed(2)} on a scale from −1 to +1` });
    const ang = (v) => Math.PI * (1 - (v + 1) / 2); // -1 → 180°, +1 → 0°
    const pt = (v, r) => [cx + r * Math.cos(ang(v)), cy - r * Math.sin(ang(v))];
    const N = 40;
    for (let i = 0; i < N; i++) {
      const a = -1 + (2 * i) / N, b = -1 + (2 * (i + 1)) / N;
      const [x1, y1] = pt(a, R), [x2, y2] = pt(b, R), [x3, y3] = pt(b, R - th), [x4, y4] = pt(a, R - th);
      svg.append(s("path", {
        d: `M${x1},${y1} A${R},${R} 0 0 1 ${x2},${y2} L${x3},${y3} A${R - th},${R - th} 0 0 0 ${x4},${y4} Z`,
        fill: divColor((a + b) / 2), stroke: css("--surface"), "stroke-width": 0.6,
      }));
    }
    for (const t of [-1, -0.5, 0, 0.5, 1]) {
      const [a1, b1] = pt(t, R + 3), [a2, b2] = pt(t, R + 9);
      svg.append(s("line", { x1: a1, y1: b1, x2: a2, y2: b2, stroke: css("--axis"), "stroke-width": 1.5 }));
      const [lx, ly] = pt(t, R + 20);
      svg.append(s("text", { x: lx, y: ly + 4, "text-anchor": "middle", style: "font: 11px Inter, sans-serif; fill: var(--muted)" }, t === 0 ? "0" : signed(t, t % 1 ? 1 : 0)));
    }
    const v = clamp(score, -1, 1), [nx, ny] = pt(v, R - th - 10);
    svg.append(
      s("line", { x1: cx, y1: cy, x2: nx, y2: ny, stroke: css("--text"), "stroke-width": 3, "stroke-linecap": "round" }),
      s("circle", { cx, cy, r: 7, fill: css("--text") }),
      s("text", { x: cx - R + th / 2, y: cy + 18, "text-anchor": "middle", style: "font: 600 11px Inter, sans-serif; fill: var(--muted)" }, "Contraction"),
      s("text", { x: cx + R - th / 2, y: cy + 18, "text-anchor": "middle", style: "font: 600 11px Inter, sans-serif; fill: var(--muted)" }, "Expansion"),
    );
    svg.setAttribute("viewBox", `0 0 ${W} ${H + 12}`);
    container.append(svg);
  }

  function divBar(score) {
    const w = Math.abs(clamp(score, -1, 1)) * 50;
    return el("div", { class: "divbar", "aria-hidden": "true" },
      el("span", { class: "fill " + (score >= 0 ? "pos" : "neg"), style: `width:${w}%` }));
  }

  // ---------- state & render ----------
  let DATA = null;
  let cat = store.get("ph.econ.cat", "all");

  function renderCycle() {
    const c = DATA.cycle;
    const slot = document.querySelector('[data-info="cycle"]');
    slot.replaceChildren(infoButton("Business cycle score", c.info, [
      "Inputs, weights and thresholds: ", el("a", { href: editUrl, target: "_blank", rel: "noopener" }, "economy.yml"),
    ]));
    if (c.score == null) { $("#cycle-score").textContent = "n/a"; return; }
    gauge($("#gauge"), c.score);
    $("#cycle-score").textContent = signed(c.score, 2);
    $("#cycle-phase").textContent = c.phase;
    const arrow = c.momentum > 0.02 ? "▲" : c.momentum < -0.02 ? "▼" : "▶";
    $("#cycle-momentum").textContent = `${arrow} ${signed(c.momentum, 2)} over ${c.momentum_months} months · as of ${monthLabel(c.month)}`;
    $("#coverage").textContent = `· ${c.components.length} inputs, ${Math.round(c.coverage * 100)}% of total weight available`;

    const pts = c.history.map(([mm, v]) => [midx(mm), v]);
    const first = pts[0][0], last = pts.at(-1)[0];
    const ticks = [];
    for (let y = Math.ceil(first / 12 / 5) * 5; y * 12 <= last; y += 5) ticks.push(y * 12);
    lineChart($("#cycle-chart"), {
      series: [{ name: "Cycle score", color: css("--text"), points: pts }],
      yDomain: [-1, 1], zero: true, divergingFill: true,
      bands: c.recessions.map(([a, b]) => [midx(a), midx(b)]),
      xTicks: ticks, xLabel: (x) => String(Math.floor(x / 12)),
      xFmt: (x) => {
        const mm = `${Math.floor(x / 12)}-${String((x % 12) + 1).padStart(2, "0")}`;
        const inRec = c.recessions.some(([a, b]) => x >= midx(a) && x <= midx(b));
        return monthLabel(mm) + (inRec ? " · recession" : "");
      },
      yFmt: (y, hover) => (hover ? signed(y, 2) : y === 0 ? "0" : signed(y, 1)),
    });

    const list = $("#components");
    list.replaceChildren(...c.components.slice().reverse().map((x) =>
      el("a", { class: "comp-row", href: `#ind-${x.id}`, title: `Score ${signed(x.score)} × weight ${x.weight}` },
        el("span", { class: "comp-name" }, x.name),
        divBar(x.score),
        el("span", { class: "comp-val" }, signed(x.score, 2)),
        el("span", { class: "comp-w" }, "×" + x.weight))));
  }

  function renderCurve() {
    const yc = DATA.yield_curve;
    document.querySelector('[data-info="yield_curve"]').replaceChildren(infoButton("US Treasury yield curve", yc.info,
      ["Source: FRED daily Treasury constant-maturity yields."]));
    if (!yc.snapshots || !yc.snapshots.length) return;
    const colors = [css("--series-1"), css("--series-2"), css("--series-3")];
    const series = yc.snapshots.map((snap, i) => ({
      name: snap.label, color: colors[i % 3],
      points: snap.values.map((v, j) => [j, v]),
      date: snap.date,
    }));
    $("#yc-legend").replaceChildren(...series.map((sr) =>
      el("span", {}, el("i", { style: `background:${sr.color}` }), `${sr.name}`,
        el("span", { class: "muted small" }, sr.date ? `(${new Date(sr.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })})` : ""))));
    lineChart($("#yc-chart"), {
      series, markers: true, directLabels: innerWidth > 600, rightPad: innerWidth > 600 ? 96 : 12,
      xTicks: yc.tenors.map((_, i) => i), xLabel: (i) => yc.tenors[i].label,
      xFmt: (i) => `${yc.tenors[i].label} maturity`,
      yFmt: (y, hover) => y.toFixed(hover ? 2 : 1) + "%",
    });
  }

  function renderChips() {
    const cats = DATA.categories;
    if (cat !== "all" && cat !== "cycle" && !cats.some((c) => c.id === cat)) cat = "all";
    const chip = (id, label) => el("button", {
      class: "chip", type: "button", role: "tab", "aria-selected": String(cat === id),
      onclick: () => { cat = id; store.set("ph.econ.cat", id); renderChips(); renderIndicators(); },
    }, label);
    $("#cat-chips").replaceChildren(chip("all", "All"), chip("cycle", "Cycle inputs"), ...cats.map((c) => chip(c.id, c.title)));
  }

  function indicatorCard(ind) {
    const foot = [];
    if (ind.cycle) {
      const cy = ind.cycle;
      const tf = cy.input_transform === "yoy" ? " (YoY %)" : cy.input_transform === "level" ? "" : ` (${cy.input_transform})`;
      foot.push(el("div", {}, `Cycle input${tf}: ${cy.input?.toFixed(2)} → score ${signed(cy.score)}. Maps ${cy.bear} → −1 and ${cy.bull} → +1, weight ${cy.weight}.`));
    }
    if (ind.url) foot.push(el("div", {}, "Source: ", el("a", { href: ind.url, target: "_blank", rel: "noopener" }, `${ind.source === "fred" ? "FRED" : ind.source === "yahoo" ? "Yahoo Finance" : "Eurostat"} · ${ind.series}`)));
    else if (ind.source === "derived") foot.push(el("div", {}, "Derived from other indicators on this page."));
    if (ind.note) foot.push(el("div", {}, `Note: ${ind.note}`));

    const head = el("div", { class: "ind-head" }, el("h3", {}, ind.name), infoButton(ind.name, ind.info, foot));
    if (ind.value == null) {
      return el("article", { class: "ind", id: `ind-${ind.id}` }, head,
        el("p", { class: "ind-error" }, "Data unavailable this run."), el("p", { class: "muted small" }, ind.error || ""));
    }
    const unitsInline = ind.units && ind.units !== "$";
    const valueNode = el("div", { class: "ind-value" },
      ind.units === "$" ? "$" : null, fmtNum(ind.value, ind.decimals),
      unitsInline ? el("span", { class: "u" }, ind.units) : null);
    const dateLbl = ind.freq === "Q" ? `Q${Math.floor((+ind.date.slice(5, 7) - 1) / 3) + 1} ${ind.date.slice(0, 4)}`
      : ind.date.length === 7 ? monthLabel(ind.date)
      : new Date(ind.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const meta = el("div", { class: "ind-meta" },
      el("span", {}, dateLbl),
      el("span", {}, `${ind.short_label || "1M"} `, el("b", {}, fmtChange(ind, ind.prev_short))),
      el("span", {}, "1Y ", el("b", {}, fmtChange(ind, ind.prev_12m))));
    const spark = el("div", { class: "chart spark", role: "img", "aria-label": `${ind.name}, last ${DATA.sparkYears || 10} years` });
    const card = el("article", { class: "ind", id: `ind-${ind.id}` }, head, valueNode, meta, spark);
    if (ind.cycle) {
      card.append(el("div", { class: "ind-signal" },
        el("span", {}, "Cycle signal"), divBar(ind.cycle.score),
        el("span", { class: "comp-val" }, signed(ind.cycle.score, 2)),
      ));
      if (ind.cycle.stale) card.querySelector(".ind-head").append(el("span", { class: "stale", title: "Too old to count in the score" }, "stale"));
    }
    requestAnimationFrame(() => lineChart(spark, {
      compact: true, zero: false,
      series: [{ name: ind.name, color: css("--spark"), points: ind.spark.map(([mm, v]) => [midx(mm), v]) }],
      xFmt: (x) => monthLabel(`${Math.floor(x / 12)}-${String((x % 12) + 1).padStart(2, "0")}`),
      yFmt: (y) => fmtValue(y, ind),
    }));
    return card;
  }

  function renderIndicators() {
    closePop();
    const wrap = $("#indicators");
    const sections = [];
    for (const c of DATA.categories) {
      let inds = DATA.indicators.filter((i) => i.category === c.id);
      if (cat === "cycle") inds = inds.filter((i) => i.cycle);
      else if (cat !== "all" && cat !== c.id) continue;
      if (!inds.length) continue;
      sections.push(el("section", { class: "section" },
        el("div", { class: "section-head" }, el("h2", {}, c.title), c.description ? el("p", {}, c.description) : null),
        el("div", { class: "ind-grid" }, inds.map(indicatorCard))));
    }
    wrap.replaceChildren(...sections);
  }

  function renderAll() {
    if (!DATA) return;
    renderCycle();
    renderCurve();
    renderChips();
    renderIndicators();
  }

  let resizeTimer;
  addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderAll, 150); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);

  fetch(ROOT + "data/economy.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      DATA = d;
      const gen = new Date(d.generated_at);
      $("#updated").textContent = `Updated ${gen.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ${d.indicators.filter((i) => i.value != null).length} indicators`;
      renderAll();
      if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
    })
    .catch((e) => {
      $("#updated").textContent = "No data yet. It appears after the GitHub Action runs.";
      console.error(e);
    });
})();
