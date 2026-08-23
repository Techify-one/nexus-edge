import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ConfigurableDataTable } from "../../../frontend/src/components/ui/configurable-data-table.js";
import {
  Badge,
  Button,
  Card,
  DataValue,
  Input,
  Label,
  MetricCard,
  PageHeader,
  Select,
  SingleLineFilterBar,
  Skeleton,
  ToggleSwitch,
} from "../../../frontend/src/components/ui/index.js";
import { useI18n } from "../../../frontend/src/i18n/index.js";
import { can } from "../../../frontend/src/lib/ability.js";
import { api } from "../../../frontend/src/lib/api/core-client.js";
import type { Ad, AdAccount, AdSet, Campaign, Insight } from "./types.js";

type DatePreset =
  "today" | "yesterday" | "last7" | "last30" | "lastYear" | "all" | "custom";
type DateRange = { since: string; until: string; allTime?: boolean };
const TABLE_PAGE_SIZE = 100;

type InsightRow = Insight & {
  id: string;
  creative?: Ad["creative"];
  status: string;
  effectiveStatus: string;
  cpc: number | null;
  ctr: number | null;
  costPerPurchase: number | null;
};

type UrlFilters = {
  accounts: string[];
  campaigns: string[];
  adsets: string[];
  ads: string[];
  hasAdsets: boolean;
  hasAds: boolean;
  preset: DatePreset;
  since: string;
  until: string;
  hideTestData: boolean | null;
};

const FILTER_STORAGE_KEY = "metaAds.dashboard.filters.v1";
const META_QUERY_POLICY = {
  staleTime: Infinity,
  gcTime: 30 * 60_000,
  retry: false,
  refetchInterval: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
} as const;

const csvParam = (params: URLSearchParams, key: string): string[] =>
  (params.get(key) || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const readUrlFilters = (search = window.location.search): UrlFilters => {
  const params = new URLSearchParams(search);
  const date = params.get("date") || "last_7d";
  const preset: DatePreset =
    date === "today" || date === "yesterday"
      ? date
      : date === "last_30d" || date === "last30"
        ? "last30"
        : date === "last_year" || date === "lastYear"
          ? "lastYear"
          : date === "maximum" || date === "all"
            ? "all"
            : date === "__range" || date === "custom"
              ? "custom"
              : "last7";
  const accounts = csvParam(params, "accounts");
  const campaigns = csvParam(params, "campaigns");
  return {
    accounts: accounts.length
      ? accounts
      : params.get("account")
        ? [params.get("account")!]
        : [],
    campaigns: campaigns.length
      ? campaigns
      : params.get("campaign")
        ? [params.get("campaign")!]
        : [],
    adsets: csvParam(params, "adsets"),
    ads: csvParam(params, "ads"),
    hasAdsets: params.has("adsets"),
    hasAds: params.has("ads"),
    preset,
    since: params.get("from") || daysAgo(6),
    until: params.get("to") || isoDate(new Date()),
    hideTestData:
      params.get("internal") === "1"
        ? true
        : params.get("internal") === "0"
          ? false
          : null,
  };
};

const readInitialFilters = (): UrlFilters => {
  if (window.location.search.length > 1) return readUrlFilters();
  try {
    const stored = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (stored) return readUrlFilters(stored);
  } catch {
    // URL/default filters remain available when browser storage is blocked.
  }
  return readUrlFilters();
};

const urlDatePreset = (preset: DatePreset): string => {
  if (preset === "last7") return "last_7d";
  if (preset === "last30") return "last_30d";
  if (preset === "lastYear") return "last_year";
  if (preset === "all") return "maximum";
  if (preset === "custom") return "__range";
  return preset;
};

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

const isoDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const daysAgo = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return isoDate(date);
};

const rangeFor = (
  preset: DatePreset,
  customSince: string,
  customUntil: string,
): DateRange => {
  const today = isoDate(new Date());
  if (preset === "today") return { since: today, until: today };
  if (preset === "yesterday") {
    const yesterday = daysAgo(1);
    return { since: yesterday, until: yesterday };
  }
  if (preset === "last30") return { since: daysAgo(29), until: today };
  if (preset === "lastYear") return { since: daysAgo(364), until: today };
  if (preset === "all")
    return { since: daysAgo(364), until: today, allTime: true };
  if (preset === "custom")
    return { since: customSince, until: customUntil || customSince };
  return { since: daysAgo(6), until: today };
};

