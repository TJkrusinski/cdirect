import { Navigate, Route, Routes } from "react-router-dom";
import Producer from "@/pages/producer";
import Player from "@/pages/player";

import "./index.css";

import useStreams from "./hooks/use-streams";
import useCaptureInputs from "./hooks/use-capture-inputs";

export function App() {
  const { data, loading, error, refresh } = useStreams();
  const captureInputs = useCaptureInputs();

  const manifests = data?.manifests ?? [];
  const configured = data?.configured ?? [];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="w-full px-3 py-3 sm:px-4">
        {error && (
          <div className="mb-4 rounded-sm border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="rounded-sm border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Loading stream state.
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/player" replace />} />
            <Route path="/player" element={<Player manifests={manifests} />} />
            <Route path="/player/:streamName" element={<Player manifests={manifests} />} />
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
            <Route
              path="/producer/:streamName"
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
