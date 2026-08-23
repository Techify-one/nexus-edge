import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  GripVertical,
  KeyRound,
  Package,
  ScrollText,
  Search,
  UserRoundCog,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Card, Input, PageHeader, Skeleton } from "../components/ui/index.js";
import { useI18n, type TranslationKey } from "../i18n/index.js";
import { can } from "../lib/ability.js";
import { api } from "../lib/api/core-client.js";
import { resolvePluginRoute } from "../plugins/registry.js";

const coreModules = [
  {
    id: "core.users",
    title: "nav.users",
    description: "dashboard.usersDescription",
    to: "/app/users",
    icon: Users,
    permission: "core.user.read",
  },
  {
    id: "core.groups",
    title: "nav.groups",
    description: "dashboard.groupsDescription",
    to: "/app/groups",
    icon: UserRoundCog,
    permission: "core.group.read",
  },
  {
    id: "core.api-keys",
    title: "nav.apiKeys",
    description: "dashboard.apiKeysDescription",
    to: "/app/settings/api-keys",
    icon: KeyRound,
  },
  {
    id: "core.webhooks",
    title: "nav.webhooks",
    description: "dashboard.webhooksDescription",
    to: "/app/settings/webhooks",
    icon: Webhook,
    permission: "core.webhook.read",
  },
  {
    id: "core.plugins",
    title: "nav.plugins",
    description: "dashboard.pluginsDescription",
    to: "/app/plugins",
    icon: Package,
    permission: "core.plugin.read",
  },
  {
    id: "core.audit",
    title: "nav.audit",
    description: "dashboard.auditDescription",
    to: "/app/audit",
    icon: ScrollText,
    permission: "core.audit.read",
  },
] satisfies Array<{
  id: string;
  title: TranslationKey;
  description: TranslationKey;
  to: string;
  icon: LucideIcon;
  permission?: string;
}>;

type PluginNavigation = {
  pluginId: string;
  name: string;
  menu: Array<{ title: string; routeKey: string }>;
};

type OverviewCard = {
  id: string;
  title: string;
  description: string;
  to: string | undefined;
  icon: LucideIcon;
  searchTerms: string[];
};

type OverviewPreferenceConfig = { version: 1; itemOrder: string[] };
type OverviewPreferenceResponse = {
  config: OverviewPreferenceConfig | null;
  updatedAt: string | number | null;
};

const normalizeSearch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();

export const filterOverviewCards = (cards: OverviewCard[], search: string) => {
  const query = normalizeSearch(search.trim());
  if (!query) return cards;
  return cards.filter((card) =>
    normalizeSearch(
      [card.title, card.description, ...card.searchTerms].join(" "),
    ).includes(query),
  );
};

export const normalizeOverviewOrder = (
  storedOrder: string[] | null | undefined,
  availableIds: string[],
): string[] => {
  const available = new Set(availableIds);
  const retained = (storedOrder ?? []).filter(
    (id, index, items) => available.has(id) && items.indexOf(id) === index,
  );
  return [...retained, ...availableIds.filter((id) => !retained.includes(id))];
};

export const reorderOverviewCardIds = (
  order: string[],
  activeId: string,
  overId: string,
): string[] => {
  const oldIndex = order.indexOf(activeId);
  const newIndex = order.indexOf(overId);
  return oldIndex < 0 || newIndex < 0
    ? order
    : arrayMove(order, oldIndex, newIndex);
};

function SortableOverviewCard({ card }: { card: OverviewCard }) {
  const { t } = useI18n();
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: card.id });
  const Icon = card.icon;
  const content = (
    <div className="flex items-start gap-3 pr-8">
      <div className="rounded-xl bg-indigo-50 p-2 text-indigo-700">
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <div className="min-w-0">
        <h2 className="truncate font-semibold">{card.title}</h2>
        <p className="mt-1 truncate text-sm text-slate-500">
          {card.description}
        </p>
      </div>
    </div>
  );
  const dragLabel = t("dashboard.dragCard", { name: card.title });

  return (
    <div
      ref={setNodeRef}
      className="h-full"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.65 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
    >
      <Card className="relative h-full transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md">
        <button
          type="button"
          className="absolute right-3 top-3 z-10 grid h-8 w-8 cursor-grab touch-none place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 active:cursor-grabbing"
          aria-label={dragLabel}
          title={dragLabel}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        {card.to ? (
          <Link className="block h-full focus:outline-none" to={card.to}>
            {content}
          </Link>
        ) : (
          content
        )}
      </Card>
    </div>
  );
}

