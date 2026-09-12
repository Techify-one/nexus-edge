const baseUrl = process.env.WORKER_URL?.replace(/\/$/u, "");
const adminEmail = process.env.MARKETPLACE_TEST_ADMIN_EMAIL;
const adminPassword = process.env.MARKETPLACE_TEST_ADMIN_PASSWORD;
const targetPluginId = process.env.MARKETPLACE_TEST_PLUGIN_ID?.trim() || "crm";

if (
  !baseUrl ||
  !adminEmail ||
  !adminPassword ||
  !/^[a-z][a-z0-9_]{1,31}$/u.test(targetPluginId)
) {
  throw new Error(
    "Set valid WORKER_URL, MARKETPLACE_TEST_ADMIN_EMAIL, MARKETPLACE_TEST_ADMIN_PASSWORD, and optional MARKETPLACE_TEST_PLUGIN_ID values.",
  );
}

const cookies = new Map();

const captureCookies = (response) => {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0)
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
};

const cookieHeader = () =>
  [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

const call = async (path, options = {}) => {
  const headers = new Headers(options.headers);
  headers.set(
    "Accept",
    options.expectBinary ? "application/octet-stream" : "application/json",
  );
  if (options.json !== undefined)
    headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET")
    headers.set("Origin", baseUrl);
  if (cookies.size) headers.set("Cookie", cookieHeader());
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body:
      options.json !== undefined ? JSON.stringify(options.json) : options.body,
    redirect: "manual",
  });
  captureCookies(response);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `${options.method ?? "GET"} ${path} returned ${response.status}: ${detail.slice(0, 500)}`,
    );
  }
  if (options.expectBinary)
    return { response, body: await response.arrayBuffer() };
  if (response.status === 204) return { response, body: undefined };
  return { response, body: await response.json() };
};

const setup = (await call("/api/v1/setup/status")).body;
if (setup.state === "open") {
  await call("/api/v1/setup/first-admin", {
    method: "POST",
    json: {
      name: "Nexus Marketplace Test",
      email: adminEmail,
      password: adminPassword,
    },
  });
} else if (setup.state !== "complete") {
  throw new Error(`Unexpected setup state: ${JSON.stringify(setup)}`);
}

await call("/api/auth/sign-in/email", {
  method: "POST",
  json: { email: adminEmail, password: adminPassword },
});

if (process.env.MARKETPLACE_TEST_INSPECT_ONLY === "true") {
  console.log(
    JSON.stringify((await call("/api/v1/plugin-operations")).body, null, 2),
  );
  process.exit(0);
}

const marketplaces = (await call("/api/v1/plugin-marketplaces")).body.items;
let source = marketplaces.find((item) => item.isDefault);
let restoredDefault = false;
if (!source && process.env.MARKETPLACE_TEST_RESTORE_DEFAULT === "true") {
  source = (
    await call("/api/v1/plugin-marketplaces", {
      method: "POST",
      json: {
        name: "Techify",
        repository: "Techify-one/nexus-edge-plugins",
        ref: "main",
        catalogPath: "nexus-marketplace.json",
      },
    })
  ).body;
  restoredDefault = true;
}
if (!source) throw new Error("Default marketplace is not configured.");

if (process.env.MARKETPLACE_TEST_REMOVE_DEFAULT_ONLY === "true") {
  await call(`/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}`, {
    method: "DELETE",
  });
  const afterRemoval = (await call("/api/v1/plugin-marketplaces")).body.items;
  if (afterRemoval.some((item) => item.id === source.id)) {
    throw new Error("Removed marketplace is still listed.");
  }
  const installedAfterRemoval = (await call("/api/v1/plugins")).body.items;
  const crmAfterRemoval = installedAfterRemoval.find(
    (plugin) => plugin.id === "crm" && plugin.status === "installed",
  );
  const runtimeAfterRemoval = (await call("/api/v1/plugin-runtime")).body;
  const crmRuntimeAfterRemoval = runtimeAfterRemoval.plugins.find(
    (plugin) => plugin.pluginId === "crm",
  );
  const gatewayAfterRemoval = (await call("/api/v1/p/crm/health")).body;
  if (!crmAfterRemoval || !crmRuntimeAfterRemoval || !gatewayAfterRemoval.ok) {
    throw new Error("Removing the marketplace affected the installed CRM.");
  }
  console.log(
    JSON.stringify({
      ok: true,
      marketplaceRemoved: source.repository,
      installedPlugin: {
        id: crmAfterRemoval.id,
        version: crmAfterRemoval.installedVersion,
      },
      gateway: gatewayAfterRemoval,
    }),
  );
  process.exit(0);
}

if (process.env.MARKETPLACE_TEST_RECREATE_DEFAULT === "true") {
  await call(`/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}`, {
    method: "DELETE",
  });
  const afterRemoval = (await call("/api/v1/plugin-marketplaces")).body.items;
  if (afterRemoval.some((item) => item.id === source.id)) {
    throw new Error("Removed marketplace is still listed.");
  }
  const restored = (
    await call("/api/v1/plugin-marketplaces", {
      method: "POST",
      json: {
        name: source.name,
        repository: `${source.owner}/${source.repository}`,
        ref: source.sourceRef,
        catalogPath: source.catalogPath,
      },
    })
  ).body;
  if (restored.id !== source.id) {
    throw new Error(
      "The removed default marketplace was not restored in place.",
    );
  }
  source = { ...source, ...restored };
}

