import { mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import path from "path";
import { serve } from "bun";
import index from "./index.html";

type StorageTarget = "local";
type InputKind = "file" | "device";
type VideoEncoder = "auto" | "h264_videotoolbox" | "libx264";
type StorageConfig = {
  type: StorageTarget;
  root: string;
};

type AppConfig = {
  version: 1;
  storage: StorageConfig;
  ffmpeg: {
    defaultSegmentDuration: number;
  };
  streams: StreamConfig[];
};

type StreamStatus = "idle" | "starting" | "running" | "completed" | "failed" | "stopped";

type StreamConfig = {
  id: string;
  name: string;
  inputKind: InputKind;
  inputPath: string;
  inputLabel: string | null;
  deviceInput: DeviceInputConfig | null;
  outputSubdir: string;
  manifestName: string;
  segmentDuration: number;
  encoding: EncodingConfig;
  storageTarget: StorageTarget;
  createdAt: string;
  updatedAt: string;
};

type CaptureDevice = {
  id: string;
  name: string;
  kind: "video" | "audio";
  inputFormat: "avfoundation";
};

type DeviceInputConfig = {
  platform: "avfoundation";
  videoId: string | null;
  videoName: string | null;
  audioId: string | null;
  audioName: string | null;
};

type EncodingConfig = {
  videoEncoder: VideoEncoder;
  frameRate: number;
  outputWidth: number;
  outputHeight: number;
  videoBitrateKbps: number;
  videoMinrateKbps: number;
  videoMaxrateKbps: number;
  videoBufsizeKbps: number;
  audioBitrateKbps: number;
  x264Preset: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium";
};

type StreamMetrics = {
  frame: number | null;
  fps: number | null;
  bitrate: string | null;
  speed: number | null;
  encodedSeconds: number;
  totalSizeBytes: number | null;
  droppedFrames: number | null;
  duplicatedFrames: number | null;
  progress: string | null;
  warnings: number;
  errors: number;
  audioWarnings: number;
  audioErrors: number;
  lastAudioIssue: string | null;
  lastProgressAt: string | null;
};

type RuntimeState = {
  status: StreamStatus;
  process: ReturnType<typeof Bun.spawn> | null;
  metrics: StreamMetrics;
  logs: string[];
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  stopRequested: boolean;
};

const configPath = path.resolve(process.env.STREAM_CONFIG_PATH ?? "stream-config.json");
const runtime = new Map<string, RuntimeState>();

const defaultAppConfig = (): AppConfig => ({
  version: 1,
  storage: {
    type: "local",
    root: process.env.STREAM_ROOT ?? "streams",
  },
  ffmpeg: {
    defaultSegmentDuration: 2,
  },
  streams: [],
});

const defaultMetrics = (): StreamMetrics => ({
  frame: null,
  fps: null,
  bitrate: null,
  speed: null,
  encodedSeconds: 0,
  totalSizeBytes: null,
  droppedFrames: null,
  duplicatedFrames: null,
  progress: null,
  warnings: 0,
  errors: 0,
  audioWarnings: 0,
  audioErrors: 0,
  lastAudioIssue: null,
  lastProgressAt: null,
});

const json = (body: unknown, init?: ResponseInit) =>
  Response.json(body, {
    headers: { "cache-control": "no-store", ...init?.headers },
    status: init?.status,
    statusText: init?.statusText,
  });

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const safeJoin = (root: string, ...parts: string[]) => {
  const resolved = path.resolve(root, ...parts);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes stream root");
  }
  return resolved;
};

const fileExists = async (filePath: string) => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const configDir = () => path.dirname(configPath);
const streamRootFor = (config: AppConfig) => path.resolve(config.storage.root);