function SelectionPanel<T extends { id: string; name: string }>({
  label,
  items,
  selected,
  onChange,
  disabled,
  secondary,
  searchLabel,
  selectAllLabel,
  clearLabel,
}: {
  label: string;
  items: T[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
  secondary?: (item: T) => ReactNode;
  searchLabel: string;
  selectAllLabel: string;
  clearLabel: string;
}) {
  const [search, setSearch] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeWhenClickingOutside = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (
        details?.open &&
        event.target instanceof Node &&
        !details.contains(event.target)
      )
        details.open = false;
    };
    document.addEventListener("pointerdown", closeWhenClickingOutside);
    return () =>
      document.removeEventListener("pointerdown", closeWhenClickingOutside);
  }, []);
  const visible = items.filter((item) =>
    item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const rendered = visible.slice(0, 200);
  const selectedItems = items.filter((item) => selected.has(item.id));
  return (
    <div className="min-w-0">
      <div className="mb-1 flex h-5 items-center justify-between gap-2">
        <span className="truncate text-[11px] uppercase tracking-wide">
          {label}
        </span>
        <span className="shrink-0 text-[11px] text-slate-500">
          {selected.size}/{items.length}
        </span>
      </div>
      <details ref={detailsRef} className="group relative">
        <summary
          className={`flex min-h-10 list-none items-center gap-2 rounded-xl border bg-white px-3 py-2 text-sm shadow-sm outline-none transition focus:ring-2 focus:ring-indigo-500 [&::-webkit-details-marker]:hidden ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-slate-300"}`}
          aria-disabled={disabled}
          onClick={(event) => {
            if (disabled) event.preventDefault();
          }}
        >
          <span className="min-w-0 flex-1 truncate font-medium text-slate-700">
            {selectedItems.length
              ? selectedItems
                  .slice(0, 2)
                  .map((item) => item.name)
                  .join(", ")
              : "—"}
            {selectedItems.length > 2 ? ` +${selectedItems.length - 2}` : ""}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition group-open:rotate-180" />
        </summary>
        <Card className="absolute left-0 top-full z-50 mt-2 w-[min(420px,calc(100vw-2rem))] p-3 shadow-xl">
          <div className="relative mb-2">
            <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchLabel}
              aria-label={searchLabel}
              className="min-h-10 pl-9"
              disabled={disabled}
            />
          </div>
          <div className="mb-2 flex gap-2">
            <Button
              type="button"
              variant="ghost"
              className="min-h-8 px-2 py-1 text-xs"
              disabled={disabled || visible.length === 0}
              onClick={() =>
                onChange(
                  new Set([...selected, ...visible.map((item) => item.id)]),
                )
              }
            >
              {selectAllLabel}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-8 px-2 py-1 text-xs"
              disabled={disabled || selected.size === 0}
              onClick={() => {
                const visibleIds = new Set(visible.map((item) => item.id));
                onChange(
                  new Set([...selected].filter((id) => !visibleIds.has(id))),
                );
              }}
            >
              {clearLabel}
            </Button>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border p-2">
            {visible.length === 0 ? (
              <p className="p-3 text-center text-xs text-slate-500">—</p>
            ) : (
              rendered.map((item) => (
                <label
                  key={item.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(item.id);
                      else next.delete(item.id);
                      onChange(next);
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate" title={item.name}>
                    {item.name}
                  </span>
                  {secondary?.(item)}
                </label>
              ))
            )}
            {visible.length > rendered.length && (
              <p className="px-2 py-2 text-center text-xs text-slate-500">
                +{visible.length - rendered.length}
              </p>
            )}
          </div>
        </Card>
      </details>
    </div>
  );
}

