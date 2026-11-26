# Portfolio Hub

My personal investing homepage. For now it hosts a **daily news briefing** on
my holdings, macro/central banks and geopolitics. More portfolio tools will be
added over time.

**Live:** https://christianfaccio.github.io/portfolio-hub/

## How it works

```
topics.yml ──► scripts/fetch_news.py ──► data/news.json ──► index.html (renders it)
                (GitHub Action, 2×/day)    data/archive/…
```

1. [`topics.yml`](topics.yml) lists the sections and topics I care about, with
   Google News search queries (English + Italian) and optional RSS feeds.
2. A GitHub Action ([`.github/workflows/news.yml`](.github/workflows/news.yml))
   runs every morning (05:00 UTC) and evening (21:30 UTC), on every push, and on
   demand. It fetches the headlines, commits them to `data/`, and deploys the
   site to GitHub Pages.
3. The page is plain HTML/CSS/JS: no build step, no API keys, no cost.

## Changing what I follow

Edit `topics.yml` (on GitHub: open the file → pencil icon, or use the
**Edit topics** button on the site). Commit, and the page refreshes with the
new topics in ~2 minutes.

- **Add a holding:** add an entry under the `holdings` section (examples are in
  the file's comments).
- **Prefer/hide outlets:** edit `preferred_sources` / `blocked_sources`.
- **Strict mode:** `only_preferred_sources: true` shows only preferred outlets.
- **Languages:** `settings.languages`, or `languages:` per topic.

Search syntax for `query`: `"exact phrase"`, `OR`, `-excluded`, `site:ft.com`.

## Refreshing manually

GitHub → **Actions** → *Update news & deploy* → **Run workflow**.

## Running locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/fetch_news.py
python3 -m http.server 8000   # open http://localhost:8000
```

## Adding a new tool later

1. Create a folder, e.g. `tools/allocation/index.html`, reusing
   `assets/style.css` and `assets/site.js` (set `data-page` and `data-root="../../"`
   on `<body>`).
2. Add it to the `NAV` list in [`assets/site.js`](assets/site.js) so it appears
   in the top bar.

## Notes

- GitHub disables scheduled workflows after 60 days without repository
  activity. The Action's own commits normally keep it active; if it ever stops,
  re-enable it in the Actions tab.
- Past editions are kept for `archive_days` (default 30) and can be browsed with
  the *Edition* selector.
