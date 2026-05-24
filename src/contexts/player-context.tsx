import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";

import { type PlaybackDiagnostic } from "@/lib/stream-diagnostics";

type PlaybackStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "error";

export type PlayerState = {
  status: PlaybackStatus;
  liveMode: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  error: string | null;
};

export type SegmentWaterfallEntry = {
  id: string;
  url: string | null;
  label: string;
  mediaType: string;
  segmentType: string | null;
  status: "completed" | "abandoned";
  startMs: number;
  endMs: number;
  durationMs: number;
  firstByteMs: number | null;
  bytesLoaded: number | null;
  bytesTotal: number | null;
  index: number | null;
  quality: number | null;
};

export type PlayerAction =
  | { type: "manifest/loading" }
  | { type: "manifest/attached" }
  | { type: "manifest/cleared" }
  | { type: "playback/play-requested" }
  | { type: "playback/playing" }
  | { type: "playback/paused" }
  | { type: "playback/error"; error: string }
  | { type: "playback/time-updated"; currentTime: number; atLiveEdge: boolean }
  | { type: "playback/duration-updated"; duration: number }
  | { type: "playback/user-seeked"; currentTime: number; atLiveEdge: boolean }
  | { type: "playback/live-edge-requested"; currentTime?: number }
  | { type: "audio/muted-changed"; muted: boolean }
  | { type: "audio/volume-changed"; volume: number };

const initialPlayerState: PlayerState = {
  status: "idle",
  liveMode: true,
  muted: true,
  volume: 0.9,
  currentTime: 0,
  duration: 0,
  error: null,
};

function finiteOrZero(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case "manifest/loading":
      return {
        ...state,
        status: "loading",
        liveMode: true,
        currentTime: 0,
        duration: 0,
        error: null,
      };
    case "manifest/attached":
      return {
        ...state,
        status: "ready",
        liveMode: true,
        currentTime: 0,
        duration: 0,
        error: null,
      };
    case "manifest/cleared":
      return { ...initialPlayerState, muted: state.muted, volume: state.volume };
    case "playback/play-requested":
      return { ...state, status: "loading", error: null };
    case "playback/playing":
      return { ...state, status: "playing", error: null };
    case "playback/paused":
      return { ...state, status: "paused" };
    case "playback/error":
      return { ...state, status: "error", error: action.error };
    case "playback/time-updated":
      return {
        ...state,
        currentTime: finiteOrZero(action.currentTime),
        liveMode: state.liveMode || action.atLiveEdge,
      };
    case "playback/duration-updated":
      return { ...state, duration: finiteOrZero(action.duration) };
    case "playback/user-seeked":
      return {
        ...state,
        currentTime: finiteOrZero(action.currentTime),
        liveMode: action.atLiveEdge,
      };
    case "playback/live-edge-requested":
      return {
        ...state,
        liveMode: true,
        currentTime:
          action.currentTime === undefined ? state.currentTime : finiteOrZero(action.currentTime),
      };
    case "audio/muted-changed":
      return { ...state, muted: action.muted };
    case "audio/volume-changed": {
      const volume = Math.min(1, Math.max(0, action.volume));
      return { ...state, volume, muted: volume === 0 };
    }
    default:
      return state;
  }
}

const PlayerContext = createContext<
  | {
      state: PlayerState;
      dispatch: Dispatch<PlayerAction>;
      diagnostics: PlaybackDiagnostic[];
      segments: SegmentWaterfallEntry[];
      pushDiagnostic: (diagnostic: Omit<PlaybackDiagnostic, "id" | "at">) => void;
      recordSegment: (segment: Omit<SegmentWaterfallEntry, "id">) => void;
      clearDiagnostics: () => void;
    }
  | undefined
>(undefined);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(playerReducer, initialPlayerState);
  const [diagnostics, setDiagnostics] = useState<PlaybackDiagnostic[]>([]);
  const [segments, setSegments] = useState<SegmentWaterfallEntry[]>([]);
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
  const recordSegment = useCallback((segment: Omit<SegmentWaterfallEntry, "id">) => {
    setSegments((current) =>
      [
        ...current,
        {
          ...segment,
          id: `${segment.startMs}-${Math.random().toString(36).slice(2)}`,
        },
      ].slice(-80),
    );
  }, []);
  const clearDiagnostics = useCallback(() => {
    setDiagnostics([]);
    setSegments([]);
  }, []);
  const value = useMemo(
    () => ({
      state,
      dispatch,
      diagnostics,
      segments,
      pushDiagnostic,
      recordSegment,
      clearDiagnostics,
    }),
    [state, diagnostics, segments, pushDiagnostic, recordSegment, clearDiagnostics],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayerState() {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error("usePlayerState must be used within PlayerProvider.");
  }
  return context;
}
