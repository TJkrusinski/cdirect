import { useCallback, useEffect, useRef, useState } from "react";
import * as dashjs from "dashjs";
import { MonitorPlay, Pause, Play, Radio, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import StatusPill from "@/components/ui/status-pill";

import { type ManifestOption, type ManifestProbe } from "@/types/stream";
import { type PlaybackDiagnostic } from "@/lib/stream-diagnostics";

import { formatBytes, formatSeconds } from "@/lib/utils";
import {
  describeDashError,
  describeMediaError,
  diagnosticTone,
  stringifyDiagnosticData,
} from "@/lib/stream-diagnostics";

export default function Player({
  manifests,
  selectedManifest,
  onSelectManifest,
}: {
  manifests: ManifestOption[];
  selectedManifest: string;
  onSelectManifest: (value: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<dashjs.MediaPlayerClass | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.9);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [manifestProbe, setManifestProbe] = useState<ManifestProbe>({
    status: "idle",
    checkedAt: null,
  });
  const [diagnostics, setDiagnostics] = useState<PlaybackDiagnostic[]>([]);

  const activeManifest =
    manifests.find((manifest) => manifest.manifestUrl === selectedManifest) ?? manifests[0];
  const playbackManifestUrl = activeManifest
    ? `${activeManifest.manifestUrl}?v=${encodeURIComponent(activeManifest.playbackVersion)}`
    : "";
  const finiteDuration = Number.isFinite(duration) ? duration : 0;
  const latestError = diagnostics.find((diagnostic) => diagnostic.level === "error");

  const pushDiagnostic = useCallback((diagnostic: Omit<PlaybackDiagnostic, "id" | "at">) => {
    setDiagnostics((current) =>
      [
        {
          ...diagnostic,
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          at: new Date().toISOString(),
        },
        ...current,
      ].slice(0, 50),
    );
  }, []);

  useEffect(() => {
    if (!activeManifest || !videoRef.current) return;

    setDiagnostics([]);
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
      setPlayerError(summary.message);
      pushDiagnostic({
        level: "error",
        source: "dash.js",
        message: summary.message,
        detail: summary.detail,
      });
    };
    const reportPlaybackError = (event: dashjs.PlaybackErrorEvent) => {
      const message = describeMediaError(event.error);
      setPlayerError(message);
      pushDiagnostic({
        level: "error",
        source: "video",
        message,
        detail: stringifyDiagnosticData(event.error),
      });
    };
    const reportFragmentAbandoned = (event: dashjs.FragmentLoadingAbandonedEvent) => {
      pushDiagnostic({
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
        pushDiagnostic({
          level: "error",
          source: "network",
          message: `Segment request returned HTTP ${status}.`,
          detail: request.url ?? undefined,
        });
      }
    };
    const reportBufferEmpty = (event: dashjs.BufferEvent) => {
      pushDiagnostic({
        level: "warning",
        source: "buffer",
        message: `${event.mediaType ?? "Media"} buffer is empty.`,
      });
    };
    const reportPlaybackStalled = () => {
      pushDiagnostic({
        level: "warning",
        source: "video",
        message: "Playback stalled while waiting for media data.",
      });
    };
    const reportPlaybackNotAllowed = () => {
      const message = "The browser blocked autoplay with sound.";
      setPlayerError(message);
      pushDiagnostic({
        level: "error",
        source: "video",
        message,
        detail:
          "Click play to start playback, or allow autoplay with sound for this site in the browser.",
      });
    };
    const reportManifestLoaded = () => {
      pushDiagnostic({
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
    player.on(dashjs.MediaPlayer.events.PLAYBACK_NOT_ALLOWED, reportPlaybackNotAllowed);
    player.on(dashjs.MediaPlayer.events.MANIFEST_LOADED, reportManifestLoaded);

    setPlayerError(null);
    try {
      player.initialize(videoRef.current, playbackManifestUrl, true);
      pushDiagnostic({
        level: "info",
        source: "player",
        message: `Attached manifest ${activeManifest.relativePath} with autoplay enabled.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPlayerError(message);
      pushDiagnostic({
        level: "error",
        source: "player",
        message: "Failed to initialize dash.js.",
        detail: message,
      });
    }
    playerRef.current = player;
    setPlaying(false);
    setCurrentTime(0);

    return () => {
      player.off(dashjs.MediaPlayer.events.ERROR, reportDashError);
      player.off(dashjs.MediaPlayer.events.PLAYBACK_ERROR, reportPlaybackError);
      player.off(dashjs.MediaPlayer.events.FRAGMENT_LOADING_ABANDONED, reportFragmentAbandoned);
      player.off(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, reportFragmentLoaded);
      player.off(dashjs.MediaPlayer.events.BUFFER_EMPTY, reportBufferEmpty);
      player.off(dashjs.MediaPlayer.events.PLAYBACK_STALLED, reportPlaybackStalled);
      player.off(dashjs.MediaPlayer.events.PLAYBACK_NOT_ALLOWED, reportPlaybackNotAllowed);
      player.off(dashjs.MediaPlayer.events.MANIFEST_LOADED, reportManifestLoaded);
      player.reset();
      playerRef.current = null;
    };
  }, [playbackManifestUrl, activeManifest?.relativePath, pushDiagnostic]);

  useEffect(() => {
    if (!activeManifest) {
      setManifestProbe({ status: "idle", checkedAt: null });
      setDiagnostics([]);
      return;
    }

    const controller = new AbortController();
    const checkedAt = new Date().toISOString();
    setManifestProbe({ status: "checking", checkedAt });
    pushDiagnostic({
      level: "info",
      source: "manifest",
      message: `Checking ${activeManifest.relativePath}.`,
    });

    void (async () => {
      try {
        const response = await fetch(playbackManifestUrl, {
          cache: "no-store",
          signal: controller.signal,
        });
        const contentType = response.headers.get("content-type");
        const text = await response.text();
        const baseProbe = {
          checkedAt,
          httpStatus: response.status,
          contentType,
          sizeBytes: text.length,
          preview: text.slice(0, 240),
        };

        if (!response.ok) {
          throw new Error(`Manifest request returned HTTP ${response.status}.`);
        }

        if (!/<MPD[\s>]/.test(text)) {
          const error = "Manifest response does not look like a DASH MPD document.";
          setManifestProbe({ ...baseProbe, status: "error", error });
          setPlayerError(error);
          pushDiagnostic({
            level: "error",
            source: "manifest",
            message: error,
            detail: text.slice(0, 500),
          });
          return;
        }

        setManifestProbe({ ...baseProbe, status: "ok", error: null });
        pushDiagnostic({
          level: "info",
          source: "manifest",
          message: `Manifest check passed with HTTP ${response.status}.`,
          detail: `${contentType ?? "unknown content type"} · ${formatBytes(text.length)}`,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const message = error instanceof Error ? error.message : String(error);
        setManifestProbe({
          status: "error",
          checkedAt,
          error: message,
        });
        setPlayerError(message);
        pushDiagnostic({
          level: "error",
          source: "manifest",
          message: "Manifest check failed.",
          detail: message,
        });
      }
    })();

    return () => controller.abort();
  }, [playbackManifestUrl, activeManifest?.relativePath, pushDiagnostic]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [muted, volume]);

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (video.paused) {
        await video.play();
      } else {
        video.pause();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPlayerError(message);
      pushDiagnostic({
        level: "error",
        source: "video",
        message: "The browser rejected the playback request.",
        detail: message,
      });
    }
  };

  const reportVideoElementError = () => {
    const message = describeMediaError(videoRef.current?.error ?? null);
    setPlayerError(message);
    pushDiagnostic({
      level: "error",
      source: "video",
      message,
      detail: stringifyDiagnosticData(videoRef.current?.error),
    });
  };

  const seek = (value: string) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    video.currentTime = next;
    setCurrentTime(next);
  };

  const seekToLiveEdge = () => {
    const video = videoRef.current;
    if (!video) return;

    const seekable = video.seekable;
    if (seekable.length > 0) {
      const edge = seekable.end(seekable.length - 1);
      if (Number.isFinite(edge)) {
        video.currentTime = Math.max(0, edge - 0.5);
      }
      return;
    }

    if (Number.isFinite(video.duration)) {
      video.currentTime = Math.max(0, video.duration - 3);
    }
  };

  return (
    <section className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="overflow-hidden rounded-md bg-black shadow-2xl">
        <div className="group relative aspect-video bg-black">
          <video
            ref={videoRef}
            className="h-full w-full bg-black object-contain"
            autoPlay
            muted={muted}
            playsInline
            onClick={togglePlay}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={reportVideoElementError}
            onStalled={() =>
              pushDiagnostic({
                level: "warning",
                source: "video",
                message: "The browser stalled while loading media.",
              })
            }
            onWaiting={() =>
              pushDiagnostic({
                level: "info",
                source: "video",
                message: "Playback is waiting for more buffered data.",
              })
            }
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onDurationChange={(event) => setDuration(event.currentTarget.duration)}
          />

          <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-xs font-bold uppercase tracking-wide text-white">
              <Radio className="size-3" />
              Live
            </span>
            {activeManifest && (
              <span className="max-w-[52vw] truncate rounded bg-black/70 px-2 py-1 text-xs text-white">
                {activeManifest.name}
              </span>
            )}
          </div>

          {!activeManifest && (
            <div className="absolute inset-0 grid place-items-center text-sm text-zinc-400">
              Add or generate a DASH manifest to start playback.
            </div>
          )}

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-4 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
            <input
              aria-label="Playback position"
              type="range"
              min="0"
              max={finiteDuration}
              step="0.1"
              value={finiteDuration > 0 ? Math.min(currentTime, finiteDuration) : 0}
              onChange={(event) => seek(event.target.value)}
              className="youtube-range mb-3 w-full"
            />
            <div className="flex items-center justify-between gap-3 text-white">
              <div className="flex min-w-0 items-center gap-2">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="text-white hover:bg-white/15 hover:text-white"
                  onClick={togglePlay}
                  disabled={!activeManifest}
                  title={playing ? "Pause" : "Play"}
                >
                  {playing ? <Pause /> : <Play />}
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="text-white hover:bg-white/15 hover:text-white"
                  onClick={() => setMuted((value) => !value)}
                  title={muted ? "Unmute" : "Mute"}
                >
                  {muted ? <VolumeX /> : <Volume2 />}
                </Button>
                <input
                  aria-label="Volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={muted ? 0 : volume}
                  onChange={(event) => {
                    setVolume(Number(event.target.value));
                    setMuted(Number(event.target.value) === 0);
                  }}
                  className="youtube-range w-20"
                />
                <span className="text-xs tabular-nums text-zinc-200">
                  {formatSeconds(currentTime)} /{" "}
                  {finiteDuration > 0 ? formatSeconds(finiteDuration) : "live"}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                className="h-8 rounded text-xs font-semibold text-white hover:bg-white/15 hover:text-white"
                onClick={seekToLiveEdge}
              >
                Live edge
              </Button>
            </div>
          </div>
        </div>
      </div>

      <aside className="rounded-md border border-zinc-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-950">Player</h2>
            <p className="text-xs text-zinc-500">DASH manifests found on disk</p>
          </div>
          <MonitorPlay className="size-5 text-zinc-400" />
        </div>

        <Select value={activeManifest?.manifestUrl ?? ""} onValueChange={onSelectManifest}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a manifest" />
          </SelectTrigger>
          <SelectContent>
            {manifests.map((manifest) => (
              <SelectItem key={manifest.id} value={manifest.manifestUrl}>
                {manifest.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {playerError && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900">
            <div className="font-semibold">
              {latestError ? `Latest ${latestError.source} error` : "Playback error"}
            </div>
            <div className="mt-1 break-words">{playerError}</div>
          </div>
        )}

        {activeManifest && (
          <div className="mt-3 space-y-2 rounded-md bg-zinc-50 p-3 text-xs text-zinc-600">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-zinc-950">Manifest check</span>
              <span
                className={`rounded px-2 py-0.5 font-medium ${
                  manifestProbe.status === "ok"
                    ? "bg-emerald-100 text-emerald-800"
                    : manifestProbe.status === "error"
                      ? "bg-red-100 text-red-800"
                      : "bg-zinc-200 text-zinc-700"
                }`}
              >
                {manifestProbe.status}
              </span>
            </div>
            <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-2 gap-y-1">
              <span>Path</span>
              <span className="truncate font-mono">{activeManifest.relativePath}</span>
              <span>Status</span>
              <span>{manifestProbe.httpStatus ?? "-"}</span>
              <span>Type</span>
              <span className="truncate">{manifestProbe.contentType ?? "-"}</span>
              <span>Size</span>
              <span>{formatBytes(manifestProbe.sizeBytes ?? activeManifest.size ?? null)}</span>
            </div>
            {manifestProbe.error && (
              <div className="break-words text-red-700">{manifestProbe.error}</div>
            )}
          </div>
        )}

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-950">Diagnostics</h3>
              <p className="text-xs text-zinc-500">Recent manifest, network, and playback events</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDiagnostics([])}
              disabled={diagnostics.length === 0}
            >
              Clear
            </Button>
          </div>
          <div className="max-h-72 space-y-2 overflow-auto pr-1">
            {diagnostics.length > 0 ? (
              diagnostics.map((diagnostic) => (
                <div
                  key={diagnostic.id}
                  className={`rounded-md border p-2 text-xs ${diagnosticTone[diagnostic.level]}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{diagnostic.source}</span>
                    <span className="shrink-0 tabular-nums opacity-75">
                      {new Date(diagnostic.at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="mt-1 break-words">{diagnostic.message}</div>
                  {diagnostic.detail && (
                    <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-white/60 p-2 font-mono text-[11px] leading-snug">
                      {diagnostic.detail}
                    </pre>
                  )}
                </div>
              ))
            ) : (
              <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-500">
                No playback diagnostics yet.
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {manifests.map((manifest) => (
            <button
              key={manifest.id}
              className={`w-full rounded-md border p-3 text-left transition ${
                manifest.manifestUrl === activeManifest?.manifestUrl
                  ? "border-red-500 bg-red-50"
                  : "border-zinc-200 bg-white hover:bg-zinc-50"
              }`}
              onClick={() => onSelectManifest(manifest.manifestUrl)}
              type="button"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-sm font-medium text-zinc-950">{manifest.name}</span>
                <StatusPill status={manifest.status} />
              </div>
              <div className="mt-1 truncate text-xs text-zinc-500">{manifest.relativePath}</div>
            </button>
          ))}
        </div>
      </aside>
    </section>
  );
}
