export type DiagnosticLevel = "info" | "warning" | "error";

export type PlaybackDiagnostic = {
  id: string;
  level: DiagnosticLevel;
  source: string;
  message: string;
  detail?: string;
  at: string;
};

export function stringifyDiagnosticData(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const seen = new WeakSet<object>();
  try {
    const output = JSON.stringify(
      value,
      (_key, current) => {
        if (current instanceof Error) {
          return { name: current.name, message: current.message };
        }
        if (typeof XMLHttpRequest !== "undefined" && current instanceof XMLHttpRequest) {
          return {
            readyState: current.readyState,
            responseURL: current.responseURL,
            status: current.status,
            statusText: current.statusText,
          };
        }
        if (typeof current === "object" && current !== null) {
          if (seen.has(current)) return "[Circular]";
          seen.add(current);
        }
        if (typeof current === "function") return undefined;
        return current;
      },
      2,
    );
    return output.length > 1400 ? `${output.slice(0, 1400)}...` : output;
  } catch {
    return String(value);
  }
}

export function describeDashError(event: dashjs.ErrorEvent) {
  const record = event as unknown as Record<string, unknown>;
  const errorValue = record.error;
  const nestedEvent = record.event as Record<string, unknown> | undefined;

  if (typeof errorValue === "object" && errorValue !== null) {
    const errorRecord = errorValue as Record<string, unknown>;
    const code = errorRecord.code;
    const message =
      typeof errorRecord.message === "string" ? errorRecord.message : "dash.js playback error.";
    const detail = stringifyDiagnosticData(errorRecord.data ?? event);
    return {
      message: typeof code === "number" ? `${message} (code ${code})` : message,
      detail,
    };
  }

  if (errorValue === "download" && nestedEvent) {
    const request = nestedEvent.request as XMLHttpRequest | undefined;
    const id = typeof nestedEvent.id === "string" ? nestedEvent.id : "download";
    const url = typeof nestedEvent.url === "string" ? nestedEvent.url : request?.responseURL;
    const status = request?.status ? ` HTTP ${request.status}` : "";
    return {
      message: `dash.js failed to load ${id}.${status}`,
      detail: [url, stringifyDiagnosticData(nestedEvent)].filter(Boolean).join("\n"),
    };
  }

  if (errorValue === "manifestError" && nestedEvent) {
    const message =
      typeof nestedEvent.message === "string" ? nestedEvent.message : "Manifest parsing failed.";
    return {
      message,
      detail: stringifyDiagnosticData(nestedEvent),
    };
  }

  return {
    message:
      typeof errorValue === "string"
        ? `dash.js ${errorValue} error.`
        : "dash.js reported a playback error.",
    detail: stringifyDiagnosticData(event),
  };
}

const mediaErrorMessages: Record<number, string> = {
  1: "Playback was aborted.",
  2: "A network error interrupted playback.",
  3: "The browser could not decode this media.",
  4: "The media source is unsupported or unavailable.",
};

export function describeMediaError(error: MediaError | null) {
  if (!error) return "The browser reported a media playback error.";
  return mediaErrorMessages[error.code] ?? `The browser reported media error ${error.code}.`;
}

export const diagnosticTone: Record<DiagnosticLevel, string> = {
  info: "border-zinc-700 bg-zinc-900/70 text-zinc-200",
  warning: "border-amber-500/35 bg-amber-500/10 text-amber-200",
  error: "border-red-500/35 bg-red-500/10 text-red-200",
};
