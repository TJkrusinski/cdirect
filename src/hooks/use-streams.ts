import { useState, useEffect } from "react";

import { type StreamsResponse } from "@/types/api";

export default function useStreams() {
  const [data, setData] = useState<StreamsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const response = await fetch("/api/streams");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Failed to load streams.");
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  return { data, loading, error, refresh };
}
