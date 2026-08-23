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
  <article class="plugin-card">
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
    ? plugins.map(pluginCard).join("")
    : `<div class="empty"><h2>Nenhum plugin publicado</h2><p>Os plugins aparecerão aqui assim que seguirem o contrato público da pasta <code>plugins/&lt;id&gt;/</code>.</p></div>`;

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
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 26px 0; }
    .brand { display: inline-flex; align-items: center; gap: 11px; text-decoration: none; font-size: 15px; font-weight: 760; letter-spacing: -.01em; }
    .brand-mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: white; background: linear-gradient(135deg, #6366f1, #3730a3); box-shadow: 0 8px 20px rgba(79, 70, 229, .24); }
    .brand-mark svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .github-link { display: inline-flex; align-items: center; gap: 8px; color: #475569; font-size: 14px; font-weight: 650; text-decoration: none; }
    .github-link:hover { color: var(--accent); }
    .github-link svg { width: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .hero { padding: 82px 0 66px; text-align: center; }
    .live { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border: 1px solid rgba(8, 127, 91, .16); border-radius: 999px; color: var(--green); background: rgba(236, 253, 245, .78); font-size: 12px; font-weight: 760; letter-spacing: .03em; text-transform: uppercase; }
    .live::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: #10b981; box-shadow: 0 0 0 4px rgba(16, 185, 129, .12); }
    h1 { max-width: 790px; margin: 24px auto 18px; font-size: clamp(42px, 7vw, 74px); line-height: .98; letter-spacing: -.06em; }
    .hero p { max-width: 680px; margin: 0 auto; color: var(--muted); font-size: clamp(17px, 2.3vw, 20px); line-height: 1.65; }
    .stats { display: flex; justify-content: center; gap: 10px; margin-top: 30px; flex-wrap: wrap; }
    .stat { padding: 10px 14px; border: 1px solid rgba(203, 213, 225, .74); border-radius: 12px; background: rgba(255,255,255,.62); color: #586174; font-size: 13px; }
    .stat strong { color: var(--ink); }
    .catalog-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
    .catalog-heading span { color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
    .catalog-heading h2 { margin: 7px 0 0; font-size: clamp(25px, 3vw, 32px); letter-spacing: -.035em; }
    .catalog-heading p { max-width: 430px; margin: 0; color: var(--muted); font-size: 14px; line-height: 1.6; text-align: right; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; padding: 28px 0 92px; }
    .plugin-card { display: flex; flex-direction: column; min-height: 390px; padding: 28px; border: 1px solid rgba(210, 216, 228, .9); border-radius: 22px; background: var(--surface); box-shadow: var(--shadow); backdrop-filter: blur(12px); transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease; }
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
      .hero { padding: 58px 0 54px; }
      h1 { font-size: clamp(40px, 14vw, 62px); }
      .catalog-heading { align-items: start; flex-direction: column; }
      .catalog-heading p { text-align: left; }
      .grid { grid-template-columns: 1fr; padding-bottom: 64px; }
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
      <span class="live">Sincronizado com o GitHub</span>
      <h1>Plugins para<br>Nexus Edge</h1>
      <p>Amplie sua instalação com plugins abertos, verificáveis e prontos para instalar. Cada download vem diretamente do repositório público oficial.</p>
      <div class="stats" aria-label="Resumo do catálogo">
        <span class="stat"><strong>${plugins.length}</strong> ${plugins.length === 1 ? "plugin disponível" : "plugins disponíveis"}</span>
        <span class="stat"><strong data-total-downloads>${escapeHtml(formatDownloads(totalDownloads))}</strong> downloads realizados</span>
        <span class="stat">Fonte <strong>main/plugins/*</strong></span>
      </div>
    </section>
    <section class="shell" aria-labelledby="catalog-title">
      <div class="catalog-heading">
        <div><span>Catálogo oficial</span><h2 id="catalog-title">Escolha e instale</h2></div>
        <p>Baixe o arquivo ZIP e selecione-o no painel Instalador da sua instância do Nexus Edge.</p>
      </div>
      <div class="grid">${cards}</div>
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
