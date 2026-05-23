import { useEffect, useState } from "react";

import { type CaptureInputsResponse } from "@/types/api";

export default function useCaptureInputs() {
  const [data, setData] = useState<CaptureInputsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const response = await fetch("/api/inputs");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Failed to load capture inputs.");
      setData(body);
      setError(body.error ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return { data, loading, error, refresh };
}