export default function MetaAdsDashboardPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const client = useQueryClient();
  const initialUrlFiltersRef = useRef<UrlFilters | null>(null);
  if (!initialUrlFiltersRef.current)
    initialUrlFiltersRef.current = readInitialFilters();
  const initialUrlFilters = initialUrlFiltersRef.current;
  const initialAdSetsApplied = useRef(false);
  const initialAdsApplied = useRef(false);
  const [selectedAccounts, setSelectedAccounts] = useState(
    () => new Set(initialUrlFilters.accounts),
  );
  const [selectedCampaigns, setSelectedCampaigns] = useState(
    () => new Set(initialUrlFilters.campaigns),
  );
  const [selectedAdSets, setSelectedAdSets] = useState(
    () => new Set(initialUrlFilters.adsets),
  );
  const [selectedAds, setSelectedAds] = useState(
    () => new Set(initialUrlFilters.ads),
  );
  const [preset, setPreset] = useState<DatePreset>(initialUrlFilters.preset);
  const [customSince, setCustomSince] = useState(initialUrlFilters.since);
  const [customUntil, setCustomUntil] = useState(initialUrlFilters.until);
  const [hideTestData, setHideTestData] = useState(() => {
    if (initialUrlFilters.hideTestData !== null)
      return initialUrlFilters.hideTestData;
    try {
      return window.localStorage.getItem("metaAds.hideTestData") !== "false";
    } catch {
      return true;
    }
  });
  const [creativePreview, setCreativePreview] = useState<{
    url: string;
    name: string;
  } | null>(null);
  const [tablePage, setTablePage] = useState(1);

  useEffect(() => {
    try {
      window.localStorage.setItem("metaAds.hideTestData", String(hideTestData));
    } catch {
      // Filtering remains active for this session when storage is unavailable.
    }
  }, [hideTestData]);

  useEffect(() => {
    const params = new URLSearchParams();
    const setList = (key: string, values: Set<string>) => {
      if (values.size) params.set(key, [...values].sort().join(","));
    };
    setList("accounts", selectedAccounts);
    setList("campaigns", selectedCampaigns);
    if (selectedCampaigns.size) {
      params.set("adsets", [...selectedAdSets].sort().join(","));
      params.set("ads", [...selectedAds].sort().join(","));
    }
    params.set("date", urlDatePreset(preset));
    if (preset === "custom") {
      if (customSince) params.set("from", customSince);
      if (customUntil) params.set("to", customUntil);
    }
    params.set("internal", hideTestData ? "1" : "0");
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, params.toString());
    } catch {
      // The URL remains the source of truth when browser storage is blocked.
    }
    setSearchParams(params, { replace: true });
  }, [
    customSince,
    customUntil,
    hideTestData,
    preset,
    selectedAccounts,
    selectedAdSets,
    selectedAds,
    selectedCampaigns,
    setSearchParams,
  ]);

  const accounts = useQuery({
    queryKey: ["meta-ads", "accounts"],
    ...META_QUERY_POLICY,
    queryFn: ({ signal }) =>
      api<{ items: AdAccount[] }>("/api/v1/p/meta_ads/accounts", { signal }),
  });
  const enabledAccounts = useMemo(
    () => (accounts.data?.items || []).filter((account) => account.enabled),
    [accounts.data?.items],
  );
  useEffect(() => {
    if (!accounts.isSuccess) return;
    const enabledIds = new Set(
      enabledAccounts.map((account) => account.adAccountId),
    );
    setSelectedAccounts((current) => {
      const valid = new Set([...current].filter((id) => enabledIds.has(id)));
      if (valid.size) return valid.size === current.size ? current : valid;
      return enabledAccounts[0]
        ? new Set([enabledAccounts[0].adAccountId])
        : valid;
    });
  }, [accounts.isSuccess, enabledAccounts]);

  const accountIds = useMemo(
    () => [...selectedAccounts].sort(),
    [selectedAccounts],
  );
  const accountKey = accountIds.join(",");
  const campaigns = useQuery({
    queryKey: ["meta-ads", "campaigns", accountKey],
    ...META_QUERY_POLICY,
    enabled: accounts.isSuccess && accountIds.length > 0,
    queryFn: ({ signal }) =>
      api<{ items: Campaign[] }>(
        `/api/v1/p/meta_ads/campaigns?accountIds=${encodeURIComponent(accountIds.join(","))}`,
        { signal },
      ),
  });
  const campaignIds = useMemo(
    () => [...selectedCampaigns].sort(),
    [selectedCampaigns],
  );
  const campaignKey = campaignIds.join(",");
  const debouncedCampaignKey = useDebouncedValue(campaignKey, 300);
  const requestedCampaignIds = useMemo(
    () => debouncedCampaignKey.split(",").filter(Boolean),
    [debouncedCampaignKey],
  );
  const adsets = useQuery({
    queryKey: ["meta-ads", "adsets", accountKey, debouncedCampaignKey],
    ...META_QUERY_POLICY,
    enabled: accountIds.length > 0 && requestedCampaignIds.length > 0,
    queryFn: ({ signal }) =>
      api<{ items: AdSet[] }>(
        `/api/v1/p/meta_ads/adsets?accountIds=${encodeURIComponent(accountIds.join(","))}&campaignIds=${encodeURIComponent(requestedCampaignIds.join(","))}`,
        { signal },
      ),
  });
  const ads = useQuery({
    queryKey: ["meta-ads", "ads", accountKey, debouncedCampaignKey],
    ...META_QUERY_POLICY,
    enabled: accountIds.length > 0 && requestedCampaignIds.length > 0,
    queryFn: ({ signal }) =>
      api<{ items: Ad[] }>(
        `/api/v1/p/meta_ads/ads?accountIds=${encodeURIComponent(accountIds.join(","))}&campaignIds=${encodeURIComponent(requestedCampaignIds.join(","))}`,
        { signal },
      ),
  });

  useEffect(() => {
    if (!campaigns.data?.items) return;
    const valid = new Set(campaigns.data.items.map((item) => item.id));
    setSelectedCampaigns((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [campaigns.data?.items]);
  useEffect(() => {
    if (!adsets.data?.items) return;
    const available = new Set(adsets.data.items.map((item) => item.id));
    if (!initialAdSetsApplied.current) {
      initialAdSetsApplied.current = true;
      const restored = initialUrlFilters.adsets.filter((id) =>
        available.has(id),
      );
      if (initialUrlFilters.hasAdsets) {
        setSelectedAdSets(new Set(restored));
        return;
      }
    }
    setSelectedAdSets(available);
  }, [
    adsets.data?.items,
    initialUrlFilters.adsets,
    initialUrlFilters.hasAdsets,
  ]);
  const visibleAds = useMemo(() => {
    const rows = ads.data?.items || [];
    if (!selectedAdSets.size) return rows;
    return rows.filter((ad) => ad.adset_id && selectedAdSets.has(ad.adset_id));
  }, [ads.data?.items, selectedAdSets]);
  useEffect(() => {
    if (!ads.data?.items) return;
    const available = new Set(visibleAds.map((item) => item.id));
    if (!initialAdsApplied.current) {
      initialAdsApplied.current = true;
      const restored = initialUrlFilters.ads.filter((id) => available.has(id));
      if (initialUrlFilters.hasAds) {
        setSelectedAds(new Set(restored));
        return;
      }
    }
    setSelectedAds(available);
  }, [
    ads.data?.items,
    initialUrlFilters.ads,
    initialUrlFilters.hasAds,
    visibleAds,
  ]);
  useEffect(() => {
    if (selectedCampaigns.size) return;
    setSelectedAdSets((current) =>
      current.size ? new Set<string>() : current,
    );
    setSelectedAds((current) => (current.size ? new Set<string>() : current));
  }, [selectedCampaigns.size]);

  const range = rangeFor(preset, customSince, customUntil);
  const adIds = useMemo(() => [...selectedAds].sort(), [selectedAds]);
  const adKey = adIds.join(",");
  const debouncedAdKey = useDebouncedValue(adKey, 300);
  const requestedAdIds = useMemo(
    () => debouncedAdKey.split(",").filter(Boolean),
    [debouncedAdKey],
  );
  const insights = useQuery({
    queryKey: [
      "meta-ads",
      "insights",
      accountKey,
      debouncedAdKey,
      range.since,
      range.until,
      range.allTime ?? false,
      hideTestData,
    ],
    ...META_QUERY_POLICY,
    enabled:
      accountIds.length > 0 &&
      requestedAdIds.length > 0 &&
      Boolean(range.since && range.until),
    queryFn: ({ signal }) =>
      api<{ items: Insight[] }>("/api/v1/p/meta_ads/insights/query", {
        method: "POST",
        signal,
        body: JSON.stringify({
          accountIds,
          adIds: requestedAdIds,
          since: range.since,
          until: range.until,
          allTime: range.allTime ?? false,
          hideTestData,
        }),
      }),
  });

  const insightRows = useMemo<InsightRow[]>(() => {
    const byId = new Map(
      (insights.data?.items || []).map((row) => [row.adId, row]),
    );
    return visibleAds
      .filter((ad) => selectedAds.has(ad.id))
      .map((ad) => {
        const row = byId.get(ad.id) || {
          adId: ad.id,
          adName: ad.name,
          spend: 0,
          clicks: 0,
          impressions: 0,
          purchases: 0,
        };
        return {
          ...row,
          id: ad.id,
          adName: row.adName || ad.name,
          creative: ad.creative,
          status: ad.status,
          effectiveStatus: ad.effective_status,
          cpc: row.clicks ? row.spend / row.clicks : null,
          ctr: row.impressions ? (row.clicks / row.impressions) * 100 : null,
          costPerPurchase: row.purchases ? row.spend / row.purchases : null,
        };
      });
  }, [insights.data?.items, selectedAds, visibleAds]);
  const tablePageCount = Math.max(
    1,
    Math.ceil(insightRows.length / TABLE_PAGE_SIZE),
  );
  const pagedInsightRows = insightRows.slice(
    (tablePage - 1) * TABLE_PAGE_SIZE,
    tablePage * TABLE_PAGE_SIZE,
  );
  useEffect(() => {
    setTablePage(1);
  }, [debouncedAdKey, range.since, range.until]);
  useEffect(() => {
    if (tablePage > tablePageCount) setTablePage(tablePageCount);
  }, [tablePage, tablePageCount]);

  const currency = (value: number | null) =>
    value === null
      ? "—"
      : new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "BRL",
        }).format(value);
  const integer = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  const percent = (value: number | null) =>
    value === null
      ? "—"
      : new Intl.NumberFormat(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(value) + "%";

  const setStatus = useMutation({
    mutationFn: (input: {
      objectId: string;
      objectType: "campaign" | "adset" | "ad";
      status: "ACTIVE" | "PAUSED";
    }) =>
      api("/api/v1/p/meta_ads/status", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (_, input) => {
      toast.success(t("metaAds.statusUpdated"));
      const resource =
        input.objectType === "campaign"
          ? "campaigns"
          : input.objectType === "adset"
            ? "adsets"
            : "ads";
      client.setQueriesData<{
        items: Array<{
          id: string;
          status: string;
          effective_status: string;
        }>;
      }>({ queryKey: ["meta-ads", resource] }, (current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === input.objectId
                  ? {
                      ...item,
                      status: input.status,
                      effective_status: input.status,
                    }
                  : item,
              ),
            }
          : current,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const refresh = () =>
    void client.invalidateQueries({ queryKey: ["meta-ads"] });
  const totalSpend = insightRows.reduce((sum, row) => sum + row.spend, 0);
  const totalClicks = insightRows.reduce((sum, row) => sum + row.clicks, 0);
  const totalImpressions = insightRows.reduce(
    (sum, row) => sum + row.impressions,
    0,
  );
  const dashboardError =
    accounts.error ||
    campaigns.error ||
    adsets.error ||
    ads.error ||
    insights.error;

  if (accounts.isPending) return <Skeleton className="h-96" />;

  return (
    <>
      <PageHeader
        title={t("metaAds.title")}
        description={t("metaAds.description")}
        action={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={hideTestData}
              aria-label={t("metaAds.filters.hideTestDataHint")}
              title={t("metaAds.filters.hideTestDataHint")}
              className="flex min-h-10 items-center gap-3 rounded-xl border bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              onClick={() => setHideTestData((current) => !current)}
            >
              {t("metaAds.filters.hideTestData")}
              <span
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${hideTestData ? "bg-indigo-600" : "bg-slate-300"}`}
                aria-hidden
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${hideTestData ? "translate-x-5" : "translate-x-0"}`}
                />
              </span>
            </button>
            {can("meta_ads.account.read") && (
              <Button
                variant="secondary"
                onClick={() => navigate("/app/meta-ads/accounts")}
              >
                <Settings className="h-4 w-4" />
                {t("metaAds.accounts.manage")}
              </Button>
            )}
            <Button variant="secondary" onClick={refresh}>
              <RefreshCw className="h-4 w-4" />
              {t("metaAds.refresh")}
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                window.open("https://adsmanager.facebook.com", "_blank")
              }
            >
              <ExternalLink className="h-4 w-4" />
              {t("metaAds.openManager")}
            </Button>
          </div>
        }
      />

      {dashboardError && (
        <Card
          className="mb-4 flex flex-wrap items-center justify-between gap-3 border-red-200 bg-red-50 p-4"
          role="alert"
        >
          <div>
            <p className="font-semibold text-red-800">
              {t("metaAds.loadError")}
            </p>
            <p className="mt-1 text-sm text-red-700">
              {dashboardError.message}
            </p>
          </div>
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw className="h-4 w-4" />
            {t("metaAds.tryAgain")}
          </Button>
        </Card>
      )}

      <SingleLineFilterBar className="mb-4">
        <SelectionPanel
          label={t("metaAds.filters.accounts")}
          items={enabledAccounts.map((account) => ({
            id: account.adAccountId,
            name: account.name,
          }))}
          selected={selectedAccounts}
          onChange={(next) => {
            setSelectedAccounts(next);
            setSelectedCampaigns(new Set());
          }}
          searchLabel={t("metaAds.filters.search")}
          selectAllLabel={t("metaAds.filters.selectAll")}
          clearLabel={t("metaAds.filters.clear")}
        />
        <SelectionPanel
          label={t("metaAds.filters.campaigns")}
          items={campaigns.data?.items || []}
          selected={selectedCampaigns}
          onChange={setSelectedCampaigns}
          disabled={!selectedAccounts.size || campaigns.isPending}
          secondary={(campaign) => (
            <span className="flex items-center gap-1">
              <Badge
                tone={
                  campaign.effective_status === "ACTIVE" ? "success" : "neutral"
                }
              >
                {campaign.effective_status}
              </Badge>
              {can("meta_ads.campaign.update") && (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-8 px-2 py-1"
                  disabled={setStatus.isPending}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const next =
                      campaign.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
                    if (
                      next === "PAUSED" &&
                      !confirm(
                        t("metaAds.pauseConfirmCampaign", {
                          name: campaign.name,
                        }),
                      )
                    )
                      return;
                    setStatus.mutate({
                      objectId: campaign.id,
                      objectType: "campaign",
                      status: next,
                    });
                  }}
                  aria-label={
                    campaign.status === "ACTIVE"
                      ? t("metaAds.pause", { name: campaign.name })
                      : t("metaAds.activate", { name: campaign.name })
                  }
                >
                  {campaign.status === "ACTIVE" ? (
                    <Pause className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
            </span>
          )}
          searchLabel={t("metaAds.filters.search")}
          selectAllLabel={t("metaAds.filters.selectAll")}
          clearLabel={t("metaAds.filters.clear")}
        />
        <SelectionPanel
          label={t("metaAds.filters.adsets")}
          items={adsets.data?.items || []}
          selected={selectedAdSets}
          onChange={setSelectedAdSets}
          disabled={!selectedCampaigns.size || adsets.isPending}
          secondary={(adset) =>
            can("meta_ads.adset.update") ? (
              <Button
                type="button"
                variant="ghost"
                className="min-h-8 px-2 py-1"
                disabled={setStatus.isPending}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const next = adset.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
                  if (
                    next === "PAUSED" &&
                    !confirm(
                      t("metaAds.pauseConfirmAdSet", { name: adset.name }),
                    )
                  )
                    return;
                  setStatus.mutate({
                    objectId: adset.id,
                    objectType: "adset",
                    status: next,
                  });
                }}
                aria-label={
                  adset.status === "ACTIVE"
                    ? t("metaAds.pause", { name: adset.name })
                    : t("metaAds.activate", { name: adset.name })
                }
              >
                {adset.status === "ACTIVE" ? (
                  <Pause className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
              </Button>
            ) : undefined
          }
          searchLabel={t("metaAds.filters.search")}
          selectAllLabel={t("metaAds.filters.selectAll")}
          clearLabel={t("metaAds.filters.clear")}
        />
        <SelectionPanel
          label={t("metaAds.filters.ads")}
          items={visibleAds}
          selected={selectedAds}
          onChange={setSelectedAds}
          disabled={!selectedCampaigns.size || ads.isPending}
          searchLabel={t("metaAds.filters.search")}
          selectAllLabel={t("metaAds.filters.selectAll")}
          clearLabel={t("metaAds.filters.clear")}
        />
        <div className="min-w-0">
          <div className="mb-1 flex h-5 items-center">
            <label
              htmlFor="meta-date-preset"
              className="truncate text-[11px] uppercase tracking-wide"
            >
              {t("metaAds.filters.date")}
            </label>
          </div>
          <div className="relative">
            <Select
              id="meta-date-preset"
              value={preset}
              className="min-h-10"
              onChange={(event) => setPreset(event.target.value as DatePreset)}
            >
              <option value="today">{t("metaAds.date.today")}</option>
              <option value="yesterday">{t("metaAds.date.yesterday")}</option>
              <option value="last7">{t("metaAds.date.last7")}</option>
              <option value="last30">{t("metaAds.date.last30")}</option>
              <option value="lastYear">{t("metaAds.date.lastYear")}</option>
              <option value="all">{t("metaAds.date.all")}</option>
              <option value="custom">{t("metaAds.date.custom")}</option>
            </Select>
            {preset === "custom" && (
              <Card className="absolute right-0 top-full z-50 mt-2 grid w-72 gap-3 p-3 shadow-xl">
                <div>
                  <Label htmlFor="meta-date-since">
                    {t("metaAds.date.since")}
                  </Label>
                  <Input
                    id="meta-date-since"
                    type="date"
                    value={customSince}
                    onChange={(event) => setCustomSince(event.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="meta-date-until">
                    {t("metaAds.date.until")}
                  </Label>
                  <Input
                    id="meta-date-until"
                    type="date"
                    value={customUntil}
                    onChange={(event) => setCustomUntil(event.target.value)}
                  />
                </div>
              </Card>
            )}
          </div>
        </div>
      </SingleLineFilterBar>

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [t("metaAds.kpi.ads"), integer(insightRows.length), "accent"],
          [t("metaAds.kpi.spend"), currency(totalSpend), "success"],
          [t("metaAds.kpi.clicks"), integer(totalClicks), "info"],
          [t("metaAds.kpi.impressions"), integer(totalImpressions), "warning"],
        ].map(([label, value, tone]) => (
          <MetricCard
            key={label}
            label={label}
            value={value}
            tone={tone as "accent" | "success" | "info" | "warning"}
          />
        ))}
      </div>

      {insights.isPending && selectedAds.size ? (
        <Skeleton className="h-80" />
      ) : (
        <>
          {tablePageCount > 1 && (
            <div className="mb-3 flex items-center justify-end gap-3 text-sm text-slate-600">
              <span>
                {t("metaAds.pagination.page", {
                  page: tablePage,
                  pages: tablePageCount,
                })}
              </span>
              <Button
                type="button"
                variant="secondary"
                className="min-h-9 px-3 py-1.5"
                disabled={tablePage === 1}
                onClick={() => setTablePage((current) => current - 1)}
              >
                {t("metaAds.pagination.previous")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="min-h-9 px-3 py-1.5"
                disabled={tablePage === tablePageCount}
                onClick={() => setTablePage((current) => current + 1)}
              >
                {t("metaAds.pagination.next")}
              </Button>
            </div>
          )}
          <ConfigurableDataTable
            tableId="plugin.meta_ads.performance"
            rows={pagedInsightRows}
            onOpen={() => undefined}
            emptyTitle={t("metaAds.empty")}
            emptyDescription={t("metaAds.emptyDescription")}
            columns={[
              {
                key: "creative",
                label: t("metaAds.columns.creative"),
                render: (row) => {
                  const thumbnail =
                    row.creative?.thumbnail_url || row.creative?.image_url;
                  const preview =
                    row.creative?.image_url || row.creative?.thumbnail_url;
                  return thumbnail && preview ? (
                    <button
                      type="button"
                      className="rounded-lg outline-none ring-indigo-500 focus:ring-2"
                      aria-label={t("metaAds.columns.previewCreative", {
                        name: row.adName,
                      })}
                      onMouseEnter={() =>
                        setCreativePreview({ url: preview, name: row.adName })
                      }
                      onMouseLeave={() => setCreativePreview(null)}
                      onFocus={() =>
                        setCreativePreview({ url: preview, name: row.adName })
                      }
                      onBlur={() => setCreativePreview(null)}
                    >
                      <img
                        src={thumbnail}
                        alt={t("metaAds.columns.creativeAlt", {
                          name: row.adName,
                        })}
                        className="h-10 w-10 rounded-lg object-cover transition-transform hover:scale-110"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    </button>
                  ) : (
                    "—"
                  );
                },
                sortValue: (row) => row.adName,
                size: 120,
                minSize: 96,
                maxSize: 180,
              },
              {
                key: "ad_name",
                label: t("metaAds.columns.ad"),
                render: (row) => (
                  <span className="font-medium">{row.adName}</span>
                ),
                sortValue: (row) => row.adName,
                size: 280,
                minSize: 180,
                maxSize: 700,
              },
              {
                key: "delivery",
                label: t("metaAds.columns.delivery"),
                render: (row) => (
                  <Badge
                    tone={
                      row.effectiveStatus === "ACTIVE" ? "success" : "neutral"
                    }
                  >
                    {row.effectiveStatus}
                  </Badge>
                ),
                sortValue: (row) => row.effectiveStatus,
                size: 160,
                minSize: 120,
                maxSize: 260,
              },
              {
                key: "spend",
                label: t("metaAds.columns.spend"),
                render: (row) => (
                  <DataValue tone="success">{currency(row.spend)}</DataValue>
                ),
                sortValue: (row) => row.spend,
                size: 160,
                minSize: 120,
                maxSize: 260,
              },
              {
                key: "clicks",
                label: t("metaAds.columns.clicks"),
                render: (row) => <DataValue>{integer(row.clicks)}</DataValue>,
                sortValue: (row) => row.clicks,
                size: 160,
                minSize: 120,
                maxSize: 260,
              },
              {
                key: "cpc",
                label: t("metaAds.columns.cpc"),
                render: (row) => (
                  <DataValue tone="info">{currency(row.cpc)}</DataValue>
                ),
                sortValue: (row) => row.cpc,
                size: 140,
                minSize: 110,
                maxSize: 240,
              },
              {
                key: "impressions",
                label: t("metaAds.columns.impressions"),
                render: (row) => (
                  <DataValue tone="warning">
                    {integer(row.impressions)}
                  </DataValue>
                ),
                sortValue: (row) => row.impressions,
                size: 170,
                minSize: 120,
                maxSize: 280,
              },
              {
                key: "ctr",
                label: t("metaAds.columns.ctr"),
                render: (row) => <DataValue>{percent(row.ctr)}</DataValue>,
                sortValue: (row) => row.ctr,
                size: 140,
                minSize: 110,
                maxSize: 240,
              },
              {
                key: "purchases",
                label: t("metaAds.columns.purchases"),
                render: (row) => (
                  <DataValue tone="success">{integer(row.purchases)}</DataValue>
                ),
                sortValue: (row) => row.purchases,
                size: 170,
                minSize: 120,
                maxSize: 280,
              },
              {
                key: "cost_per_purchase",
                label: t("metaAds.columns.costPerPurchase"),
                render: (row) => (
                  <DataValue tone="warning">
                    {currency(row.costPerPurchase)}
                  </DataValue>
                ),
                sortValue: (row) => row.costPerPurchase,
                size: 200,
                minSize: 140,
                maxSize: 320,
              },
            ]}
            actions={(row) =>
              can("meta_ads.ad.update") ? (
                <ToggleSwitch
                  checked={row.status === "ACTIVE"}
                  disabled={setStatus.isPending}
                  onClick={() => {
                    const next = row.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
                    if (
                      next === "PAUSED" &&
                      !confirm(t("metaAds.pauseConfirm", { name: row.adName }))
                    )
                      return;
                    setStatus.mutate({
                      objectId: row.id,
                      objectType: "ad",
                      status: next,
                    });
                  }}
                  aria-label={
                    row.status === "ACTIVE"
                      ? t("metaAds.pause", { name: row.adName })
                      : t("metaAds.activate", { name: row.adName })
                  }
                  title={
                    row.status === "ACTIVE"
                      ? t("metaAds.pause", { name: row.adName })
                      : t("metaAds.activate", { name: row.adName })
                  }
                />
              ) : undefined
            }
          />
        </>
      )}
      {creativePreview && (
        <div
          className="pointer-events-none fixed inset-0 z-[100] grid place-items-center bg-slate-950/35 p-8 backdrop-blur-[1px]"
          aria-hidden
        >
          <div className="w-[min(560px,88vw)] rounded-2xl border border-white/20 bg-white p-2 shadow-2xl">
            <img
              src={creativePreview.url}
              alt=""
              className="h-[min(520px,75vh)] w-full rounded-xl object-contain"
              referrerPolicy="no-referrer"
            />
            <p className="max-w-xl truncate px-2 py-1 text-center text-sm font-medium text-slate-700">
              {creativePreview.name}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
