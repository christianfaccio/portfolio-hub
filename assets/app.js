// News dashboard: loads data/news.json (or an archived edition) and renders it.
(function () {
  const VISIBLE_PER_CARD = 5;
  const $ = (sel) => document.querySelector(sel);

  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  const state = {
    data: null,
    section: store.get("ph.section", "all"),
    lang: store.get("ph.lang", "all"),
    query: "",
    expanded: new Set(),
  };

  // ---------- theme ----------
  const savedTheme = store.get("ph.theme", "");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("#theme-toggle").addEventListener("click", () => {
    const isDark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = isDark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("ph.theme", next);
  });

  // ---------- links to GitHub ----------
  const repo = window.SITE.repo;
  const editUrl = `https://github.com/${repo}/edit/main/topics.yml`;
  $("#edit-topics").href = editUrl;

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

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  function timeAgo(iso) {
    if (!iso) return "";
    const diff = (new Date(iso) - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
    return rtf.format(Math.round(diff / 86400), "day");
  }

  function fmtDate(iso, opts) {
    return new Date(iso).toLocaleString(undefined, opts);
  }

  // ---------- data loading ----------
  async function loadJSON(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function loadEdition(file) {
    const path = file ? `data/archive/${file}` : "data/news.json";
    try {
      state.data = await loadJSON(path);
      state.expanded.clear();
      render();
    } catch (err) {
      $("#content").replaceChildren(
        el("div", { class: "empty" }, "No news yet. The first edition appears after the GitHub Action runs.")
      );
      $("#edition-label").textContent = "No edition";
      console.error(err);
    }
  }

  async function initEditions() {
    const select = $("#edition-select");
    select.append(el("option", { value: "" }, "Latest"));
    try {
      const idx = await loadJSON("data/archive/index.json");
      for (const e of idx) {
        const d = new Date(e.date + "T12:00:00");
        const label = `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · ${e.edition}`;
        select.append(el("option", { value: e.file }, label));
      }
    } catch { /* no archive yet */ }
    select.addEventListener("change", () => loadEdition(select.value));
  }

  // ---------- filters ----------
  function renderChips() {
    const wrap = $("#section-chips");
    const sections = state.data.sections;
    if (state.section !== "all" && !sections.some((s) => s.id === state.section)) state.section = "all";
    const chip = (id, label) =>
      el("button", {
        class: "chip", type: "button", role: "tab",
        "aria-selected": String(state.section === id),
        "data-id": id,
        style: id === "all" ? null : `--sc: var(--s-${id}, var(--s-default))`,
        onclick: () => { state.section = id; store.set("ph.section", id); render(); },
      }, id === "all" ? null : el("span", { class: "dot" }), label);
    wrap.replaceChildren(chip("all", "All"), ...sections.map((s) => chip(s.id, s.title)));
  }

  document.querySelectorAll("#lang-filter button").forEach((b) => {
    b.addEventListener("click", () => {
      state.lang = b.dataset.lang;
      store.set("ph.lang", state.lang);
      render();
    });
  });

  let searchTimer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value.trim().toLowerCase(); render(); }, 120);
  });

  function articleVisible(a) {
    if (state.lang !== "all" && a.lang && a.lang !== state.lang) return false;
    if (state.query) {
      const hay = `${a.title} ${a.summary || ""} ${a.source}`.toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  }

  // ---------- rendering ----------
  function renderArticle(a) {
    return el("li", { class: "article" },
      el("a", { class: "headline", href: a.link, target: "_blank", rel: "noopener noreferrer" }, a.title),
      a.summary ? el("p", { class: "summary" }, a.summary) : null,
      el("div", { class: "meta" },
        el("span", { class: a.preferred ? "src pref" : "src" }, a.source || "Unknown"),
        a.published ? el("span", { title: fmtDate(a.published) }, "· " + timeAgo(a.published)) : null,
        a.lang ? el("span", { class: "lang" }, a.lang) : null,
      ),
    );
  }

  function renderCard(sectionId, topic) {
    const key = `${sectionId}/${topic.name}`;
    const articles = topic.articles.filter(articleVisible);
    if (state.query && !articles.length) return null;
    const open = state.expanded.has(key) || state.query;
    const shown = open ? articles : articles.slice(0, VISIBLE_PER_CARD);
    const hidden = articles.length - shown.length;

    return el("article", { class: "card" },
      el("div", { class: "card-head" },
        topic.tag ? el("span", { class: "tag" }, topic.tag) : null,
        el("h3", {}, topic.name),
        el("span", { class: "count" }, String(articles.length)),
      ),
      articles.length
        ? el("ul", { class: "articles" }, shown.map(renderArticle))
        : el("p", { class: "none" }, "No headlines in this edition."),
      hidden > 0
        ? el("button", { class: "more", type: "button", onclick: () => { state.expanded.add(key); render(); } }, `Show ${hidden} more`)
        : (state.expanded.has(key) && articles.length > VISIBLE_PER_CARD && !state.query
          ? el("button", { class: "more", type: "button", onclick: () => { state.expanded.delete(key); render(); } }, "Show less")
          : null),
    );
  }

  function renderSection(section) {
    const head = el("div", { class: "section-head" },
      el("h2", {}, section.title),
      section.description ? el("p", {}, section.description) : null,
    );
    let body;
    if (!section.topics.length) {
      body = el("div", { class: "empty" },
        "No topics here yet. Add them to the ",
        el("code", {}, section.id),
        " section of ",
        el("a", { href: editUrl, target: "_blank", rel: "noopener" }, "topics.yml"),
        ".",
      );
    } else {
      const cards = section.topics.map((t) => renderCard(section.id, t)).filter(Boolean);
      if (!cards.length) return null;
      body = el("div", { class: "grid" }, cards);
    }
    return el("section", { class: "section", "data-id": section.id }, head, body);
  }

  function renderHeader() {
    const d = state.data;
    const gen = new Date(d.generated_at);
    const edition = d.edition === "morning" ? "Morning edition" : "Evening edition";
    $("#edition-label").textContent = edition;
    $("#edition-date").textContent = fmtDate(d.generated_at, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const total = d.sections.reduce((n, s) => n + s.topics.reduce((m, t) => m + t.articles.length, 0), 0);
    $("#edition-meta").textContent =
      `Updated ${fmtDate(gen, { hour: "2-digit", minute: "2-digit" })} (${timeAgo(d.generated_at)}) · ${total} headlines`;
    document.querySelectorAll("#lang-filter button").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.lang === state.lang)));
  }

  function render() {
    if (!state.data) return;
    renderHeader();
    renderChips();
    const sections = state.data.sections.filter((s) => state.section === "all" || s.id === state.section);
    const nodes = sections.map(renderSection).filter(Boolean);
    $("#content").replaceChildren(
      ...(nodes.length ? nodes : [el("div", { class: "empty" }, "Nothing matches your filters.")])
    );
  }

  initEditions();
  loadEdition("");
})();
