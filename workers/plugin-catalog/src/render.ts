import type { PublicCatalogPlugin } from "./env.js";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const formatDownloads = (downloads: number): string =>
  new Intl.NumberFormat("pt-BR").format(downloads);

const initials = (name: string): string =>
  name
    .split(/\s+/u)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toLocaleUpperCase("pt-BR");

const pluginCard = (plugin: PublicCatalogPlugin): string => `
  <article class="plugin-card" data-plugin-card>
    <div class="plugin-card__top">
      <div class="plugin-icon" aria-hidden="true">${escapeHtml(initials(plugin.name))}</div>
      <div class="plugin-heading">
        <span class="eyebrow">${escapeHtml(plugin.category)}</span>
        <h2>${escapeHtml(plugin.name)}</h2>
      </div>
      <span class="version">v${escapeHtml(plugin.version)}</span>
    </div>
    <p class="description">${escapeHtml(plugin.description)}</p>
    <dl class="details">
      <div>
        <dt>Compatibilidade</dt>
        <dd>Nexus Edge ${escapeHtml(plugin.coreMinVersion)}+</dd>
      </div>
      <div>
        <dt>Tamanho</dt>
        <dd>${escapeHtml(formatBytes(plugin.archiveSize))}</dd>
      </div>
      <div>
        <dt>Downloads</dt>
        <dd><span data-download-count="${escapeHtml(plugin.id)}">${escapeHtml(formatDownloads(plugin.downloads))}</span></dd>
      </div>
    </dl>
    <div class="actions">
      <a class="download" href="${escapeHtml(plugin.downloadUrl)}" data-download-link="${escapeHtml(plugin.id)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"/></svg>
        Baixar plugin
      </a>
      <a class="source" href="${escapeHtml(plugin.sourceUrl)}" target="_blank" rel="noreferrer">
        Ver código
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>
      </a>
    </div>
  </article>`;

