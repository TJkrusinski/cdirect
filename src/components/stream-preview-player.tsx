import * as dashjs from "dashjs";
import { MonitorPlay } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  describeDashError,
  describeMediaError,
  stringifyDiagnosticData,
  type PlaybackDiagnostic,
} from "@/lib/stream-diagnostics";

export default function StreamPreviewPlayer({
  manifestUrl,
  label = "Stream preview",
  onDiagnostic,
}: {
  manifestUrl: string | null;
  label?: string;
  onDiagnostic?: (diagnostic: Omit<PlaybackDiagnostic, "id" | "at">) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<dashjs.MediaPlayerClass | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !manifestUrl) {
      playerRef.current?.reset();
      playerRef.current = null;
      return;
    }

    const player = dashjs.MediaPlayer().create();
    setError(null);

    const reportDashError = (event: dashjs.ErrorEvent) => {
      const summary = describeDashError(event);
      setError(summary.message);
      onDiagnostic?.({
        level: "error",
        source: "dash.js",
        message: summary.message,
        detail: summary.detail,
      });
    };
    const reportPlaybackError = (event: dashjs.PlaybackErrorEvent) => {
      const message = describeMediaError(event.error);
      setError(message);
      onDiagnostic?.({
        level: "error",
        source: "video",
        message,
        detail: stringifyDiagnosticData(event.error),
      });
    };
    const reportFragmentAbandoned = (event: dashjs.FragmentLoadingAbandonedEvent) => {
      onDiagnostic?.({
        level: "warning",
        source: "dash.js",
        message: `Abandoned ${event.mediaType ?? "media"} fragment request.`,
        detail: stringifyDiagnosticData(event.request),
      });
    };
    const reportFragmentLoaded = (event: dashjs.FragmentLoadingCompletedEvent) => {
      const request = event.request as unknown as dashjs.HTTPRequest | undefined;
      const status = request?.responsecode;
      if (status && (status < 200 || status >= 400)) {
        onDiagnostic?.({
          level: "error",
          source: "network",
          message: `Segment request returned HTTP ${status}.`,
          detail: request.url ?? undefined,
        });
      }
    };
    const reportBufferEmpty = (event: dashjs.BufferEvent) => {
      onDiagnostic?.({
        level: "warning",
        source: "buffer",
        message: `${event.mediaType ?? "Media"} buffer is empty.`,
      });
    };
    const reportPlaybackStalled = () => {
      onDiagnostic?.({
        level: "warning",
        source: "video",
        message: "Playback stalled while waiting for media data.",
      });
    };
    const reportManifestLoaded = () => {
      onDiagnostic?.({
        level: "info",
        source: "manifest",
        message: "dash.js loaded the selected manifest.",
      });
    };

    player.on(dashjs.MediaPlayer.events.ERROR, reportDashError);
    player.on(dashjs.MediaPlayer.events.PLAYBACK_ERROR, reportPlaybackError);
    player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_ABANDONED, reportFragmentAbandoned);
    player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, reportFragmentLoaded);
    player.on(dashjs.MediaPlayer.events.BUFFER_EMPTY, reportBufferEmpty);
    player.on(dashjs.MediaPlayer.events.PLAYBACK_STALLED, reportPlaybackStalled);
    player.on(dashjs.MediaPlayer.events.MANIFEST_LOADED, reportManifestLoaded);

    try {
      player.initialize(video, manifestUrl, false);
      playerRef.current = player;
      onDiagnostic?.({
        level: "info",
        source: "player",
        message: "Attached preview manifest.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onDiagnostic?.({
        level: "error",
        source: "player",
        message: "Failed to initialize preview player.",
        detail: message,
      });
    }

    return () => {
      player.off(dashjs.MediaPlayer.events.ERROR, reportDashError);
      player.off(dashjs.MediaPlayer.events.PLAYBACK_ERROR, reportPlaybackError);
      player.off(dashjs.MediaPlayer.events.FRAGMENT_LOADING_ABANDONED, reportFragmentAbandoned);
      player.off(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, reportFragmentLoaded);
      player.off(dashjs.MediaPlayer.events.BUFFER_EMPTY, reportBufferEmpty);
      player.off(dashjs.MediaPlayer.events.PLAYBACK_STALLED, reportPlaybackStalled);
      player.off(dashjs.MediaPlayer.events.MANIFEST_LOADED, reportManifestLoaded);
      player.reset();
      playerRef.current = null;
    };
  }, [manifestUrl, onDiagnostic]);

  return (
    <div className="overflow-hidden rounded-sm border border-border bg-black">
      <div className="relative aspect-video bg-black">
        {manifestUrl ? (
          <video
            ref={videoRef}
            className="h-full w-full bg-black object-contain"
            controls
            muted
            playsInline
            onError={() => setError("The browser reported a preview playback error.")}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-sm text-zinc-500">
            No manifest available for preview.
          </div>
        )}

        <div className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-2 rounded-sm border border-white/10 bg-black/70 px-2 py-1 text-xs text-zinc-200">
          <MonitorPlay className="size-3.5" />
          {label}
        </div>

        {error && (
          <div className="absolute inset-x-3 bottom-3 rounded-sm border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