async function loadAppConfig(): Promise<AppConfig> {
  await mkdir(configDir(), { recursive: true });
  if (!(await fileExists(configPath))) {
    const initial = defaultAppConfig();
    await saveAppConfig(initial);
    return initial;
  }

  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);
  const fallback = defaultAppConfig();

  return {
    version: 1,
    storage: {
      type: parsed.storage?.type === "local" ? "local" : fallback.storage.type,
      root:
        typeof parsed.storage?.root === "string" && parsed.storage.root.trim()
          ? parsed.storage.root
          : fallback.storage.root,
    },
    ffmpeg: {
      defaultSegmentDuration:
        typeof parsed.ffmpeg?.defaultSegmentDuration === "number"
          ? parsed.ffmpeg.defaultSegmentDuration
          : fallback.ffmpeg.defaultSegmentDuration,
    },
    streams: Array.isArray(parsed.streams) ? parsed.streams.map(normalizeStreamConfig) : [],
  };
}

async function saveAppConfig(config: AppConfig) {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

const stateFor = (id: string): RuntimeState => {
  const existing = runtime.get(id);
  if (existing) return existing;

  const state: RuntimeState = {
    status: "idle",
    process: null,
    metrics: defaultMetrics(),
    logs: [],
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    stopRequested: false,
  };
  runtime.set(id, state);
  return state;
};

const appendLog = (state: RuntimeState, line: string) => {
  const clean = line.trim();
  if (!clean) return;

  const isError = /(\berror\b|failed|invalid|unable to|non-monotonous|underflow)/i.test(clean);
  const isWarning =
    !isError && /\b(warning|deprecated|queue input is backward|timestamp|dts|pts)\b/i.test(clean);
  const isAudioIssue =
    /(audio|aac|aresample|sample|avfoundation.*audio|non-monotonous|timestamp|dts|pts|underflow|clipping|compensat|async)/i.test(
      clean,
    );

  if (isError) state.metrics.errors += 1;
  else if (isWarning) state.metrics.warnings += 1;

  if (isAudioIssue && (isError || isWarning)) {
    if (isError) state.metrics.audioErrors += 1;
    else state.metrics.audioWarnings += 1;
    state.metrics.lastAudioIssue = clean;
  }

  state.logs.push(clean);
  if (state.logs.length > 120) state.logs.splice(0, state.logs.length - 120);
};

const parseTimecode = (value: string) => {
  const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
};

const parseNumber = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const clampEvenNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const clamped = clampNumber(value, fallback, min, max);
  return Math.max(min, Math.round(clamped / 2) * 2);
};

const stringValue = (body: Record<string, unknown>, key: string, fallback = "") =>
  typeof body[key] === "string" ? body[key].trim() : fallback;

const nullableStringValue = (body: Record<string, unknown>, key: string) => {
  const value = stringValue(body, key);
  return value ? value : null;
};

const deviceInputPath = (device: DeviceInputConfig) =>
  `${device.videoId ?? "none"}:${device.audioId ?? "none"}`;

const deviceInputLabel = (device: DeviceInputConfig) => {
  const parts = [device.videoName, device.audioName].filter(Boolean);
  return parts.length > 0 ? parts.join(" + ") : "Live device";
};

const defaultEncodingConfig = (): EncodingConfig => ({
  videoEncoder: "auto",
  frameRate: 30,
  outputWidth: 1280,
  outputHeight: 720,
  videoBitrateKbps: 2500,
  videoMinrateKbps: 1800,
  videoMaxrateKbps: 3000,
  videoBufsizeKbps: 6000,
  audioBitrateKbps: 128,
  x264Preset: "veryfast",
});

