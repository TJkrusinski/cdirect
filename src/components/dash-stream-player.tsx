import { useEffect, useRef } from "react";
import * as dashjs from "dashjs";
import { Pause, Play, Radio, Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePlayerState } from "@/contexts/player-context";
import {
  describeDashError,
  describeMediaError,
  stringifyDiagnosticData,
} from "@/lib/stream-diagnostics";
import { formatSeconds } from "@/lib/utils";

const LIVE_EDGE_OFFSET_SECONDS = 2.5;
const LIVE_EDGE_TOLERANCE_SECONDS = 4;

function basenameFromUrl(url: string | null) {
  if (!url) return "segment";
  const clean = url.split("?")[0] ?? url;
  return decodeURIComponent(clean.split("/").filter(Boolean).at(-1) ?? clean);
}

function dateMs(value: Date | null | undefined) {
  const time = value instanceof Date ? value.getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function numberOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requestRecord(request: unknown) {
  return request && typeof request === "object" ? (request as Record<string, unknown>) : {};
}

function requestDateMs(request: Record<string, unknown>, key: string) {
  const value = request[key];
  return value instanceof Date ? dateMs(value) : null;
}

function requestNumber(request: Record<string, unknown>, key: string) {
  const value = request[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requestString(request: Record<string, unknown>, key: string) {
  const value = request[key];
  return typeof value === "string" ? value : null;
}

type DashStreamPlayerProps = {
  manifestUrl: string | null;
  label: string;
  playbackVersion?: string;
};

export default function DashStreamPlayer({
  manifestUrl,
  label,
  playbackVersion,
}: DashStreamPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<dashjs.MediaPlayerClass | null>(null);
  const { state, dispatch, pushDiagnostic, recordSegment, clearDiagnostics } = usePlayerState();

  const playbackManifestUrl = manifestUrl
    ? playbackVersion
      ? `${manifestUrl}?v=${encodeURIComponent(playbackVersion)}`
      : manifestUrl
    : "";
  const finiteDuration = Number.isFinite(state.duration) ? state.duration : 0;
  const playing = state.status === "playing" || state.status === "loading";

  const getLiveEdge = () => {
    const video = videoRef.current;
    if (!video) return null;

    const seekable = video.seekable;
    if (seekable.length > 0) {
      const edge = seekable.end(seekable.length - 1);
      return Number.isFinite(edge) ? edge : null;
    }

    return Number.isFinite(video.duration) ? video.duration : null;
  };

  const getLiveSeekTime = () => {
    const edge = getLiveEdge();
    return edge === null ? null : Math.max(0, edge - LIVE_EDGE_OFFSET_SECONDS);
  };

  const isAtLiveEdge = (time: number) => {
    const edge = getLiveEdge();
    return edge === null || edge - time <= LIVE_EDGE_TOLERANCE_SECONDS;
  };

  const seekToLiveEdge = () => {
    const video = videoRef.current;
    if (!video) return;

    const next = getLiveSeekTime();
    if (next !== null) {
      video.currentTime = next;
      dispatch({ type: "playback/live-edge-requested", currentTime: next });
      return;
    }

    dispatch({ type: "playback/live-edge-requested" });
  };

  useEffect(() => {
    if (!playbackManifestUrl || !videoRef.current) {
      dispatch({ type: "manifest/cleared" });
      clearDiagnostics();
      playerRef.current?.reset();
      playerRef.current = null;
      return;
    }

    clearDiagnostics();
    dispatch({ type: "manifest/loading" });
    playerRef.current?.reset();
    const player = dashjs.MediaPlayer().create();
    player.updateSettings({
      streaming: {
        abr: { autoSwitchBitrate: { video: true, audio: true } },
        buffer: { fastSwitchEnabled: true },
      },
    } as dashjs.MediaPlayerSettingClass);

    const reportDashError = (event: dashjs.ErrorEvent) => {
      const summary = describeDashError(event);
      dispatch({ type: "playback/error", error: summary.message });
      pushDiagnostic({
        level: "error",
        source: "dash.js",
        message: summary.message,
        detail: summary.detail,
      });
    };
    const reportPlaybackError = (event: dashjs.PlaybackErrorEvent) => {
      const message = describeMediaError(event.error);
      dispatch({ type: "playback/error", error: message });
      pushDiagnostic({
        level: "error",
        source: "video",
        message,
        detail: stringifyDiagnosticData(event.error),
      });
    };
    const reportPlaybackNotAllowed = () => {
      const message = "The browser blocked autoplay with sound.";
      dispatch({ type: "playback/error", error: message });
      pushDiagnostic({
        level: "error",
        source: "video",
        message,
      });
    };
    const reportManifestLoaded = () => {
      pushDiagnostic({
        level: "info",
        source: "manifest",
        message: "dash.js loaded the selected manifest.",
      });
    };
    const reportFragmentLoaded = (event: dashjs.FragmentLoadingCompletedEvent) => {
      const request = event.request;
      const startedAt = dateMs(request.startDate) ?? Date.now();
      const endedAt = dateMs(request.requestEndDate) ?? Date.now();
      const firstByteAt = dateMs(request.firstByteDate);
      const url = request.url;

      recordSegment({
        url,
        label: basenameFromUrl(url),
        mediaType: request.mediaType ?? "media",
        segmentType: request.type,
        status: "completed",
        startMs: startedAt,
        endMs: Math.max(startedAt, endedAt),
        durationMs: Math.max(0, endedAt - startedAt),
        firstByteMs: firstByteAt === null ? null : Math.max(0, firstByteAt - startedAt),
        bytesLoaded: numberOrNull(request.bytesLoaded),
        bytesTotal: numberOrNull(request.bytesTotal),
        index: numberOrNull(request.index),
        quality: numberOrNull(request.quality),
      });
    };
    const reportFragmentAbandoned = (event: dashjs.FragmentLoadingAbandonedEvent) => {
      const request = requestRecord(event.request);
      const startedAt = requestDateMs(request, "startDate") ?? Date.now();
      const endedAt = requestDateMs(request, "requestEndDate") ?? Date.now();
      const url = requestString(request, "url");

      recordSegment({
        url,
        label: basenameFromUrl(url),
        mediaType: event.mediaType ?? requestString(request, "mediaType") ?? "media",
        segmentType: requestString(request, "type"),
        status: "abandoned",
        startMs: startedAt,
        endMs: Math.max(startedAt, endedAt),
        durationMs: Math.max(0, endedAt - startedAt),
        firstByteMs: null,
        bytesLoaded: requestNumber(request, "bytesLoaded"),
        bytesTotal: requestNumber(request, "bytesTotal"),
        index: requestNumber(request, "index"),
        quality: requestNumber(request, "quality"),
      });
      pushDiagnostic({
        level: "warning",
        source: "dash.js",
        message: `Abandoned ${event.mediaType ?? "media"} fragment request.`,
        detail: stringifyDiagnosticData(event.request),
      });
    };

    player.on(dashjs.MediaPlayer.events.ERROR, reportDashError);
    player.on(dashjs.MediaPlayer.events.PLAYBACK_ERROR, reportPlaybackError);
    player.on(dashjs.MediaPlayer.events.PLAYBACK_NOT_ALLOWED, reportPlaybackNotAllowed);
    player.on(dashjs.MediaPlayer.events.MANIFEST_LOADED, reportManifestLoaded);
    player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, reportFragmentLoaded);
    player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_ABANDONED, reportFragmentAbandoned);

    try {
      videoRef.current.muted = true;
      player.initialize(videoRef.current, playbackManifestUrl, true);
      dispatch({ type: "manifest/attached" });
      pushDiagnostic({
        level: "info",
        source: "player",
        message: "Attached playback manifest.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "playback/error", error: message });
      pushDiagnostic({
        level: "error",
        source: "player",
        message: "Failed to initialize dash.js.",
        detail: message,
      });
    }
    playerRef.current = player;

    return () => {
      player.off(dashjs.MediaPlayer.events.ERROR, reportDashError);
      player.off(dashjs.MediaPlayer.events.PLAYBACK_ERROR, reportPlaybackError);
      player.off(dashjs.MediaPlayer.events.PLAYBACK_NOT_ALLOWED, reportPlaybackNotAllowed);
      player.off(dashjs.MediaPlayer.events.MANIFEST_LOADED, reportManifestLoaded);
      player.off(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, reportFragmentLoaded);
      player.off(dashjs.MediaPlayer.events.FRAGMENT_LOADING_ABANDONED, reportFragmentAbandoned);
      player.reset();
      playerRef.current = null;
    };
  }, [playbackManifestUrl, dispatch, pushDiagnostic, recordSegment, clearDiagnostics]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = state.volume;
    video.muted = state.muted;
  }, [state.muted, state.volume]);

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (video.paused) {
        dispatch({ type: "playback/play-requested" });
        if (state.liveMode) {
          seekToLiveEdge();
        }
        await video.play();
      } else {
        video.pause();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "playback/error", error: message });
    }
  };

  const seek = (value: string) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    video.currentTime = next;
    dispatch({ type: "playback/user-seeked", currentTime: next, atLiveEdge: isAtLiveEdge(next) });
  };

  return (
    <div className="group relative aspect-video w-full overflow-hidden bg-black">
      {manifestUrl ? (
        <video
          ref={videoRef}
          className="h-full w-full bg-black object-contain"
          autoPlay
          muted={state.muted}
          playsInline
          onClick={togglePlay}
          onPlay={() => {
            if (state.liveMode) {
              seekToLiveEdge();
            }
            dispatch({ type: "playback/playing" });
          }}
          onPause={() => dispatch({ type: "playback/paused" })}
          onError={() =>
            dispatch({
              type: "playback/error",
              error: describeMediaError(videoRef.current?.error ?? null),
            })
          }
          onTimeUpdate={(event) =>
            dispatch({
              type: "playback/time-updated",
              currentTime: event.currentTarget.currentTime,
              atLiveEdge: isAtLiveEdge(event.currentTarget.currentTime),
            })
          }
          onDurationChange={(event) =>
            dispatch({
              type: "playback/duration-updated",
              duration: event.currentTarget.duration,
            })
          }
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-sm text-zinc-500">
          No manifest available for playback.
        </div>
      )}

      <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-sm bg-red-600 px-2 py-1 text-xs font-bold uppercase tracking-wide text-white">
          <Radio className="size-3" />
          Live
        </span>
        <span className="max-w-[70vw] truncate rounded-sm border border-white/10 bg-black/70 px-2 py-1 text-xs text-white">
          {label}
        </span>
      </div>

      {state.error && (
        <div className="absolute right-4 top-4 max-w-md rounded-sm border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-100 backdrop-blur">
          {state.error}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-4 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
        <input
          aria-label="Playback position"
          type="range"
          min="0"
          max={finiteDuration}
          step="0.1"
          value={finiteDuration > 0 ? Math.min(state.currentTime, finiteDuration) : 0}
          onChange={(event) => seek(event.target.value)}
          className="youtube-range mb-3 w-full"
          disabled={!manifestUrl}
        />
        <div className="flex items-center justify-between gap-3 text-white">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="text-white hover:bg-white/15 hover:text-white"
              onClick={togglePlay}
              disabled={!manifestUrl}
              title={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause /> : <Play />}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="text-white hover:bg-white/15 hover:text-white"
              onClick={() => dispatch({ type: "audio/muted-changed", muted: !state.muted })}
              title={state.muted ? "Unmute" : "Mute"}
            >
              {state.muted ? <VolumeX /> : <Volume2 />}
            </Button>
            <input
              aria-label="Volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={state.muted ? 0 : state.volume}
              onChange={(event) =>
                dispatch({
                  type: "audio/volume-changed",
                  volume: Number(event.target.value),
                })
              }
              className="youtube-range w-20"
            />
            <span className="text-xs tabular-nums text-zinc-200">
              {formatSeconds(state.currentTime)} /{" "}
              {finiteDuration > 0 ? formatSeconds(finiteDuration) : "live"}
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="h-8 text-xs font-semibold text-white hover:bg-white/15 hover:text-white"
            onClick={seekToLiveEdge}
            disabled={!manifestUrl}
          >
            {state.liveMode ? "Live" : "Live edge"}
          </Button>
        </div>
      </div>
    </div>
  );
}
