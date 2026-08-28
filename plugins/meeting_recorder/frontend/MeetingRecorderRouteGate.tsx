import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "../../../frontend/src/lib/api/core-client.js";
import { Card, Skeleton } from "../../../frontend/src/components/ui/index.js";
import { useI18n } from "../../../frontend/src/i18n/index.js";
import { recorderApi } from "./api-client.js";

export function MeetingRecorderRouteGate({
  children,
}: {
  children: ReactNode;
}) {
  const { t } = useI18n();
  const availability = useQuery({
    queryKey: ["meeting-recorder", "availability"],
    queryFn: recorderApi.health,
    retry: false,
  });
  if (availability.isPending) return <Skeleton className="h-72" />;
  if (availability.isError) {
    const missing =
      availability.error instanceof ApiError &&
      ["PLUGIN_NOT_INSTALLED", "PLUGIN_NOT_FOUND"].includes(
        availability.error.code,
      );
    return (
      <Card className="py-12 text-center">
        <h1 className="text-xl font-bold">
          {t(
            missing
              ? "meetingRecorder.unavailable"
              : "meetingRecorder.loadFailed",
          )}
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          {missing
            ? t("meetingRecorder.unavailableDescription")
            : availability.error.message}
        </p>
      </Card>
    );
  }
  return children;
}