const normalizeEncodingConfig = (encoding?: Partial<EncodingConfig> | null): EncodingConfig => {
  const defaults = defaultEncodingConfig();
  const videoEncoder =
    encoding?.videoEncoder === "h264_videotoolbox" || encoding?.videoEncoder === "libx264"
      ? encoding.videoEncoder
      : defaults.videoEncoder;
  const x264Preset =
    encoding?.x264Preset === "ultrafast" ||
    encoding?.x264Preset === "superfast" ||
    encoding?.x264Preset === "veryfast" ||
    encoding?.x264Preset === "faster" ||
    encoding?.x264Preset === "fast" ||
    encoding?.x264Preset === "medium"
      ? encoding.x264Preset
      : defaults.x264Preset;

  return {
    videoEncoder,
    frameRate: clampNumber(encoding?.frameRate, defaults.frameRate, 1, 60),
    outputWidth: clampEvenNumber(encoding?.outputWidth, defaults.outputWidth, 320, 3840),
    outputHeight: clampEvenNumber(encoding?.outputHeight, defaults.outputHeight, 240, 2160),
    videoBitrateKbps: clampNumber(
      encoding?.videoBitrateKbps,
      defaults.videoBitrateKbps,
      250,
      50000,
    ),
    videoMinrateKbps: clampNumber(encoding?.videoMinrateKbps, defaults.videoMinrateKbps, 0, 50000),
    videoMaxrateKbps: clampNumber(
      encoding?.videoMaxrateKbps,
      defaults.videoMaxrateKbps,
      250,
      80000,
    ),
    videoBufsizeKbps: clampNumber(
      encoding?.videoBufsizeKbps,
      defaults.videoBufsizeKbps,
      250,
      160000,
    ),
    audioBitrateKbps: clampNumber(encoding?.audioBitrateKbps, defaults.audioBitrateKbps, 32, 512),
    x264Preset,
  };
};

const normalizeStreamConfig = (config: StreamConfig): StreamConfig => ({
  ...config,
  inputKind: config.inputKind ?? "file",
  inputLabel: config.inputLabel ?? null,
  deviceInput: config.deviceInput ?? null,
  encoding: normalizeEncodingConfig(config.encoding),
});

function parseProgressLine(state: RuntimeState, line: string) {
  const separator = line.indexOf("=");
  if (separator === -1) return;

  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  const metrics = state.metrics;
  metrics.lastProgressAt = new Date().toISOString();

  if (key === "frame") metrics.frame = parseNumber(value);
  if (key === "fps") metrics.fps = parseNumber(value);
  if (key === "bitrate") metrics.bitrate = value === "N/A" ? null : value;
  if (key === "speed") metrics.speed = parseNumber(value.replace("x", ""));
  if (key === "total_size") metrics.totalSizeBytes = parseNumber(value);
  if (key === "drop_frames") metrics.droppedFrames = parseNumber(value);
  if (key === "dup_frames") metrics.duplicatedFrames = parseNumber(value);
  if (key === "out_time") metrics.encodedSeconds = parseTimecode(value) ?? metrics.encodedSeconds;
  if (key === "out_time_us") {
    const micros = parseNumber(value);
    if (micros !== null) metrics.encodedSeconds = micros / 1_000_000;
  }
  if (key === "progress") metrics.progress = value;
}

function parseStatsLine(state: RuntimeState, line: string) {
  const frame = line.match(/frame=\s*([0-9]+)/)?.[1];
  const fps = line.match(/fps=\s*([0-9.]+)/)?.[1];
  const bitrate = line.match(/bitrate=\s*([^\s]+)/)?.[1];
  const speed = line.match(/speed=\s*([0-9.]+)x/)?.[1];
  const time = line.match(/time=\s*([0-9:.]+)/)?.[1];

  if (frame) state.metrics.frame = Number(frame);
  if (fps) state.metrics.fps = Number(fps);
  if (bitrate && bitrate !== "N/A") state.metrics.bitrate = bitrate;
  if (speed) state.metrics.speed = Number(speed);
  if (time) state.metrics.encodedSeconds = parseTimecode(time) ?? state.metrics.encodedSeconds;
}

async function consumeLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
) {
  if (!stream) return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  }

  pending += decoder.decode();
  if (pending.trim()) onLine(pending);
}

async function readableToText(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }

  return output + decoder.decode();
}

