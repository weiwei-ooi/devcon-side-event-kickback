// The site's header, footer and light/dark switch, shared by every page (a plain script, loaded in <head>).
// Each page has <header class="top"> (optionally with a <div class="slot"> of page buttons) and <footer class="site">,
// and calls popChrome() right after the footer, before its own module script runs.
(function () {
  const REPO = (window.POP_CONFIG && window.POP_CONFIG.repo) || "https://github.com/weiwei-ooi/devcon-side-event-kickback";
  const root = document.documentElement;
  const KEY = "pop-theme";
  const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const t0 = stored();
  if (t0 === "light" || t0 === "dark") root.dataset.theme = t0;
  const current = () => root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  const svg = {
    github: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
  };
  window.POP_ICONS = svg;
  window.POP_REPO = REPO;

  window.popChrome = function () {
    const page = location.pathname.split("/").pop() || "index.html";
    const header = document.querySelector("header.top");
    if (header) {
      const slot = header.querySelector(".slot");
      const nav = (href, text, cls = "") => `<a class="nav ${cls}" href="${href}"${page === href ? ' aria-current="page"' : ""}>${text}</a>`;
      header.innerHTML = `<div class="bar">
        <a class="brand" href="./" aria-label="Proof of Presence, powered by Kleros: home"><span class="logo" role="img" aria-label="Kleros"></span><span class="sep"></span><span class="name">Proof of Presence</span></a>
        <nav aria-label="Main">${nav("create.html", "Create event", "hide-s")}${nav("organiser.html", "My events", "hide-s")}
          <a class="icon-btn" href="${REPO}" rel="noopener" title="Code on GitHub" aria-label="Code on GitHub">${svg.github}</a>
          <button type="button" class="icon-btn" id="themeToggle"></button></nav></div>`;
      if (slot) header.querySelector("nav").appendChild(slot);
      const btn = header.querySelector("#themeToggle");
      const paint = () => {
        const dark = current() === "dark";
        btn.innerHTML = dark ? svg.sun : svg.moon;
        btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
        btn.setAttribute("aria-label", btn.title);
      };
      btn.onclick = () => {
        const next = current() === "dark" ? "light" : "dark";
        root.dataset.theme = next;
        try { localStorage.setItem(KEY, next); } catch {}
        paint();
      };
      paint();
    }
    const footer = document.querySelector("footer.site");
    if (footer) {
      footer.innerHTML = `<div class="cols">
        <div class="about"><a href="https://kleros.io" rel="noopener" aria-label="Kleros"><span class="logo"></span></a>
          <p>Proof of Presence is an open protocol for refundable event deposits, built and powered by Kleros, the on-chain dispute resolution protocol. Anyone can use it, fork it or plug it into their own site.</p></div>
        <div><p class="foot-h">Proof of Presence</p>
          <a href="create.html">Create a kickback event</a><a href="organiser.html">My events</a><a href="docs/attendance-policy.md">Juror policy</a><a href="${REPO}" rel="noopener">GitHub</a></div>
        <div><p class="foot-h">Kleros</p>
          <a href="https://kleros.io" rel="noopener">kleros.io</a><a href="https://court.kleros.io" rel="noopener">Kleros Court</a><a href="https://docs.kleros.io" rel="noopener">Docs</a><a href="https://blog.kleros.io" rel="noopener">Blog</a></div>
        <div><p class="foot-h">Follow</p>
          <a href="https://x.com/kleros_io" rel="noopener">X</a><a href="https://t.me/kleros" rel="noopener">Telegram</a><a href="https://www.linkedin.com/company/kleros" rel="noopener">LinkedIn</a><a href="https://www.reddit.com/r/Kleros/" rel="noopener">Reddit</a><a href="https://github.com/kleros" rel="noopener">GitHub</a></div>
        <div class="base"><span>Proof of Presence · Powered by <a href="https://kleros.io" rel="noopener">Kleros</a> · Open source, <a href="${REPO}" rel="noopener">MIT</a></span><span id="netName"></span></div>
      </div>`;
    }
  };
})();
