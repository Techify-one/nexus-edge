import { lazy } from "react";
import { MeetingRecorderSessionProvider } from "./MeetingRecorderSessionProvider.js";

export const meetingRecorderPluginUiRegistry = {
  "meeting_recorder.home": lazy(() => import("./MeetingRecorderHomePage.js")),
  "meeting_recorder.new": lazy(() => import("./MeetingRecorderNewPage.js")),
  "meeting_recorder.detail": lazy(
    () => import("./MeetingRecorderDetailPage.js"),
  ),
  "meeting_recorder.settings": lazy(
    () => import("./MeetingRecorderSettingsPage.js"),
  ),
};

export const meetingRecorderPluginRoutePaths = {
  "meeting_recorder.home": "/app/meeting-recorder",
  "meeting_recorder.new": "/app/meeting-recorder/new",
  "meeting_recorder.detail": "/app/meeting-recorder/:recordingId",
  "meeting_recorder.settings": "/app/meeting-recorder/settings",
};

export const meetingRecorderPersistentSurface = MeetingRecorderSessionProvider;
