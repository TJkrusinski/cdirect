import { type ConfiguredStream, type ManifestOption, type CaptureDevice } from "@/types/stream";

export type StreamsResponse = {
  streamRoot: string;
  configPath: string;
  storage: {
    type: "local";
    root: string;
  };
  configured: ConfiguredStream[];
  manifests: ManifestOption[];
};

export type CaptureInputsResponse = {
  platform: string;
  supported: boolean;
  inputFormat?: "avfoundation";
  video: CaptureDevice[];
  audio: CaptureDevice[];
  error?: string;
};
