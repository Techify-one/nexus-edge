import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Trash2, UserPlus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfigurableDataTable } from "../../../frontend/src/components/ui/configurable-data-table.js";
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  Skeleton,
} from "../../../frontend/src/components/ui/index.js";
import { useI18n } from "../../../frontend/src/i18n/index.js";
import { can } from "../../../frontend/src/lib/ability.js";
import { recorderApi } from "./api-client.js";
import type { TelegramAccessItem } from "./types.js";

type InvitationResult = {
  id: string;
  label: string;
  url: string;
  expiresAt: number;
};

export function TelegramAccessCard({ configured }: { configured: boolean }) {
  const { t, formatDateTime } = useI18n();
  const client = useQueryClient();
  const canRead =
    can("meeting_recorder.telegram_member.read") ||
    can("meeting_recorder.telegram_member.read_all") ||
    can("meeting_recorder.telegram_member.manage_all");
  const canInvite =
    can("meeting_recorder.telegram_member.invite") &&
    can("meeting_recorder.recording.create");
  const canRemove =
    can("meeting_recorder.telegram_member.delete") ||
    can("meeting_recorder.telegram_member.manage_all");
  const [label, setLabel] = useState("");
  const [invitation, setInvitation] = useState<InvitationResult | null>(null);
  const access = useQuery({
    queryKey: ["meeting-recorder", "telegram-access"],
    queryFn: recorderApi.telegramAccess,
    enabled: configured && canRead,
    refetchInterval: configured && canRead ? 15_000 : false,
  });
  const invite = useMutation({
    mutationFn: () => recorderApi.createTelegramInvitation(label.trim()),
    onSuccess: (created) => {
      setInvitation(created);
      setLabel("");
      toast.success(t("meetingRecorder.telegramInvitationCreated"));
      void client.invalidateQueries({
        queryKey: ["meeting-recorder", "telegram-access"],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: (item: TelegramAccessItem) =>
      item.kind === "member"
        ? recorderApi.revokeTelegramMember(item.id)
        : recorderApi.revokeTelegramInvitation(item.id),
    onSuccess: (_result, item) => {
      if (invitation?.id === item.id) setInvitation(null);
      toast.success(
        t(
          item.kind === "member"
            ? "meetingRecorder.telegramMemberRemoved"
            : "meetingRecorder.telegramInvitationRevoked",
        ),
      );
      void client.invalidateQueries({
        queryKey: ["meeting-recorder", "telegram-access"],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const columns = useMemo(
    () => [
      {
        key: "person",
        label: t("meetingRecorder.telegramColumnPerson"),
        render: (row: TelegramAccessItem) => (
          <div>
            <p className="font-semibold">{row.label}</p>
            {row.displayName && row.displayName !== row.label && (
              <p className="truncate text-xs text-slate-500">
                {row.displayName}
              </p>
            )}
          </div>
        ),
        sortValue: (row: TelegramAccessItem) => row.label,
        size: 230,
        minSize: 150,
        maxSize: 520,
      },
      {
        key: "telegram",
        label: t("meetingRecorder.telegramColumnAccount"),
        render: (row: TelegramAccessItem) =>
          row.telegramId ? (
            <div>
              <p>{row.username ? `@${row.username}` : row.telegramId}</p>
              {row.username && (
                <p className="text-xs text-slate-500">{row.telegramId}</p>
              )}
            </div>
          ) : (
            "—"
          ),
        sortValue: (row: TelegramAccessItem) =>
          row.username ?? row.telegramId ?? "",
        size: 220,
        minSize: 150,
        maxSize: 420,
      },
      {
        key: "owner",
        label: t("meetingRecorder.telegramColumnDestination"),
        render: (row: TelegramAccessItem) => row.ownerName,
        sortValue: (row: TelegramAccessItem) => row.ownerName,
        size: 210,
        minSize: 140,
        maxSize: 420,
      },
      {
        key: "status",
        label: t("common.status"),
        render: (row: TelegramAccessItem) => (
          <Badge tone={row.status === "active" ? "success" : "warning"}>
            {t(
              row.status === "active"
                ? "meetingRecorder.telegramMemberActive"
                : "meetingRecorder.telegramInvitationPending",
            )}
          </Badge>
        ),
        sortValue: (row: TelegramAccessItem) => row.status,
        size: 150,
        minSize: 120,
        maxSize: 240,
      },
      {
        key: "activity",
        label: t("meetingRecorder.telegramColumnActivity"),
        render: (row: TelegramAccessItem) => (
          <div>
            <p>
              {formatDateTime(row.lastUsedAt ?? row.linkedAt ?? row.createdAt)}
            </p>
            {row.expiresAt && (
              <p className="text-xs text-slate-500">
                {t("meetingRecorder.telegramInvitationExpires", {
                  date: formatDateTime(row.expiresAt),
                })}
              </p>
            )}
          </div>
        ),
        sortValue: (row: TelegramAccessItem) =>
          row.lastUsedAt ?? row.linkedAt ?? row.createdAt,
        size: 240,
        minSize: 170,
        maxSize: 420,
      },
    ],
    [formatDateTime, t],
  );

  if (!canRead && !canInvite && !canRemove) return null;

  const copyInvitation = async () => {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.url);
      toast.success(t("meetingRecorder.telegramInvitationCopied"));
    } catch {
      toast.error(t("meetingRecorder.telegramInvitationCopyFailed"));
    }
  };

  return (
    <Card className="lg:col-span-2">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-indigo-600" />
          <div>
            <h2 className="font-bold">
              {t("meetingRecorder.telegramAccessTitle")}
            </h2>
            <p className="text-sm text-slate-500">
              {t("meetingRecorder.telegramAccessDescription")}
            </p>
          </div>
        </div>
      </div>
      {!configured ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {t("meetingRecorder.telegramAccessRequiresBot")}
        </div>
      ) : (
        <div className="space-y-5">
          {canInvite && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="meeting-recorder-telegram-invite-label">
                    {t("meetingRecorder.telegramInvitationName")}
                  </Label>
                  <Input
                    id="meeting-recorder-telegram-invite-label"
                    maxLength={100}
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder={t(
                      "meetingRecorder.telegramInvitationNamePlaceholder",
                    )}
                  />
                </div>
                <Button
                  busy={invite.isPending}
                  disabled={!label.trim()}
                  onClick={() => invite.mutate()}
                >
                  <UserPlus className="h-4 w-4" />
                  {t("meetingRecorder.telegramCreateInvitation")}
                </Button>
              </div>
              <p className="mt-2 text-xs text-indigo-900">
                {t("meetingRecorder.telegramInvitationSecurity")}
              </p>
              {invitation && (
                <div className="mt-4 rounded-lg border border-indigo-200 bg-white p-3">
                  <p className="mb-2 text-sm font-semibold">
                    {t("meetingRecorder.telegramInvitationReady", {
                      name: invitation.label,
                    })}
                  </p>
                  <Input
                    readOnly
                    aria-label={t("meetingRecorder.telegramInvitationLink")}
                    value={invitation.url}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={copyInvitation}>
                      <Copy className="h-4 w-4" />
                      {t("meetingRecorder.telegramCopyInvitation")}
                    </Button>
                    <a
                      className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
                      href={invitation.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {t("meetingRecorder.telegramOpenInvitation")}
                    </a>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    {t("meetingRecorder.telegramInvitationOneTime", {
                      date: formatDateTime(invitation.expiresAt),
                    })}
                  </p>
                </div>
              )}
            </div>
          )}
          {canRead &&
            (access.isPending ? (
              <Skeleton className="h-72" />
            ) : (
              <ConfigurableDataTable
                tableId="plugin.meeting_recorder.telegram_members"
                rows={access.data?.items ?? []}
                columns={columns}
                onOpen={() => undefined}
                emptyTitle={t("meetingRecorder.telegramAccessEmpty")}
                emptyDescription={t(
                  "meetingRecorder.telegramAccessEmptyDescription",
                )}
                actions={(item) =>
                  canRemove ? (
                    <Button
                      variant="danger"
                      className="px-2"
                      busy={
                        revoke.isPending && revoke.variables?.id === item.id
                      }
                      aria-label={t(
                        item.kind === "member"
                          ? "meetingRecorder.telegramRemoveMember"
                          : "meetingRecorder.telegramRevokeInvitation",
                        { name: item.label },
                      )}
                      title={t(
                        item.kind === "member"
                          ? "meetingRecorder.telegramRemoveMember"
                          : "meetingRecorder.telegramRevokeInvitation",
                        { name: item.label },
                      )}
                      onClick={() => {
                        const confirmed = window.confirm(
                          t(
                            item.kind === "member"
                              ? "meetingRecorder.telegramRemoveMemberConfirm"
                              : "meetingRecorder.telegramRevokeInvitationConfirm",
                            { name: item.label },
                          ),
                        );
                        if (confirmed) revoke.mutate(item);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null
                }
              />
            ))}
        </div>
      )}
    </Card>
  );
}
