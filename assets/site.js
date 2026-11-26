// Site-wide settings shared by every page of Portfolio Hub.
// To add a new tool later: create a folder (e.g. tools/allocation/index.html)
// and add an entry to NAV below. Paths are relative to the site root.
window.SITE = {
  title: "Portfolio Hub",
  repo: "christianfaccio/portfolio-hub",
  NAV: [
    { id: "news", label: "News", href: "" },
    { id: "economy", label: "Economy", href: "tools/economy/" },
    // { id: "allocation", label: "Allocation", href: "tools/allocation/" },
  ],
};

// Renders the top navigation bar into <nav id="site-nav">.
// Each page sets <body data-page="news"> and <body data-root="./"> (or "../../").
(function renderNav() {
  const nav = document.getElementById("site-nav");
  if (!nav) return;
  const root = document.body.dataset.root || "./";
  const current = document.body.dataset.page;
  for (const item of window.SITE.NAV) {
    const a = document.createElement("a");
    a.href = root + item.href;
    a.textContent = item.label;
    if (item.id === current) a.setAttribute("aria-current", "page");
    nav.appendChild(a);
  }
})();
