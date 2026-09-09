import { definePlugin, mountConfigurableDataTable } from "@nexus/plugin-sdk";

const messages = {
  "pt-BR": {
    title: "Plugin de exemplo",
    description:
      "Esta tela foi carregada do pacote do plugin, sem fazer parte do build do Core.",
    load: "Carregar itens",
    create: "Criar item de exemplo",
    empty: "Nenhum item encontrado.",
  },
  en: {
    title: "Example plugin",
    description:
      "This screen was loaded from the plugin package and is not part of the Core build.",
    load: "Load items",
    create: "Create example item",
    empty: "No items found.",
  },
} as const;

export default definePlugin({
  mountPage({ container, host }) {
    const text = messages[host.locale];
    container.innerHTML = `
      <main class="plugin-page">
        <header>
          <p class="eyebrow">Nexus Plugin API v${host.apiVersion}</p>
          <h1>${text.title}</h1>
          <p>${text.description}</p>
        </header>
        <button type="button" data-load>${text.load}</button>
        <button type="button" data-create>${text.create}</button>
        <div data-result aria-live="polite"></div>
      </main>`;
    const button = container.querySelector<HTMLButtonElement>("[data-load]")!;
    const createButton =
      container.querySelector<HTMLButtonElement>("[data-create]")!;
    const result = container.querySelector<HTMLElement>("[data-result]")!;
    const controller = new AbortController();
    let table: { dispose(): void } | undefined;
    const load = async () => {
      button.disabled = true;
      try {
        const response = await host.api("/items", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { items?: unknown[] };
        const items = Array.isArray(body.items)
          ? body.items.filter(
              (
                item,
              ): item is { id: string; name: string; createdAt?: string } =>
                Boolean(
                  item &&
                  typeof item === "object" &&
                  "id" in item &&
                  typeof item.id === "string" &&
                  "name" in item &&
                  typeof item.name === "string",
                ),
            )
          : [];
        table?.dispose();
        table = await mountConfigurableDataTable({
          container: result,
          host,
          tableId: "plugin.template.items",
          rows: items,
          columns: [
            {
              key: "name",
              label: host.locale === "en" ? "Name" : "Nome",
              render: (row) => row.name,
              sortValue: (row) => row.name,
              size: 240,
              minSize: 140,
              maxSize: 480,
            },
            {
              key: "id",
              label: "ID",
              render: (row) => row.id,
              sortValue: (row) => row.id,
              size: 260,
              minSize: 140,
              maxSize: 520,
              hideable: false,
            },
            {
              key: "created_at",
              label: host.locale === "en" ? "Created at" : "Criado em",
              render: (row) => row.createdAt ?? "—",
              sortValue: (row) => row.createdAt ?? "",
              size: 180,
              minSize: 120,
              maxSize: 320,
            },
          ],
          onOpen: (row) => host.notify({ message: row.id }),
        });
      } catch (error) {
        if (!controller.signal.aborted)
          host.notify({
            tone: "error",
            message: error instanceof Error ? error.message : "Request failed",
          });
      } finally {
        button.disabled = false;
      }
    };
    const create = async () => {
      createButton.disabled = true;
      try {
        const response = await host.api("/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: text.create }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await load();
      } catch (error) {
        if (!controller.signal.aborted)
          host.notify({
            tone: "error",
            message: error instanceof Error ? error.message : "Request failed",
          });
      } finally {
        createButton.disabled = false;
      }
    };
    button.addEventListener("click", load);
    createButton.addEventListener("click", create);
    return {
      dispose() {
        controller.abort();
        table?.dispose();
        button.removeEventListener("click", load);
        createButton.removeEventListener("click", create);
        container.replaceChildren();
      },
    };
  },
});
