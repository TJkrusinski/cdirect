import { Gauge } from "lucide-react";

export default function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof Gauge;
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-zinc-950">{value}</div>
    </div>
  );
}
