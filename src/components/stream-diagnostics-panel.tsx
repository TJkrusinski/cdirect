import { useEffect, useRef, useState } from "react";

import { usePlayerState } from "@/contexts/player-context";
import { diagnosticTone } from "@/lib/stream-diagnostics";
import { formatBytes } from "@/lib/utils";
import { type ManifestProbe } from "@/types/stream";

import { Button } from "@/components/ui/button";

function formatMs(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

export default function StreamDiagnosticsPanel({
  manifestUrl,
  manifestLabel,
}: {
  manifestUrl: string | null;
  manifestLabel: string;
}) {
  const { diagnostics, segments, clearDiagnostics } = usePlayerState();
  const [manifestProbe, setManifestProbe] = useState<ManifestProbe>({
    status: "idle",
    checkedAt: null,
  });

  useEffect(() => {
    if (!manifestUrl) {
      setManifestProbe({ status: "idle", checkedAt: null });
      return;
    }

    const controller = new AbortController();
    const checkedAt = new Date().toISOString();
    setManifestProbe({ status: "checking", checkedAt });

    void (async () => {
      try {
        const response = await fetch(manifestUrl, {
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
          setManifestProbe({
            ...baseProbe,
            status: "error",
            error: "Manifest response does not look like a DASH MPD document.",
          });
          return;
        }

        setManifestProbe({ ...baseProbe, status: "ok", error: null });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const message = error instanceof Error ? error.message : String(error);
        setManifestProbe({
          status: "error",
          checkedAt,
          error: message,
        });
      }
    })();

    return () => controller.abort();
  }, [manifestUrl]);

  return (
    <div className="mb-4 rounded-sm border border-border bg-muted p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Playback diagnostics</h3>
          <p className="text-xs text-muted-foreground">{manifestLabel}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={clearDiagnostics}
          disabled={diagnostics.length === 0 && segments.length === 0}
        >
          Clear
        </Button>
      </div>

      <div className="mt-3 space-y-2 rounded-sm border border-border bg-card p-3 text-xs text-muted-foreground">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-foreground">Manifest check</span>
          <span
            className={`rounded-sm px-2 py-0.5 font-medium ${
              manifestProbe.status === "ok"
                ? "bg-emerald-500/15 text-emerald-300"
                : manifestProbe.status === "error"
                  ? "bg-red-500/15 text-red-300"
                  : "bg-zinc-700 text-zinc-300"
            }`}
          >
            {manifestProbe.status}
          </span>
        </div>
        <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-2 gap-y-1">
          <span>Status</span>
          <span>{manifestProbe.httpStatus ?? "-"}</span>
          <span>Type</span>
          <span className="truncate">{manifestProbe.contentType ?? "-"}</span>
          <span>Size</span>
          <span>{formatBytes(manifestProbe.sizeBytes ?? null)}</span>
        </div>
        {manifestProbe.error && (
          <div className="break-words text-red-300">{manifestProbe.error}</div>
        )}
      </div>

      <div className="mt-3 rounded-sm border border-border bg-card p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase text-muted-foreground">
              Segment waterfall
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Recent media segment requests from dash.js
            </div>
          </div>
          <div className="text-xs tabular-nums text-muted-foreground">
            {Math.min(segments.length, 32)} shown
          </div>
        </div>
        <SegmentWaterfall segments={segments} />
      </div>

      <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">
        {diagnostics.length > 0 ? (
          diagnostics.map((diagnostic) => (
            <div
              key={diagnostic.id}
              className={`rounded-sm border p-2 text-xs ${diagnosticTone[diagnostic.level]}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{diagnostic.source}</span>
                <span className="shrink-0 tabular-nums opacity-75">
                  {new Date(diagnostic.at).toLocaleTimeString()}
                </span>
              </div>
              <div className="mt-1 break-words">{diagnostic.message}</div>
              {diagnostic.detail && (
                <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-black/30 p-2 font-mono text-[11px] leading-snug">
                  {diagnostic.detail}
                </pre>
              )}
            </div>
          ))
        ) : (
          <div className="rounded-sm border border-border bg-card p-3 text-xs text-muted-foreground">
            No playback diagnostics yet.
          </div>
        )}
      </div>
    </div>
  );
}

function SegmentWaterfall({
  segments,
}: {
  segments: ReturnType<typeof usePlayerState>["segments"];
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const visibleSegments = segments.slice(-32);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [visibleSegments.length]);

  if (visibleSegments.length === 0) {
    return (
      <div className="rounded-sm border border-border bg-muted/60 p-3 text-xs text-muted-foreground">
        No segment requests recorded yet.
      </div>
    );
  }

  const minStart = Math.min(...visibleSegments.map((segment) => segment.startMs));
  const maxEnd = Math.max(...visibleSegments.map((segment) => segment.endMs));
  const span = Math.max(1, maxEnd - minStart);

  return (
    <div className="space-y-2">
      <div className="relative h-5 rounded-sm bg-muted text-[10px] text-muted-foreground">
        <span className="absolute left-0 top-1 px-1 tabular-nums">0ms</span>
        <span className="absolute right-0 top-1 px-1 tabular-nums">{formatMs(span)}</span>
      </div>
      <div ref={scrollRef} className="max-h-72 space-y-1 overflow-auto pr-1">
        {visibleSegments.map((segment) => {
          const left = ((segment.startMs - minStart) / span) * 100;
          const width = Math.max(1.5, (segment.durationMs / span) * 100);
          const firstByteLeft =
            segment.firstByteMs === null
              ? null
              : Math.min(
                  100,
                  Math.max(0, (segment.firstByteMs / Math.max(1, segment.durationMs)) * 100),
                );
          const tone =
            segment.status === "abandoned"
              ? "bg-amber-400"
              : segment.mediaType === "audio"
                ? "bg-sky-400"
                : "bg-emerald-400";

          return (
            <div
              key={segment.id}
              className="grid grid-cols-[7rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-xs"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{segment.label}</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {segment.mediaType}
                  {segment.index === null ? "" : ` #${segment.index}`}
                  {segment.quality === null ? "" : ` q${segment.quality}`}
                </div>
              </div>
              <div className="relative h-7 overflow-hidden rounded-sm bg-muted">
                <div
                  className={`absolute top-1.5 h-4 min-w-1 rounded-sm ${tone}`}
                  style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                  title={`${segment.label} ${formatMs(segment.durationMs)}`}
                >
                  {firstByteLeft !== null && (
                    <span
                      className="absolute top-0 h-full w-px bg-black/60"
                      style={{ left: `${firstByteLeft}%` }}
                    />
                  )}
                </div>
              </div>
              <div className="text-right tabular-nums text-muted-foreground">
                <div>{formatMs(segment.durationMs)}</div>
                <div className="text-[10px]">{formatBytes(segment.bytesLoaded)}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-emerald-400" />
          Video
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-sky-400" />
          Audio
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-amber-400" />
          Abandoned
        </span>
        <span>Black marker is first byte.</span>
      </div>
    </div>
  );
}