export default function DashboardPage() {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [cardOrder, setCardOrder] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const skipNextSave = useRef(false);
  const latestConfig = useRef<OverviewPreferenceConfig>({
    version: 1,
    itemOrder: [],
  });
  const shouldFlush = useRef(false);
  const pluginNavigation = useQuery({
    queryKey: ["me", "plugin-navigation"],
    queryFn: () =>
      api<{ plugins: PluginNavigation[] }>("/api/v1/me/plugin-navigation"),
  });
  const preference = useQuery({
    queryKey: ["me", "overview-preference"],
    queryFn: () =>
      api<OverviewPreferenceResponse>("/api/v1/me/overview-preference"),
  });
  const { isPending: isSaving, mutate: savePreference } = useMutation({
    scope: { id: "overview-preference" },
    mutationFn: (config: OverviewPreferenceConfig) =>
      api<OverviewPreferenceResponse>("/api/v1/me/overview-preference", {
        method: "PUT",
        body: JSON.stringify(config),
      }),
    onSuccess: (_response, config) => {
      if (JSON.stringify(latestConfig.current) === JSON.stringify(config))
        shouldFlush.current = false;
    },
    onError: () => toast.error(t("dashboard.orderSaveFailed")),
  });
  const coreCards: OverviewCard[] = coreModules
    .filter((module) => !module.permission || can(module.permission))
    .map((module) => ({
      id: module.id,
      title: t(module.title),
      description: t(module.description),
      to: module.to,
      icon: module.icon,
      searchTerms: [module.id, module.to],
    }));
  const pluginCards: OverviewCard[] = (
    pluginNavigation.data?.plugins ?? []
  ).map((plugin) => {
    const primaryEntry = plugin.menu.find((entry) =>
      Boolean(resolvePluginRoute(entry.routeKey)),
    );
    const menuSummary = plugin.menu
      .map((entry) => entry.title)
      .filter((title) => title !== plugin.name)
      .join(" · ");
    return {
      id: `plugin.${plugin.pluginId}`,
      title: plugin.name,
      description:
        menuSummary ||
        (primaryEntry
          ? t("dashboard.openPlugin")
          : t("dashboard.pluginWithoutPage")),
      to: primaryEntry ? resolvePluginRoute(primaryEntry.routeKey) : undefined,
      icon: Package,
      searchTerms: [
        plugin.pluginId,
        ...plugin.menu.flatMap((entry) => [entry.title, entry.routeKey]),
      ],
    };
  });
  const cards = [...coreCards, ...pluginCards];
  const availableIds = cards.map((card) => card.id);
  const availableSignature = availableIds.join("|");

  useEffect(() => {
    if (pluginNavigation.isPending || preference.isPending) return;
    if (!hydrated) {
      const normalized = normalizeOverviewOrder(
        preference.data?.config?.itemOrder,
        availableIds,
      );
      skipNextSave.current = true;
      latestConfig.current = { version: 1, itemOrder: normalized };
      setCardOrder(normalized);
      setHydrated(true);
      return;
    }
    setCardOrder((current) => {
      const normalized = normalizeOverviewOrder(current, availableIds);
      return normalized.join("|") === current.join("|") ? current : normalized;
    });
    // `availableSignature` represents every order-relevant card identifier.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    availableSignature,
    hydrated,
    pluginNavigation.isPending,
    preference.data?.config?.itemOrder,
    preference.isPending,
  ]);

  const currentConfig = useMemo<OverviewPreferenceConfig>(
    () => ({ version: 1, itemOrder: cardOrder }),
    [cardOrder],
  );
  latestConfig.current = currentConfig;

  useEffect(() => {
    if (!hydrated) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    shouldFlush.current = true;
    const timer = window.setTimeout(() => savePreference(currentConfig), 300);
    return () => window.clearTimeout(timer);
  }, [currentConfig, hydrated, savePreference]);

  const flushPreference = useCallback(() => {
    if (!hydrated || !shouldFlush.current) return;
    void fetch("/api/v1/me/overview-preference", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(latestConfig.current),
      keepalive: true,
    });
  }, [hydrated]);

  useEffect(() => {
    window.addEventListener("pagehide", flushPreference);
    return () => {
      window.removeEventListener("pagehide", flushPreference);
      flushPreference();
    };
  }, [flushPreference]);

  const cardById = new Map(cards.map((card) => [card.id, card]));
  const orderedCards = normalizeOverviewOrder(cardOrder, availableIds).flatMap(
    (id) => {
      const card = cardById.get(id);
      return card ? [card] : [];
    },
  );
  const visibleCards = filterOverviewCards(orderedCards, search);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setCardOrder((current) =>
      reorderOverviewCardIds(current, String(active.id), String(over.id)),
    );
  };
  const loading =
    !hydrated && (pluginNavigation.isPending || preference.isPending);

  return (
    <>
      <PageHeader
        title={t("dashboard.title")}
        description={t("dashboard.description")}
        action={
          <div className="relative w-full sm:w-80">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
              placeholder={t("dashboard.searchModules")}
              aria-label={t("dashboard.searchModules")}
            />
          </div>
        }
      />
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton className="h-28" key={index} />
          ))}
        </div>
      ) : visibleCards.length ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={visibleCards.map((card) => card.id)}
            strategy={rectSortingStrategy}
          >
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {visibleCards.map((card) => (
                <SortableOverviewCard card={card} key={card.id} />
              ))}
            </div>
          </SortableContext>
          {isSaving && (
            <span className="sr-only" role="status">
              {t("dashboard.savingOrder")}
            </span>
          )}
        </DndContext>
      ) : (
        <Card className="py-8 text-center text-sm text-slate-500">
          {t("dashboard.noResults")}
        </Card>
      )}
    </>
  );
}
