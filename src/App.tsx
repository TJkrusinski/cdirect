import {
  Activity,
  AlertTriangle,
  Circle,
  Gauge,
  MonitorPlay,
  Radio,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import Producer from "@/pages/producer";
import Player from "@/pages/player";

import "./index.css";

import { Button } from "@/components/ui/button";
import useStreams from "./hooks/use-streams";
import useCaptureInputs from "./hooks/use-capture-inputs";

export function App() {
  const { data, loading, error, refresh } = useStreams();
  const captureInputs = useCaptureInputs();
  const location = useLocation();
  const [selectedManifest, setSelectedManifest] = useState("");

  const manifests = data?.manifests ?? [];
  const configured = data?.configured ?? [];
  const view = location.pathname.startsWith("/producer") ? "producer" : "player";

  useEffect(() => {
    const preferredManifest = manifests.find((manifest) => manifest.configured) ?? manifests[0];
    const selected = manifests.find((manifest) => manifest.manifestUrl === selectedManifest);
    if (
      preferredManifest &&
      (!selectedManifest || !selected || (!selected.configured && preferredManifest.configured))
    ) {
      setSelectedManifest(preferredManifest.manifestUrl);
    }
  }, [manifests, selectedManifest]);

  const runningCount = useMemo(
    () =>
      configured.filter((stream) => stream.status === "running" || stream.status === "starting")
        .length,
    [configured],
  );

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-md bg-zinc-950 text-white">
                <Radio className="size-4" />
              </span>
              <h1 className="truncate text-xl font-semibold tracking-normal">
                Local Stream Control
              </h1>
            </div>
            <p className="mt-1 text-sm text-zinc-500">
              Encode DASH with ffmpeg, host local segments, and monitor producer health.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
              {manifests.length} manifests · {runningCount} active
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={refresh}
              title="Refresh streams"
            >
              <RefreshCw />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        <div className="mb-5 inline-flex rounded-md border border-zinc-200 bg-white p-1">
          <Button asChild variant={view === "player" ? "default" : "ghost"} className="rounded">
            <Link to="/player">
              <MonitorPlay />
              Player
            </Link>
          </Button>
          <Button asChild variant={view === "producer" ? "default" : "ghost"} className="rounded">
            <Link to="/producer">
              <Activity />
              Producer
            </Link>
          </Button>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="rounded-md border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
            Loading stream state.
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/player" replace />} />
            <Route
              path="/player"
              element={
                <Player
                  manifests={manifests}
                  selectedManifest={selectedManifest}
                  onSelectManifest={setSelectedManifest}
                />
              }
            />
            <Route
              path="/producer"
              element={
                <Producer
                  streams={configured}
                  streamRoot={data?.streamRoot ?? ""}
                  configPath={data?.configPath ?? ""}
                  inputs={captureInputs.data}
                  inputsLoading={captureInputs.loading}
                  inputsError={captureInputs.error}
                  onRefresh={refresh}
                  onRefreshInputs={captureInputs.refresh}
                />
              }
            />
            <Route path="*" element={<Navigate to="/player" replace />} />
          </Routes>
        )}
      </div>
    </main>
  );
}

export default App;