export const renderCatalogPage = (
  plugins: PublicCatalogPlugin[],
  repositoryUrl: string,
  nonce: string,
): string => {
  const totalDownloads = plugins.reduce(
    (total, plugin) => total + plugin.downloads,
    0,
  );
  const cards = plugins.length
    ? `${plugins.map(pluginCard).join("")}<div class="empty filter-empty" data-filter-empty hidden><h2>Nenhum plugin encontrado</h2><p>Tente buscar por outro nome, categoria ou descrição.</p></div>`
    : `<div class="empty"><h2>Nenhum plugin publicado</h2><p>Os plugins aparecerão aqui assim que seguirem o contrato público da pasta <code>plugins/&lt;id&gt;/</code>.</p></div>`;
  const catalogTools = plugins.length
    ? `<div class="hero-tools">
        <label class="search" for="plugin-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
          <span class="sr-only">Buscar plugins</span>
          <input id="plugin-search" type="search" placeholder="Buscar plugins" autocomplete="off" spellcheck="false" aria-controls="plugin-grid">
        </label>
        <div class="stats" aria-label="Resumo do catálogo">
          <span class="stat" aria-live="polite"><strong data-filter-count>${plugins.length}</strong><span data-filter-label>${plugins.length === 1 ? "plugin disponível" : "plugins disponíveis"}</span></span>
          <span class="stat"><strong data-total-downloads>${escapeHtml(formatDownloads(totalDownloads))}</strong>downloads realizados</span>
        </div>
      </div>`
    : `<div class="stats" aria-label="Resumo do catálogo"><span class="stat"><strong>0</strong>plugins disponíveis</span></div>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Plugins oficiais e de código aberto para ampliar o Nexus Edge.">
  <meta name="color-scheme" content="light">
  <title>Plugins para Nexus Edge</title>
  <style nonce="${escapeHtml(nonce)}">
    :root {
      color-scheme: light;
      --ink: #172033;
      --muted: #657086;
      --line: #dfe4ec;
      --surface: rgba(255, 255, 255, .86);
      --accent: #4f46e5;
      --accent-dark: #3730a3;
      --accent-soft: #eef2ff;
      --green: #087f5b;
      --shadow: 0 22px 60px rgba(35, 43, 70, .09);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-width: 320px;
      min-height: 100vh;
      color: var(--ink);
      background:
        radial-gradient(circle at 84% 8%, rgba(199, 210, 254, .7), transparent 28rem),
        radial-gradient(circle at 4% 44%, rgba(204, 251, 241, .62), transparent 25rem),
        #f7f8fc;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    a { color: inherit; }
    a:focus-visible { outline: 3px solid rgba(79, 70, 229, .3); outline-offset: 3px; }
    .shell { width: min(1120px, calc(100% - 40px)); margin: 0 auto; }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 18px 0 14px; }
    .brand { display: inline-flex; align-items: center; gap: 11px; text-decoration: none; font-size: 15px; font-weight: 760; letter-spacing: -.01em; }
    .brand-mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: white; background: linear-gradient(135deg, #6366f1, #3730a3); box-shadow: 0 8px 20px rgba(79, 70, 229, .24); }
    .brand-mark svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .github-link { display: inline-flex; align-items: center; gap: 8px; color: #475569; font-size: 14px; font-weight: 650; text-decoration: none; }
    .github-link:hover { color: var(--accent); }
    .github-link svg { width: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 36px; padding: 26px 0 22px; border-bottom: 1px solid var(--line); }
    .hero-copy { min-width: 0; }
    .hero-tools { display: grid; gap: 8px; justify-items: end; }
    .live { display: inline-flex; align-items: center; gap: 7px; padding: 5px 9px; border: 1px solid rgba(8, 127, 91, .16); border-radius: 999px; color: var(--green); background: rgba(236, 253, 245, .78); font-size: 10px; font-weight: 800; letter-spacing: .045em; text-transform: uppercase; }
    .live::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: #10b981; box-shadow: 0 0 0 4px rgba(16, 185, 129, .12); }
    h1 { margin: 10px 0 7px; font-size: clamp(34px, 4.2vw, 48px); line-height: 1; letter-spacing: -.055em; }
    .hero p { max-width: 720px; margin: 0; color: var(--muted); font-size: 15px; line-height: 1.52; }
    .stats { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .stat { min-width: 116px; padding: 9px 12px; border: 1px solid rgba(203, 213, 225, .74); border-radius: 11px; background: rgba(255,255,255,.62); color: #697386; font-size: 11px; line-height: 1.2; text-align: left; }
    .stat strong { display: block; margin-bottom: 2px; color: var(--ink); font-size: 17px; line-height: 1; }
    .search { position: relative; display: block; width: 320px; max-width: 100%; }
    .search svg { position: absolute; top: 50%; left: 13px; width: 17px; transform: translateY(-50%); fill: none; stroke: #7b8495; stroke-width: 2; stroke-linecap: round; pointer-events: none; }
    .search input { width: 100%; height: 40px; padding: 0 13px 0 40px; border: 1px solid rgba(203, 213, 225, .9); border-radius: 11px; color: var(--ink); background: rgba(255, 255, 255, .82); font: inherit; font-size: 14px; outline: none; box-shadow: 0 5px 16px rgba(35, 43, 70, .05); transition: border-color .16s ease, box-shadow .16s ease, background .16s ease; }
    .search input::placeholder { color: #8a94a7; }
    .search input:focus { border-color: #818cf8; background: #fff; box-shadow: 0 0 0 3px rgba(99, 102, 241, .13), 0 7px 20px rgba(35, 43, 70, .07); }
    [hidden] { display: none !important; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; padding: 20px 0 72px; }
    .plugin-card { display: flex; flex-direction: column; min-height: 360px; padding: 26px; border: 1px solid rgba(210, 216, 228, .9); border-radius: 22px; background: var(--surface); box-shadow: var(--shadow); backdrop-filter: blur(12px); transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease; }
    .plugin-card:hover { transform: translateY(-3px); border-color: #c7d2fe; box-shadow: 0 28px 70px rgba(35, 43, 70, .13); }
    .plugin-card__top { display: flex; align-items: center; gap: 14px; }
    .plugin-icon { display: grid; flex: 0 0 auto; place-items: center; width: 50px; height: 50px; border: 1px solid #d9ddff; border-radius: 15px; color: var(--accent-dark); background: linear-gradient(145deg, #f5f7ff, #e0e7ff); font-size: 14px; font-weight: 850; letter-spacing: -.02em; }
    .plugin-heading { min-width: 0; }
    .eyebrow { display: block; overflow: hidden; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .055em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
    .plugin-heading h2 { margin: 4px 0 0; font-size: 22px; letter-spacing: -.035em; }
    .version { margin-left: auto; align-self: flex-start; padding: 6px 9px; border-radius: 8px; color: var(--accent-dark); background: var(--accent-soft); font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .description { flex: 1; margin: 25px 0 28px; color: #5b667a; font-size: 15px; line-height: 1.72; }
    .details { display: grid; grid-template-columns: 1.3fr .7fr .7fr; gap: 12px; margin: 0 0 24px; padding: 18px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .details div { min-width: 0; }
    .details dt { margin-bottom: 5px; color: #8a94a7; font-size: 10px; font-weight: 750; letter-spacing: .065em; text-transform: uppercase; }
    .details dd { overflow: hidden; margin: 0; color: #30394a; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; align-items: center; gap: 12px; }
    .download, .source { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; border-radius: 11px; font-size: 14px; font-weight: 750; text-decoration: none; transition: background .16s ease, transform .16s ease; }
    .download { flex: 1; color: white; background: var(--accent); box-shadow: 0 8px 20px rgba(79, 70, 229, .2); }
    .download:hover { background: var(--accent-dark); }
    .download:active, .source:active { transform: translateY(1px); }
    .source { padding: 0 4px 0 10px; color: #596276; }
    .source:hover { color: var(--accent); }
    .download svg, .source svg { width: 17px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .empty { grid-column: 1 / -1; padding: 56px 24px; border: 1px dashed #cbd5e1; border-radius: 18px; text-align: center; }
    .empty h2 { margin: 0 0 8px; }
    .empty p { margin: 0; color: var(--muted); }
    code { padding: 2px 5px; border-radius: 5px; background: #eef2ff; font-size: .92em; }
    footer { border-top: 1px solid var(--line); }
    .footer-inner { display: flex; justify-content: space-between; gap: 20px; padding: 27px 0 34px; color: var(--muted); font-size: 13px; }
    .footer-inner a { font-weight: 650; text-decoration: none; }
    .footer-inner a:hover { color: var(--accent); }
    @media (max-width: 760px) {
      .shell { width: min(100% - 28px, 1120px); }
      .hero { grid-template-columns: 1fr; align-items: start; gap: 16px; padding: 20px 0 18px; }
      h1 { font-size: clamp(34px, 10vw, 44px); }
      .hero-tools { width: 100%; justify-items: start; }
      .search { width: 100%; }
      .stats { justify-content: flex-start; }
      .grid { grid-template-columns: 1fr; padding-top: 16px; padding-bottom: 56px; }
      .plugin-card { min-height: 0; padding: 22px; }
    }
    @media (max-width: 470px) {
      .github-link span { display: none; }
      .details { grid-template-columns: 1fr 1fr; }
      .details div:first-child { grid-column: 1 / -1; }
      .actions { align-items: stretch; flex-direction: column; }
      .source { min-height: 38px; }
      .footer-inner { flex-direction: column; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; }
    }
  </style>
</head>
<body>
  <header class="shell topbar">
    <a class="brand" href="/" aria-label="Plugins para Nexus Edge — início">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m8 10 4-2 4 2v4l-4 2-4-2v-4Z"/></svg></span>
      Nexus Edge
    </a>
    <a class="github-link" href="${escapeHtml(repositoryUrl)}" target="_blank" rel="noreferrer">
      <span>Repositório no GitHub</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>
    </a>
  </header>
  <main>
    <section class="shell hero">
      <div class="hero-copy">
        <span class="live">Sincronizado com o GitHub</span>
        <h1>Plugins para Nexus Edge</h1>
        <p>Baixe extensões abertas e verificáveis direto do repositório oficial e instale o ZIP pelo painel Instalador.</p>
      </div>
      ${catalogTools}
    </section>
    <section class="shell" aria-labelledby="catalog-title">
      <h2 class="sr-only" id="catalog-title">Plugins disponíveis</h2>
      <div class="grid" id="plugin-grid">${cards}</div>
    </section>
  </main>
  <footer>
    <div class="shell footer-inner">
      <span>Nexus Edge · infraestrutura modular na borda</span>
      <span>Conteúdo atualizado automaticamente a partir do <a href="${escapeHtml(repositoryUrl)}" target="_blank" rel="noreferrer">GitHub</a>.</span>
    </div>
  </footer>
  <script nonce="${escapeHtml(nonce)}">
    const numberFormatter = new Intl.NumberFormat("pt-BR");
    const normalizeSearch = (value) => value
      .normalize("NFD")
      .replace(/\\p{Diacritic}/gu, "")
      .toLocaleLowerCase("pt-BR");
    const searchInput = document.querySelector("#plugin-search");
    const pluginCards = [...document.querySelectorAll("[data-plugin-card]")];
    const filterEmpty = document.querySelector("[data-filter-empty]");
    const filterCount = document.querySelector("[data-filter-count]");
    const filterLabel = document.querySelector("[data-filter-label]");
    function filterPlugins() {
      const query = normalizeSearch(searchInput?.value.trim() ?? "");
      let visible = 0;
      for (const card of pluginCards) {
        const matches = !query || normalizeSearch(card.textContent ?? "").includes(query);
        card.hidden = !matches;
        if (matches) visible += 1;
      }
      if (filterEmpty) filterEmpty.hidden = visible !== 0;
      if (filterCount) filterCount.textContent = numberFormatter.format(visible);
      if (filterLabel) filterLabel.textContent = query
        ? visible === 1 ? "resultado encontrado" : "resultados encontrados"
        : visible === 1 ? "plugin disponível" : "plugins disponíveis";
    }
    searchInput?.addEventListener("input", filterPlugins);
    async function refreshDownloadCounts() {
      try {
        const response = await fetch("/api/plugins", { cache: "no-store", headers: { Accept: "application/json" } });
        if (!response.ok) return;
        const payload = await response.json();
        let total = 0;
        for (const plugin of payload.plugins ?? []) {
          total += plugin.downloads;
          const element = document.querySelector('[data-download-count="' + CSS.escape(plugin.id) + '"]');
          if (element) element.textContent = numberFormatter.format(plugin.downloads);
        }
        const totalElement = document.querySelector("[data-total-downloads]");
        if (totalElement) totalElement.textContent = numberFormatter.format(total);
      } catch { /* The rendered values remain available without JavaScript. */ }
    }
    for (const link of document.querySelectorAll("[data-download-link]")) {
      link.addEventListener("click", () => setTimeout(refreshDownloadCounts, 1500));
    }
    setInterval(refreshDownloadCounts, 30000);
  </script>
</body>
</html>`;
};
