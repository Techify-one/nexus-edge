import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { CatalogSource, Env } from "../src/env.js";
import { discoverCatalogSources } from "../src/github.js";

const manifest = {
  id: "crm",
  name: "CRM",
  version: "1.0.0",
  coreMinVersion: "1.0.0",
};
const metadata = {
  category: "Vendas e relacionamento",
  description:
    "Organize leads e mantenha o histórico do relacionamento comercial.",
};
const tree = {
  sha: "a".repeat(40),
  truncated: false,
  tree: [
    { path: "plugins/crm/catalog.json", type: "blob", size: 130, sha: "cat" },
    {
      path: "plugins/crm/manifest.json",
      type: "blob",
      size: 480,
      sha: "manifest",
    },
    {
      path: "plugins/crm/release/crm.plugin.zip",
      type: "blob",
      size: 212_000,
      sha: "archive",
    },
    {
      path: "plugins/template/manifest.json",
      type: "blob",
      size: 400,
      sha: "template",
    },
  ],
};

const githubFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/git/trees/")) return Response.json(tree);
  if (url.includes("/plugins/crm/manifest.json"))
    return Response.json(manifest);
  if (url.includes("/plugins/crm/catalog.json")) return Response.json(metadata);
  if (url.includes("/plugins/crm/release/crm.plugin.zip"))
    return new Response(new Uint8Array([80, 75, 3, 4]), {
      headers: { "Content-Length": "4", "Content-Type": "application/zip" },
    });
  return new Response(null, { status: 404 });
});

class MemoryStatement {
  private bindings: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly counts: Map<string, number>,
    private readonly snapshot: { value?: string },
  ) {}

  bind(...values: unknown[]): this {
    this.bindings = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = this.bindings.flatMap((value) => {
      const id = String(value);
      const downloads = this.counts.get(id);
      return downloads === undefined ? [] : [{ pluginId: id, downloads }];
    }) as T[];
    return { results, success: true, meta: {} } as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    if (
      this.sql.includes("FROM plugin_catalog_source_cache") &&
      this.snapshot.value
    )
      return { payloadJson: this.snapshot.value } as T;
    return null;
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes("INSERT INTO plugin_catalog_downloads")) {
      const id = String(this.bindings[0]);
      this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    }
    if (this.sql.includes("INSERT INTO plugin_catalog_source_cache"))
      this.snapshot.value = String(this.bindings[1]);
    return { results: [], success: true, meta: {} } as D1Result;
  }
}

const environment = (
  counts: Map<string, number>,
  snapshot: { value?: string } = {},
): Env =>
  ({
    DB: {
      prepare: (sql: string) => new MemoryStatement(sql, counts, snapshot),
    } as unknown as D1Database,
    GITHUB_OWNER: "Techify-one",
    GITHUB_REPOSITORY: `nexus-edge-${crypto.randomUUID()}`,
    GITHUB_REF: "main",
    CATALOG_CACHE_SECONDS: "60",
  }) satisfies Env;

const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

afterEach(() => {
  vi.unstubAllGlobals();
  githubFetch.mockClear();
});

describe("GitHub-backed plugin catalog", () => {
  it("discovers only complete, explicitly cataloged plugin directories", async () => {
    const sources = await discoverCatalogSources(
      environment(new Map()),
      githubFetch as typeof fetch,
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: "crm",
      name: "CRM",
      archiveSize: 212_000,
      description: metadata.description,
    });
    expect(sources[0]?.archiveUrl).toContain(
      "/plugins/crm/release/crm.plugin.zip",
    );
  });

  it("renders the public page and counts successful proxied downloads", async () => {
    const counts = new Map<string, number>();
    const env = environment(counts);
    vi.stubGlobal("fetch", githubFetch);

    const page = await worker.fetch(
      new Request("https://catalog.example/"),
      env,
      context,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Plugins para Nexus Edge");

    const download = await worker.fetch(
      new Request("https://catalog.example/download/crm"),
      env,
      context,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain(
      "crm.plugin.zip",
    );
    expect(counts.get("crm")).toBe(1);

    const api = await worker.fetch(
      new Request("https://catalog.example/api/plugins"),
      env,
      context,
    );
    expect(await api.json()).toMatchObject({
      plugins: [{ id: "crm", downloads: 1 }],
    });
  });

  it("does not count a failed upstream download", async () => {
    const counts = new Map<string, number>();
    const env = environment(counts);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/release/crm.plugin.zip"))
          return new Response(null, { status: 404 });
        return githubFetch(input);
      }),
    );

    const response = await worker.fetch(
      new Request("https://catalog.example/download/crm"),
      env,
      context,
    );
    expect(response.status).toBe(502);
    expect(counts.has("crm")).toBe(false);
  });

  it("serves the last D1 snapshot during a temporary GitHub failure", async () => {
    const snapshotSource: CatalogSource = {
      id: "crm",
      name: "CRM",
      version: "1.0.0",
      coreMinVersion: "1.0.0",
      category: metadata.category,
      description: metadata.description,
      archiveSize: 212_000,
      archiveUrl:
        "https://raw.githubusercontent.com/Techify-one/nexus-edge/commit/plugins/crm/release/crm.plugin.zip",
      sourceUrl:
        "https://github.com/Techify-one/nexus-edge/tree/main/plugins/crm",
    };
    const env = environment(new Map(), {
      value: JSON.stringify([snapshotSource]),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    const response = await worker.fetch(
      new Request("https://catalog.example/api/plugins"),
      env,
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      plugins: [{ id: "crm", name: "CRM" }],
    });
  });
});
