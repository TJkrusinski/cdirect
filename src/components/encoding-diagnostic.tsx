import { formatProgressAge } from "@/lib/utils";
import { type ConfiguredStream } from "@/types/stream";
import { Gauge, AlertTriangle } from "lucide-react";

import { diagnosticTone, type DiagnosticLevel } from "@/lib/stream-diagnostics";

function encodingSpeedDiagnostic(stream: ConfiguredStream) {
  const fps = stream.metrics.fps;
  const speed = stream.metrics.speed;
  const targetFps = stream.encoding.frameRate;
  const fpsRatio = fps !== null && targetFps > 0 ? fps / targetFps : null;
  const realtimeRatio = fpsRatio ?? speed;
  const active = stream.status === "running" || stream.status === "starting";

  if (!active && fps === null && speed === null) {
    return {
      level: "info" as DiagnosticLevel,
      title: "No encoding FPS yet",
      message: "Start this stream to collect ffmpeg encoding speed metrics.",
      ratio: null,
    };
  }

  if (active && fps === null && speed === null) {
    return {
      level: "warning" as DiagnosticLevel,
      title: "Waiting for FPS telemetry",
      message: "ffmpeg has not emitted an encoding FPS sample yet.",
      ratio: null,
    };
  }

  if (realtimeRatio !== null && realtimeRatio < 0.7) {
    return {
      level: "error" as DiagnosticLevel,
      title: "Encoding is falling behind",
      message: "The encoder is running well below the configured frame rate.",
      ratio: realtimeRatio,
    };
  }

  if (realtimeRatio !== null && realtimeRatio < 0.9) {
    return {
      level: "warning" as DiagnosticLevel,
      title: "Encoding is below target",
      message: "The encoder is close to realtime but not consistently keeping up.",
      ratio: realtimeRatio,
    };
  }

  return {
    level: "info" as DiagnosticLevel,
    title: "Encoding is keeping up",
    message: "ffmpeg is encoding at or near the configured frame rate.",
    ratio: realtimeRatio,
  };
}

export default function EncodingSpeedDiagnostic({ stream }: { stream: ConfiguredStream }) {
  const diagnostic = encodingSpeedDiagnostic(stream);
  const fps = stream.metrics.fps;
  const speed = stream.metrics.speed;
  const targetFps = stream.encoding.frameRate;
  const ratioPercent =
    diagnostic.ratio === null ? null : Math.max(0, Math.round(diagnostic.ratio * 100));
  const barWidth = ratioPercent === null ? 0 : Math.min(100, ratioPercent);
  const barTone =
    diagnostic.level === "error"
      ? "bg-red-500"
      : diagnostic.level === "warning"
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <div className={`mt-4 rounded-md border p-4 ${diagnosticTone[diagnostic.level]}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            {diagnostic.level === "info" ? (
              <Gauge className="size-4" />
            ) : (
              <AlertTriangle className="size-4" />
            )}
            Encoding FPS diagnostic
          </div>
          <div className="mt-1 text-sm font-medium">{diagnostic.title}</div>
          <div className="mt-1 text-xs opacity-80">{diagnostic.message}</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">
            {fps === null ? "-" : fps.toFixed(1)}
          </div>
          <div className="text-xs opacity-75">fps encoded</div>
        </div>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded bg-white/70">
        <div className={`h-full rounded ${barTone}`} style={{ width: `${barWidth}%` }} />
      </div>

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
        <div>
          <div className="opacity-70">Target</div>
          <div className="font-semibold tabular-nums">{targetFps.toFixed(1)} fps</div>
        </div>
        <div>
          <div className="opacity-70">Keep-up</div>
          <div className="font-semibold tabular-nums">
            {ratioPercent === null ? "-" : `${ratioPercent}%`}
          </div>
        </div>
        <div>
          <div className="opacity-70">Speed</div>
          <div className="font-semibold tabular-nums">
            {speed === null ? "-" : `${speed.toFixed(2)}x`}
          </div>
        </div>
        <div>
          <div className="opacity-70">Last sample</div>
          <div className="font-semibold tabular-nums">
            {formatProgressAge(stream.metrics.lastProgressAt)}
          </div>
        </div>
      </div>
    </div>
  );
}
