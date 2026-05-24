import { Circle } from "lucide-react";
import { type StreamStatus } from "@/types/stream";

const statusLabels: Record<StreamStatus, string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Encoding",
  completed: "Complete",
  failed: "Failed",
  stopped: "Stopped",
};

export default function StatusPill({ status }: { status: StreamStatus }) {
  const tone =
    status === "running" || status === "starting"
      ? "bg-red-500 text-white"
      : status === "failed"
        ? "bg-amber-500 text-black"
        : "bg-zinc-700 text-zinc-200";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium ${tone}`}
    >
      <Circle className="size-2 fill-current" />
      {statusLabels[status]}
    </span>
  );
}