function parseAvFoundationDevices(output: string) {
  let section: CaptureDevice["kind"] | null = null;
  const video: CaptureDevice[] = [];
  const audio: CaptureDevice[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.includes("AVFoundation video devices:")) {
      section = "video";
      continue;
    }
    if (line.includes("AVFoundation audio devices:")) {
      section = "audio";
      continue;
    }

    const match = line.match(/\s\[(\d+)\]\s+(.+)$/);
    if (!section || !match) continue;
    const [, id, name] = match;
    if (!id || !name) continue;

    const device: CaptureDevice = {
      id,
      name: name.trim(),
      kind: section,
      inputFormat: "avfoundation",
    };

    if (section === "video") video.push(device);
    else audio.push(device);
  }

  return { video, audio };
}

async function listCaptureInputs() {
  if (process.platform !== "darwin") {
    return {
      platform: process.platform,
      supported: false,
      video: [] as CaptureDevice[],
      audio: [] as CaptureDevice[],
      error: "Live input discovery currently supports macOS ffmpeg avfoundation devices.",
    };
  }

  try {
    const proc = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const timeout = setTimeout(() => proc.kill("SIGKILL"), 5000);
    const [stdout, stderr] = await Promise.all([
      readableToText(proc.stdout),
      readableToText(proc.stderr),
    ]);
    const exitCode = await proc.exited.catch(() => null);
    clearTimeout(timeout);

    const devices = parseAvFoundationDevices(`${stdout}\n${stderr}`);
    return {
      platform: "darwin",
      supported: true,
      inputFormat: "avfoundation",
      video: devices.video,
      audio: devices.audio,
      exitCode,
    };
  } catch (error) {
    return {
      platform: "darwin",
      supported: true,
      inputFormat: "avfoundation",
      video: [] as CaptureDevice[],
      audio: [] as CaptureDevice[],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const outputDirFor = (config: StreamConfig, streamRoot: string) =>
  safeJoin(streamRoot, config.outputSubdir);
const manifestPathFor = (config: StreamConfig, streamRoot: string) =>
  path.join(outputDirFor(config, streamRoot), config.manifestName);

const mediaUrlFor = (absolutePath: string, streamRoot: string) => {
  const relative = path.relative(streamRoot, absolutePath);
  return `/media/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
};

async function configuredStreamView(config: StreamConfig, streamRoot: string) {
  const state = stateFor(config.id);
  const manifestPath = manifestPathFor(config, streamRoot);
  const manifestExists = await fileExists(manifestPath);

  return {
    ...config,
    status: state.status,
    metrics: state.metrics,
    logs: state.logs,
    startedAt: state.startedAt,
    exitedAt: state.exitedAt,
    exitCode: state.exitCode,
    manifestUrl: manifestExists ? mediaUrlFor(manifestPath, streamRoot) : null,
    outputPath: outputDirFor(config, streamRoot),
  };
}

async function scanManifests(
  dir: string,
  depth = 0,
): Promise<Array<{ path: string; modifiedAt: string; size: number }>> {
  if (!(await fileExists(dir)) || depth > 5) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const manifests: Array<{ path: string; modifiedAt: string; size: number }> = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...(await scanManifests(fullPath, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith(".mpd")) {
      const info = await stat(fullPath);
      manifests.push({ path: fullPath, modifiedAt: info.mtime.toISOString(), size: info.size });
    }
  }

  return manifests;
}

async function listStreams() {
  const appConfig = await loadAppConfig();
  const streamRoot = streamRootFor(appConfig);
  const configs = appConfig.streams;
  const configured = await Promise.all(
    configs.map((config) => configuredStreamView(config, streamRoot)),
  );
  const discovered = await scanManifests(streamRoot);

  return {
    streamRoot,
    configPath,
    storage: appConfig.storage,
    configured,
    manifests: discovered
      .map((manifest) => {
        const relative = path.relative(streamRoot, manifest.path);
        const owner = configs.find(
          (config) => manifestPathFor(config, streamRoot) === manifest.path,
        );
        const ownerState = owner ? stateFor(owner.id) : null;
        return {
          id: owner?.id ?? `disk:${relative}`,
          name: owner?.name ?? relative,
          manifestUrl: mediaUrlFor(manifest.path, streamRoot),
          relativePath: relative,
          configured: Boolean(owner),
          modifiedAt: manifest.modifiedAt,
          size: manifest.size,
          status: ownerState ? ownerState.status : "idle",
          playbackVersion: ownerState?.startedAt ?? manifest.modifiedAt,
        };
      })
      .sort((a, b) => {
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
  };
}

function streamInputFromBody(body: Record<string, unknown>, current?: StreamConfig) {
  const inputKind: InputKind =
    body.inputKind === "device"
      ? "device"
      : body.inputKind === "file"
        ? "file"
        : (current?.inputKind ?? "file");

  if (inputKind === "device") {
    const platform =
      body.devicePlatform === "avfoundation"
        ? "avfoundation"
        : (current?.deviceInput?.platform ?? "avfoundation");
    const deviceInput: DeviceInputConfig = {
      platform,
      videoId: nullableStringValue(body, "deviceVideoId") ?? current?.deviceInput?.videoId ?? null,
      videoName:
        nullableStringValue(body, "deviceVideoName") ?? current?.deviceInput?.videoName ?? null,
      audioId: nullableStringValue(body, "deviceAudioId") ?? current?.deviceInput?.audioId ?? null,
      audioName:
        nullableStringValue(body, "deviceAudioName") ?? current?.deviceInput?.audioName ?? null,
    };

    if (!deviceInput.videoId && !deviceInput.audioId) {
      throw new Error("Select at least one live input device.");
    }

    return {
      inputKind,
      inputPath: deviceInputPath(deviceInput),
      inputLabel: deviceInputLabel(deviceInput),
      deviceInput,
    };
  }

  const inputPath = stringValue(body, "inputPath", current?.inputPath ?? "");
  if (!inputPath) throw new Error("Input path is required.");

  return {
    inputKind,
    inputPath: path.resolve(inputPath),
    inputLabel: null,
    deviceInput: null,
  };
}

function encodingFromBody(body: Record<string, unknown>, current?: StreamConfig) {
  const defaults = current?.encoding ?? defaultEncodingConfig();
  return normalizeEncodingConfig({
    videoEncoder:
      body.videoEncoder === "auto" ||
      body.videoEncoder === "h264_videotoolbox" ||
      body.videoEncoder === "libx264"
        ? body.videoEncoder
        : defaults.videoEncoder,
    frameRate: Number(body.frameRate ?? defaults.frameRate),
    outputWidth: Number(body.outputWidth ?? defaults.outputWidth),
    outputHeight: Number(body.outputHeight ?? defaults.outputHeight),
    videoBitrateKbps: Number(body.videoBitrateKbps ?? defaults.videoBitrateKbps),
    videoMinrateKbps: Number(body.videoMinrateKbps ?? defaults.videoMinrateKbps),
    videoMaxrateKbps: Number(body.videoMaxrateKbps ?? defaults.videoMaxrateKbps),
    videoBufsizeKbps: Number(body.videoBufsizeKbps ?? defaults.videoBufsizeKbps),
    audioBitrateKbps: Number(body.audioBitrateKbps ?? defaults.audioBitrateKbps),
    x264Preset:
      body.x264Preset === "ultrafast" ||
      body.x264Preset === "superfast" ||
      body.x264Preset === "veryfast" ||
      body.x264Preset === "faster" ||
      body.x264Preset === "fast" ||
      body.x264Preset === "medium"
        ? body.x264Preset
        : defaults.x264Preset,
  });
}

async function createStream(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Expected a JSON request body." }, { status: 400 });
  }

  const bodyRecord = body as Record<string, unknown>;
  const name = stringValue(bodyRecord, "name");
  const outputSubdirInput = stringValue(bodyRecord, "outputSubdir", name);
  const appConfig = await loadAppConfig();
  const streamRoot = streamRootFor(appConfig);
  const segmentDuration = Number(
    bodyRecord.segmentDuration ?? appConfig.ffmpeg.defaultSegmentDuration,
  );
  let inputConfig: ReturnType<typeof streamInputFromBody>;

  if (!name) return json({ error: "Stream name is required." }, { status: 400 });
  try {
    inputConfig = streamInputFromBody(bodyRecord);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  if (!Number.isFinite(segmentDuration) || segmentDuration < 1 || segmentDuration > 30) {
    return json({ error: "Segment duration must be between 1 and 30 seconds." }, { status: 400 });
  }

  const outputSubdir = slugify(outputSubdirInput) || slugify(name) || crypto.randomUUID();
  const id = outputSubdir;
  const configs = appConfig.streams;
  if (configs.some((config) => config.id === id)) {
    return json({ error: "A stream with that output directory already exists." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const config: StreamConfig = {
    id,
    name,
    ...inputConfig,
    outputSubdir,
    manifestName: "manifest.mpd",
    segmentDuration,
    encoding: encodingFromBody(bodyRecord),
    storageTarget: "local",
    createdAt: now,
    updatedAt: now,
  };

  safeJoin(streamRoot, outputSubdir);
  configs.push(config);
  await saveAppConfig({ ...appConfig, streams: configs });

  return json({ stream: await configuredStreamView(config, streamRoot) }, { status: 201 });
}

async function updateStream(id: string, req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Expected a JSON request body." }, { status: 400 });
  }

  const appConfig = await loadAppConfig();
  const streamRoot = streamRootFor(appConfig);
  const configs = appConfig.streams;
  const index = configs.findIndex((config) => config.id === id);
  if (index === -1) return json({ error: "Stream not found." }, { status: 404 });

  const bodyRecord = body as Record<string, unknown>;
  const current = configs[index]!;
  const name = stringValue(bodyRecord, "name", current.name);
  const segmentDuration = Number(bodyRecord.segmentDuration ?? current.segmentDuration);
  let inputConfig: ReturnType<typeof streamInputFromBody>;

  if (!name) return json({ error: "Stream name is required." }, { status: 400 });
  try {
    inputConfig = streamInputFromBody(bodyRecord, current);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  if (!Number.isFinite(segmentDuration) || segmentDuration < 1 || segmentDuration > 30) {
    return json({ error: "Segment duration must be between 1 and 30 seconds." }, { status: 400 });
  }

  const updated: StreamConfig = {
    ...current,
    name,
    ...inputConfig,
    segmentDuration,
    encoding: encodingFromBody(bodyRecord, current),
    updatedAt: new Date().toISOString(),
  };
  configs[index] = updated;
  await saveAppConfig({ ...appConfig, streams: configs });

  return json({ stream: await configuredStreamView(updated, streamRoot) });
}

async function deleteStream(id: string) {
  const state = stateFor(id);
  if (state.process)
    return json({ error: "Stop the ffmpeg process before deleting this config." }, { status: 409 });

  const appConfig = await loadAppConfig();
  const configs = appConfig.streams;
  const next = configs.filter((config) => config.id !== id);
  if (next.length === configs.length) return json({ error: "Stream not found." }, { status: 404 });

  await saveAppConfig({ ...appConfig, streams: next });
  runtime.delete(id);
  return json({ ok: true });
}

async function clearStreamMedia(id: string) {
  const state = stateFor(id);
  if (state.process) {
    return json(
      { error: "Stop the ffmpeg process before deleting generated media." },
      { status: 409 },
    );
  }

  const appConfig = await loadAppConfig();
  const streamRoot = streamRootFor(appConfig);
  const config = appConfig.streams.find((stream) => stream.id === id);
  if (!config) return json({ error: "Stream not found." }, { status: 404 });

  const outputDir = outputDirFor(config, streamRoot);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  return json({ ok: true, outputPath: outputDir });
}

async function startStream(id: string) {
  const appConfig = await loadAppConfig();
  const streamRoot = streamRootFor(appConfig);
  const config = appConfig.streams.find((stream) => stream.id === id);
  if (!config) return json({ error: "Stream not found." }, { status: 404 });

  const state = stateFor(id);
  if (state.process)
    return json({ error: "ffmpeg is already running for this stream." }, { status: 409 });
  if (config.inputKind === "file" && !(await fileExists(config.inputPath))) {
    return json({ error: `Input file does not exist: ${config.inputPath}` }, { status: 400 });
  }
  if (config.inputKind === "device" && config.deviceInput?.platform !== "avfoundation") {
    return json({ error: "Unsupported live input platform." }, { status: 400 });
  }
  if (config.inputKind === "device" && process.platform !== "darwin") {
    return json(
      { error: "Live device capture currently requires macOS ffmpeg avfoundation support." },
      { status: 400 },
    );
  }

  const outputDir = outputDirFor(config, streamRoot);
  await mkdir(outputDir, { recursive: true });

  state.status = "starting";
  state.metrics = defaultMetrics();
  state.logs = [];
  state.startedAt = new Date().toISOString();
  state.exitedAt = null;
  state.exitCode = null;
  state.stopRequested = false;

  const segmentRunId = state.startedAt.replace(/[^0-9]/g, "");
  const inputArgs =
    config.inputKind === "device"
      ? [
          "-thread_queue_size",
          "512",
          "-f",
          "avfoundation",
          "-framerate",
          String(config.encoding.frameRate),
          "-video_size",
          `${config.encoding.outputWidth}x${config.encoding.outputHeight}`,
          "-i",
          config.inputPath,
        ]
      : ["-i", config.inputPath];
  const selectedVideoEncoder =
    config.encoding.videoEncoder === "auto"
      ? config.inputKind === "device" && process.platform === "darwin"
        ? "h264_videotoolbox"
        : "libx264"
      : config.encoding.videoEncoder;
  const liveGopSize = String(
    Math.max(1, Math.round(config.segmentDuration * config.encoding.frameRate)),
  );
  const manifestUpdatePeriod = String(Math.max(1, Math.floor(config.segmentDuration / 2)));
  const videoTimingArgs =
    config.inputKind === "device" && config.deviceInput?.videoId
      ? [
          "-vf",
          `fps=${config.encoding.frameRate},scale=${config.encoding.outputWidth}:${config.encoding.outputHeight}:force_original_aspect_ratio=decrease,pad=${config.encoding.outputWidth}:${config.encoding.outputHeight}:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setpts=PTS-STARTPTS`,
          "-r",
          String(config.encoding.frameRate),
        ]
      : [];
  const videoEncodeArgs =
    selectedVideoEncoder === "h264_videotoolbox" && config.deviceInput?.videoId
      ? [
          "-c:v",
          "h264_videotoolbox",
          "-realtime",
          "1",
          "-prio_speed",
          "1",
          "-allow_sw",
          "1",
          "-profile:v",
          "main",
          "-level:v",
          "4.0",
          "-b:v",
          `${config.encoding.videoBitrateKbps}k`,
          "-minrate",
          `${config.encoding.videoMinrateKbps}k`,
          "-maxrate",
          `${config.encoding.videoMaxrateKbps}k`,
          "-bufsize",
          `${config.encoding.videoBufsizeKbps}k`,
          "-g",
          liveGopSize,
        ]
      : [
          "-c:v",
          "libx264",
          "-preset",
          config.encoding.x264Preset,
          "-tune",
          "zerolatency",
          "-b:v",
          `${config.encoding.videoBitrateKbps}k`,
          "-minrate",
          `${config.encoding.videoMinrateKbps}k`,
          "-maxrate",
          `${config.encoding.videoMaxrateKbps}k`,
          "-bufsize",
          `${config.encoding.videoBufsizeKbps}k`,
          "-g",
          liveGopSize,
        ];
  const audioEncodeArgs =
    config.inputKind === "device" && config.deviceInput?.audioId
      ? [
          "-af",
          "aresample=async=1:first_pts=0",
          "-c:a",
          "aac",
          "-b:a",
          `${config.encoding.audioBitrateKbps}k`,
          "-ar",
          "48000",
          "-ac",
          "2",
        ]
      : ["-c:a", "aac"];
  const keyframeArgs =
    config.inputKind === "device" && config.deviceInput?.videoId
      ? ["-force_key_frames", `expr:gte(t,n_forced*${config.segmentDuration})`]
      : [];

  const args = [
    "-hide_banner",
    "-y",
    ...inputArgs,
    ...videoTimingArgs,
    ...videoEncodeArgs,
    ...audioEncodeArgs,
    ...keyframeArgs,
    "-sc_threshold",
    "0",
    "-progress",
    "pipe:1",
    "-f",
    "dash",
    "-seg_duration",
    String(config.segmentDuration),
    "-update_period",
    manifestUpdatePeriod,
    "-use_template",
    "1",
    "-use_timeline",
    "1",
    "-init_seg_name",
    `init-${segmentRunId}-stream$RepresentationID$.$ext$`,
    "-media_seg_name",
    `chunk-${segmentRunId}-stream$RepresentationID$-$Number%05d$.$ext$`,
    manifestPathFor(config, streamRoot),
  ];

  try {
    const proc = Bun.spawn(["ffmpeg", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    state.process = proc;
    state.status = "running";
    appendLog(state, `ffmpeg ${args.join(" ")}`);

    void consumeLines(proc.stdout, (line) => parseProgressLine(state, line));
    void consumeLines(proc.stderr, (line) => {
      appendLog(state, line);
      parseStatsLine(state, line);
    });

    void proc.exited.then((exitCode) => {
      state.process = null;
      state.exitCode = exitCode;
      state.exitedAt = new Date().toISOString();
      if (state.stopRequested) state.status = "stopped";
      else state.status = exitCode === 0 ? "completed" : "failed";
      appendLog(state, `ffmpeg exited with code ${exitCode}`);
    });
  } catch (error) {
    state.process = null;
    state.status = "failed";
    state.exitedAt = new Date().toISOString();
    appendLog(state, error instanceof Error ? error.message : String(error));
    return json(
      { error: "Failed to start ffmpeg. Make sure ffmpeg is installed and on PATH." },
      { status: 500 },
    );
  }

  return json({ stream: await configuredStreamView(config, streamRoot) });
}

async function stopStream(id: string) {
  const state = stateFor(id);
  if (!state.process)
    return json({ error: "No ffmpeg process is running for this stream." }, { status: 409 });

  state.stopRequested = true;
  state.status = "stopped";
  state.process.kill("SIGTERM");
  const proc = state.process;
  setTimeout(() => {
    if (state.process === proc) proc.kill("SIGKILL");
  }, 5000);

  return json({ ok: true });
}

async function serveMedia(req: Request) {
  const appConfig = await loadAppConfig();
  const streamRoot = streamRootFor(appConfig);
  const url = new URL(req.url);
  const relative = url.pathname
    .slice("/media/".length)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join(path.sep);

  let filePath: string;
  try {
    filePath = safeJoin(streamRoot, relative);
  } catch {
    return new Response("Invalid media path", { status: 400 });
  }

  if (!(await fileExists(filePath))) return new Response("Not found", { status: 404 });

  const ext = path.extname(filePath);
  const type =
    ext === ".mpd"
      ? "application/dash+xml"
      : ext === ".m4s"
        ? "video/iso.segment"
        : ext === ".mp4" || ext === ".m4a"
          ? "video/mp4"
          : "application/octet-stream";

  return new Response(Bun.file(filePath), {
    headers: {
      "content-type": type,
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

const server = serve({
  routes: {
    "/api/streams": {
      GET: async () => json(await listStreams()),
      POST: createStream,
    },
    "/api/streams/:id": {
      PUT: (req) => updateStream(req.params.id, req),
      DELETE: (req) => deleteStream(req.params.id),
    },
    "/api/streams/:id/start": {
      POST: (req) => startStream(req.params.id),
    },
    "/api/streams/:id/stop": {
      POST: (req) => stopStream(req.params.id),
    },
    "/api/streams/:id/media": {
      DELETE: (req) => clearStreamMedia(req.params.id),
    },
    "/api/inputs": {
      GET: async () => json(await listCaptureInputs()),
    },
    "/media/*": serveMedia,
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
console.log(`Stream config: ${configPath}`);
