export type StreamStatus = "idle" | "starting" | "running" | "completed" | "failed" | "stopped";
export type InputKind = "file" | "device";
export type VideoEncoder = "auto" | "h264_videotoolbox" | "libx264";
export type X264Preset = "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium";

export type CaptureDevice = {
  id: string;
  name: string;
  kind: "video" | "audio";
  inputFormat: "avfoundation";
};

export type ManifestProbe = {
  status: "idle" | "checking" | "ok" | "error";
  checkedAt: string | null;
  httpStatus?: number;
  contentType?: string | null;
  sizeBytes?: number | null;
  error?: string | null;
  preview?: string | null;
};

export type EncodingConfig = {
  videoEncoder: VideoEncoder;
  frameRate: number;
  outputWidth: number;
  outputHeight: number;
  videoBitrateKbps: number;
  videoMinrateKbps: number;
  videoMaxrateKbps: number;
  videoBufsizeKbps: number;
  audioBitrateKbps: number;
  x264Preset: X264Preset;
};

export type StreamMetrics = {
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
  lastProgressAt: string | null;
};

export type ConfiguredStream = {
  id: string;
  name: string;
  inputKind: InputKind;
  inputPath: string;
  inputLabel: string | null;
  deviceInput: {
    platform: "avfoundation";
    videoId: string | null;
    videoName: string | null;
    audioId: string | null;
    audioName: string | null;
  } | null;
  outputSubdir: string;
  manifestName: string;
  segmentDuration: number;
  encoding: EncodingConfig;
  storageTarget: "local";
  createdAt: string;
  updatedAt: string;
  status: StreamStatus;
  metrics: StreamMetrics;
  logs: string[];
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  manifestUrl: string | null;
  outputPath: string;
};

export type ManifestOption = {
  id: string;
  name: string;
  manifestUrl: string;
  relativePath: string;
  configured: boolean;
  modifiedAt: string;
  size: number;
  status: StreamStatus;
  playbackVersion: string;
};
