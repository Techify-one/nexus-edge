const baseUrl = process.env.WORKER_URL?.replace(/\/$/u, "");
const adminEmail = process.env.MARKETPLACE_TEST_ADMIN_EMAIL;
const adminPassword = process.env.MARKETPLACE_TEST_ADMIN_PASSWORD;

if (!baseUrl || !adminEmail || !adminPassword) {
  throw new Error(
    "Set WORKER_URL, MARKETPLACE_TEST_ADMIN_EMAIL, and MARKETPLACE_TEST_ADMIN_PASSWORD.",
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

const marketplaces = (await call("/api/v1/plugin-marketplaces")).body.items;
const source = marketplaces.find((item) => item.isDefault);
if (!source) throw new Error("Default marketplace is not configured.");

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
const crmRelease = catalog.find(
  (release) => release.pluginId === "crm" && release.compatible,
);
if (!crmRelease)
  throw new Error("A compatible CRM release was not discovered.");

const installed = (await call("/api/v1/plugins")).body.items;
let crm = installed.find(
  (plugin) =>
    plugin.id === "crm" &&
    plugin.status === "installed" &&
    plugin.installedVersion === crmRelease.version,
);

if (!crm) {
  const downloaded = await call(
    `/api/v1/plugin-catalog/${encodeURIComponent(crmRelease.id)}/package`,
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
      new File([packageBytes], "crm.plugin.zip", { type: "application/zip" }),
    );
    form.set("sourceReleaseId", sourceReleaseId);
    return form;
  };
  let operation = (
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
      throw new Error(`CRM installation failed: ${JSON.stringify(operation)}`);
    }
    if (operation.state === "provisioning") {
      throw new Error(
        "CRM unexpectedly requested external resource provisioning.",
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
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; operation: ${JSON.stringify(diagnostic)}`,
      );
    }
  }
  if (operation.state !== "installed") {
    throw new Error(
      `CRM installation did not finish: ${JSON.stringify(operation)}`,
    );
  }
  crm = (await call("/api/v1/plugins")).body.items.find(
    (plugin) => plugin.id === "crm" && plugin.status === "installed",
  );
}

if (!crm)
  throw new Error("CRM is not installed after the marketplace operation.");
const runtime = (await call("/api/v1/plugin-runtime")).body;
const crmRuntime = runtime.plugins.find((plugin) => plugin.pluginId === "crm");
if (!crmRuntime)
  throw new Error("CRM frontend was not registered in the runtime host.");
const entry = await call(crmRuntime.entryUrl, { expectBinary: true });
if (!entry.body.byteLength)
  throw new Error("CRM frontend entry asset is empty.");
const gatewayHealth = (await call("/api/v1/p/crm/health")).body;
if (!gatewayHealth.ok || gatewayHealth.plugin !== "crm") {
  throw new Error(
    `Unexpected CRM gateway response: ${JSON.stringify(gatewayHealth)}`,
  );
}

console.log(
  JSON.stringify({
    ok: true,
    marketplace: source.repository,
    catalogPlugins: catalog.length,
    catalogRevision: synchronization.revision ?? "not-modified",
    installedPlugin: { id: crm.id, version: crm.installedVersion },
    frontendEntryBytes: entry.body.byteLength,
    gateway: gatewayHealth,
  }),
);