let synchronization;
try {
  synchronization = (
    await call(
      `/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}/sync`,
      {
        method: "POST",
      },
    )
  ).body;
} catch (error) {
  const refreshed = (await call("/api/v1/plugin-marketplaces")).body.items.find(
    (item) => item.id === source.id,
  );
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}; marketplace state: ${JSON.stringify(
      {
        trustState: refreshed?.trustState,
        lastErrorCode: refreshed?.lastErrorCode,
        retryAfterAt: refreshed?.retryAfterAt,
      },
    )}`,
  );
}

if (synchronization.requiresTrust) {
  const reauth = (
    await call("/api/v1/auth/reauth", {
      method: "POST",
      json: { password: adminPassword },
    })
  ).body;
  await call(
    `/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}/trust-key`,
    {
      method: "POST",
      headers: { "X-Reauth-Token": reauth.token },
      json: {
        publicKey: synchronization.publicKey,
        keyId: synchronization.keyId,
        publisherId: synchronization.publisherId,
        expectedFingerprint: synchronization.fingerprint,
      },
    },
  );
  synchronization = (
    await call(
      `/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}/sync`,
      {
        method: "POST",
      },
    )
  ).body;
}

const catalog = (await call("/api/v1/plugin-catalog")).body.items;
if (catalog.length < 5) {
  throw new Error(
    `Expected at least five catalog plugins, received ${catalog.length}.`,
  );
}
const targetRelease = catalog.find(
  (release) => release.pluginId === targetPluginId && release.compatible,
);
if (!targetRelease)
  throw new Error(`A compatible ${targetPluginId} release was not discovered.`);

const installed = (await call("/api/v1/plugins")).body.items;
let targetPlugin = installed.find(
  (plugin) =>
    plugin.id === targetPluginId &&
    plugin.status === "installed" &&
    plugin.installedVersion === targetRelease.version,
);

if (!targetPlugin) {
  const downloaded = await call(
    `/api/v1/plugin-catalog/${encodeURIComponent(targetRelease.id)}/package`,
    { method: "POST", expectBinary: true },
  );
  const sourceReleaseId = downloaded.response.headers.get(
    "X-Plugin-Release-Id",
  );
  if (!sourceReleaseId)
    throw new Error("Downloaded package has no release identity.");
  const packageBytes = new Uint8Array(downloaded.body);
  const packageForm = () => {
    const form = new FormData();
    form.set(
      "package",
      new File([packageBytes], `${targetPluginId}.plugin.zip`, {
        type: "application/zip",
      }),
    );
    form.set("sourceReleaseId", sourceReleaseId);
    return form;
  };
  const priorOperation = (
    await call("/api/v1/plugin-operations")
  ).body.items.find(
    (operation) =>
      operation.pluginId === targetPluginId &&
      operation.targetVersion === targetRelease.version &&
      operation.state !== "installed" &&
      operation.state !== "failed",
  );
  let operation = priorOperation
    ? priorOperation
    : (
        await call("/api/v1/plugin-operations", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: packageForm(),
        })
      ).body;
  for (
    let attempt = 0;
    attempt < 30 && operation.state !== "installed";
    attempt += 1
  ) {
    if (operation.state === "failed") {
      throw new Error(
        `${targetPluginId} installation failed: ${JSON.stringify(operation)}`,
      );
    }
    if (operation.state === "provisioning") {
      throw new Error(
        `${targetPluginId} unexpectedly requested external resource provisioning.`,
      );
    }
    if (operation.state === "registering") {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    try {
      operation = (
        await call(
          `/api/v1/plugin-operations/${encodeURIComponent(operation.operationId)}/advance`,
          { method: "POST", body: packageForm() },
        )
      ).body;
    } catch (error) {
      const diagnostic = (
        await call(
          `/api/v1/plugin-operations/${encodeURIComponent(operation.operationId)}`,
        )
      ).body;
      if (
        diagnostic.state !== "failed" &&
        error instanceof Error &&
        error.message.includes('error_code":1102')
      ) {
        operation = diagnostic;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; operation: ${JSON.stringify(diagnostic)}`,
      );
    }
  }
  if (operation.state !== "installed") {
    throw new Error(
      `${targetPluginId} installation did not finish: ${JSON.stringify(operation)}`,
    );
  }
  targetPlugin = (await call("/api/v1/plugins")).body.items.find(
    (plugin) => plugin.id === targetPluginId && plugin.status === "installed",
  );
}

if (!targetPlugin)
  throw new Error(
    `${targetPluginId} is not installed after the marketplace operation.`,
  );
const runtime = (await call("/api/v1/plugin-runtime")).body;
const targetRuntime = runtime.plugins.find(
  (plugin) => plugin.pluginId === targetPluginId,
);
if (!targetRuntime)
  throw new Error(
    `${targetPluginId} frontend was not registered in the runtime host.`,
  );
const entry = await call(targetRuntime.entryUrl, { expectBinary: true });
if (!entry.body.byteLength)
  throw new Error(`${targetPluginId} frontend entry asset is empty.`);
const entrySource = new TextDecoder().decode(entry.body);
if (/\bprocess\.env(?:\.|\[)/u.test(entrySource))
  throw new Error(
    `${targetPluginId} frontend still contains an unresolved Node environment lookup.`,
  );
const gatewayHealth = (
  await call(`/api/v1/p/${encodeURIComponent(targetPluginId)}/health`)
).body;
if (!gatewayHealth.ok || gatewayHealth.plugin !== targetPluginId) {
  throw new Error(
    `Unexpected ${targetPluginId} gateway response: ${JSON.stringify(gatewayHealth)}`,
  );
}

console.log(
  JSON.stringify({
    ok: true,
    marketplace: source.repository,
    restoredDefault,
    catalogPlugins: catalog.length,
    catalogRevision: synchronization.revision ?? "not-modified",
    installedPlugin: {
      id: targetPlugin.id,
      version: targetPlugin.installedVersion,
    },
    frontendEntryBytes: entry.body.byteLength,
    browserSafeFrontend: true,
    gateway: gatewayHealth,
  }),
);
