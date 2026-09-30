export type CatalogRelease = {
  id: string;
  marketplaceId: string;
  marketplaceName: string;
  pluginId: string;
  publisherId: string;
  publisherName: string;
  version: string;
  description: string;
  changelog: string | null;
  compatible: boolean | number;
  compatibilityReason: string | null;
  packageBytes: number | null;
  installedVersion: string | null;
  installedStatus: string | null;
  updateAvailable: boolean;
  sourceMatches: boolean;
};

export async function downloadCatalogRelease(
  release: CatalogRelease,
  fallbackMessage: string,
): Promise<{ file: File; releaseId: string }> {
  const response = await fetch(
    `/api/v1/plugin-catalog/${encodeURIComponent(release.id)}/package`,
    { method: "POST", credentials: "include" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message || fallbackMessage);
  }
  const blob = await response.blob();
  const releaseId = response.headers.get("X-Plugin-Release-Id");
  if (!releaseId) throw new Error(fallbackMessage);
  return {
    file: new File([blob], `${release.pluginId}.plugin.zip`, {
      type: "application/zip",
    }),
    releaseId,
  };
}
