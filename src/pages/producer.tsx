import { useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  Camera,
  Copy,
  FileVideo,
  Gauge,
  Mic,
  Minus,
  MonitorPlay,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";

import {
  type InputKind,
  type X264Preset,
  type VideoEncoder,
  type ConfiguredStream,
} from "@/types/stream";

import { type CaptureInputsResponse } from "@/types/api";

import StatusPill from "@/components/ui/status-pill";
import Metric from "@/components/ui/metric";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import EncodingSpeedDiagnostic from "@/components/encoding-diagnostic";

import { formatBytes, formatSeconds } from "@/lib/utils";

type FormState = {
  name: string;
  inputKind: InputKind;
  inputPath: string;
  deviceVideoId: string;
  deviceVideoName: string;
  deviceAudioId: string;
  deviceAudioName: string;
  outputSubdir: string;
  segmentDuration: string;
  videoEncoder: VideoEncoder;
  frameRate: string;
  outputWidth: string;
  outputHeight: string;
  videoBitrateKbps: string;
  videoMinrateKbps: string;
  videoMaxrateKbps: string;
  videoBufsizeKbps: string;
  audioBitrateKbps: string;
  x264Preset: X264Preset;
};

const emptyForm: FormState = {
  name: "",
  inputKind: "device",
  inputPath: "",
  deviceVideoId: "",
  deviceVideoName: "",
  deviceAudioId: "",
  deviceAudioName: "",
  outputSubdir: "",
  segmentDuration: "2",
  videoEncoder: "auto",
  frameRate: "30",
  outputWidth: "1280",
  outputHeight: "720",
  videoBitrateKbps: "2500",
  videoMinrateKbps: "1800",
  videoMaxrateKbps: "3000",
  videoBufsizeKbps: "6000",
  audioBitrateKbps: "128",
  x264Preset: "veryfast",
};

export default function Producer({
  streams,
  streamRoot,
  configPath,
  inputs,
  inputsLoading,
  inputsError,
  onRefresh,
  onRefreshInputs,
}: {
  streams: ConfiguredStream[];
  streamRoot: string;
  configPath: string;
  inputs: CaptureInputsResponse | null;
  inputsLoading: boolean;
  inputsError: string | null;
  onRefresh: () => Promise<void>;
  onRefreshInputs: () => Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [selectedId, setSelectedId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = streams.find((stream) => stream.id === selectedId) ?? streams[0];
  const selectedStreamUrl = selected?.manifestUrl
    ? `${window.location.origin}${selected.manifestUrl}`
    : null;

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setForm({
      name: selected.name,
      inputKind: selected.inputKind ?? "file",
      inputPath: selected.inputPath,
      deviceVideoId: selected.deviceInput?.videoId ?? "",
      deviceVideoName: selected.deviceInput?.videoName ?? "",
      deviceAudioId: selected.deviceInput?.audioId ?? "",
      deviceAudioName: selected.deviceInput?.audioName ?? "",
      outputSubdir: selected.outputSubdir,
      segmentDuration: String(selected.segmentDuration),
      videoEncoder: selected.encoding.videoEncoder,
      frameRate: String(selected.encoding.frameRate),
      outputWidth: String(selected.encoding.outputWidth),
      outputHeight: String(selected.encoding.outputHeight),
      videoBitrateKbps: String(selected.encoding.videoBitrateKbps),
      videoMinrateKbps: String(selected.encoding.videoMinrateKbps),
      videoMaxrateKbps: String(selected.encoding.videoMaxrateKbps),
      videoBufsizeKbps: String(selected.encoding.videoBufsizeKbps),
      audioBitrateKbps: String(selected.encoding.audioBitrateKbps),
      x264Preset: selected.encoding.x264Preset,
    });
  }, [selected?.id]);

  const resetForm = () => {
    setSelectedId("");
    setForm(emptyForm);
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const payload = {
      name: form.name,
      inputKind: form.inputKind,
      inputPath: form.inputPath,
      devicePlatform: "avfoundation",
      deviceVideoId: form.deviceVideoId,
      deviceVideoName: form.deviceVideoName,
      deviceAudioId: form.deviceAudioId,
      deviceAudioName: form.deviceAudioName,
      outputSubdir: form.outputSubdir,
      segmentDuration: Number(form.segmentDuration),
      videoEncoder: form.videoEncoder,
      frameRate: Number(form.frameRate),
      outputWidth: Number(form.outputWidth),
      outputHeight: Number(form.outputHeight),
      videoBitrateKbps: Number(form.videoBitrateKbps),
      videoMinrateKbps: Number(form.videoMinrateKbps),
      videoMaxrateKbps: Number(form.videoMaxrateKbps),
      videoBufsizeKbps: Number(form.videoBufsizeKbps),
      audioBitrateKbps: Number(form.audioBitrateKbps),
      x264Preset: form.x264Preset,
    };

    try {
      const response = await fetch(selectedId ? `/api/streams/${selectedId}` : "/api/streams", {
        method: selectedId ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Failed to save stream.");
      setSelectedId(body.stream.id);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const action = async (path: string, method = "POST") => {
    setError(null);
    const response = await fetch(path, { method });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error ?? "Request failed.");
      return;
    }
    await onRefresh();
  };

  const clearMedia = async (stream: ConfiguredStream) => {
    const confirmed = window.confirm(
      `Delete generated segments and manifests for "${stream.name}"?`,
    );
    if (!confirmed) return;
    await action(`/api/streams/${stream.id}/media`, "DELETE");
  };

  const bitrateBoundsForTarget = (target: number) => ({
    min: Math.max(0, Math.round(target * 0.75)),
    max: Math.round(target * 1.2),
    buffer: Math.round(target * 2.4),
  });

  const setVideoBitrateTarget = (value: string) => {
    setForm((current) => {
      const target = Number(value);
      if (!Number.isFinite(target)) return { ...current, videoBitrateKbps: value };
      const boundedTarget = Math.min(50000, Math.max(250, target));
      const bounds = bitrateBoundsForTarget(boundedTarget);
      return {
        ...current,
        videoBitrateKbps: String(boundedTarget),
        videoMinrateKbps: String(bounds.min),
        videoMaxrateKbps: String(bounds.max),
        videoBufsizeKbps: String(bounds.buffer),
      };
    });
  };

  const adjustVideoBitrate = (delta: number) => {
    setForm((current) => {
      const currentBitrate = Number(current.videoBitrateKbps) || 2500;
      const nextBitrate = Math.min(50000, Math.max(250, currentBitrate + delta));
      const bounds = bitrateBoundsForTarget(nextBitrate);
      return {
        ...current,
        videoBitrateKbps: String(nextBitrate),
        videoMinrateKbps: String(bounds.min),
        videoMaxrateKbps: String(bounds.max),
        videoBufsizeKbps: String(bounds.buffer),
      };
    });
  };

  const adjustAudioBitrate = (delta: number) => {
    setForm((current) => {
      const currentBitrate = Number(current.audioBitrateKbps) || 128;
      const nextBitrate = Math.min(512, Math.max(32, currentBitrate + delta));
      return { ...current, audioBitrateKbps: String(nextBitrate) };
    });
  };

  const applyOutputPreset = (width: number, height: number) => {
    setForm((current) => ({
      ...current,
      outputWidth: String(width),
      outputHeight: String(height),
    }));
  };

  const videoDevices = inputs?.video ?? [];
  const audioDevices = inputs?.audio ?? [];
  const selectVideoDevice = (id: string) => {
    if (id === "__none__") {
      setForm((current) => ({ ...current, deviceVideoId: "", deviceVideoName: "" }));
      return;
    }
    const device = videoDevices.find((item) => item.id === id);
    setForm((current) => ({ ...current, deviceVideoId: id, deviceVideoName: device?.name ?? "" }));
  };
  const selectAudioDevice = (id: string) => {
    if (id === "__none__") {
      setForm((current) => ({ ...current, deviceAudioId: "", deviceAudioName: "" }));
      return;
    }
    const device = audioDevices.find((item) => item.id === id);
    setForm((current) => ({ ...current, deviceAudioId: id, deviceAudioName: device?.name ?? "" }));
  };

  return (
    <section className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
      <form onSubmit={submit} className="rounded-md border border-zinc-200 bg-white p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-950">Producer</h2>
            <p className="text-xs text-zinc-500">Config: {configPath}</p>
            <p className="mt-0.5 text-xs text-zinc-500">Local output root: {streamRoot}</p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={resetForm}
            title="New stream"
          >
            <Plus />
          </Button>
        </div>

        {streams.length > 0 && (
          <div className="mb-4">
            <Label htmlFor="stream-select">Configured stream</Label>
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger id="stream-select" className="mt-2 w-full">
                <SelectValue placeholder="New stream" />
              </SelectTrigger>
              <SelectContent>
                {streams.map((stream) => (
                  <SelectItem key={stream.id} value={stream.id}>
                    {stream.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <Label htmlFor="stream-name">Name</Label>
            <Input
              id="stream-name"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Main stage"
              className="mt-2"
            />
          </div>
          <div>
            <Label>Input source</Label>
            <div className="mt-2 grid grid-cols-2 gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-1">
              <Button
                type="button"
                variant={form.inputKind === "file" ? "default" : "ghost"}
                className="rounded"
                onClick={() => setForm((current) => ({ ...current, inputKind: "file" }))}
              >
                <FileVideo />
                File
              </Button>
              <Button
                type="button"
                variant={form.inputKind === "device" ? "default" : "ghost"}
                className="rounded"
                onClick={() => setForm((current) => ({ ...current, inputKind: "device" }))}
              >
                <Camera />
                Live
              </Button>
            </div>
          </div>

          {form.inputKind === "file" ? (
            <div>
              <Label htmlFor="input-path">Input file path</Label>
              <Input
                id="input-path"
                value={form.inputPath}
                onChange={(event) =>
                  setForm((current) => ({ ...current, inputPath: event.target.value }))
                }
                placeholder="/Users/me/video/input.mp4"
                className="mt-2 font-mono text-xs"
              />
            </div>
          ) : (
            <div className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-zinc-950">Live inputs</div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={onRefreshInputs}
                  title="Refresh live inputs"
                >
                  <RefreshCw />
                </Button>
              </div>

              {inputsError && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                  {inputsError}
                </div>
              )}

              {!inputs?.supported && !inputsLoading && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                  {inputs?.error ?? "Live input discovery is not supported on this platform yet."}
                </div>
              )}

              <div>
                <Label htmlFor="video-device" className="flex items-center gap-2">
                  <Camera className="size-3.5" />
                  Camera or capture card
                </Label>
                <Select value={form.deviceVideoId || "__none__"} onValueChange={selectVideoDevice}>
                  <SelectTrigger id="video-device" className="mt-2 w-full">
                    <SelectValue placeholder={inputsLoading ? "Scanning" : "Select video input"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {videoDevices.map((device) => (
                      <SelectItem key={device.id} value={device.id}>
                        {device.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="audio-device" className="flex items-center gap-2">
                  <Mic className="size-3.5" />
                  Microphone
                </Label>
                <Select value={form.deviceAudioId || "__none__"} onValueChange={selectAudioDevice}>
                  <SelectTrigger id="audio-device" className="mt-2 w-full">
                    <SelectValue placeholder={inputsLoading ? "Scanning" : "Select microphone"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {audioDevices.map((device) => (
                      <SelectItem key={device.id} value={device.id}>
                        {device.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
            <div>
              <Label htmlFor="output-dir">Output directory</Label>
              <Input
                id="output-dir"
                value={form.outputSubdir}
                onChange={(event) =>
                  setForm((current) => ({ ...current, outputSubdir: event.target.value }))
                }
                placeholder="main-stage"
                className="mt-2"
                disabled={Boolean(selectedId)}
              />
            </div>
            <div>
              <Label htmlFor="segment-duration">Segment length</Label>
              <Input
                id="segment-duration"
                type="number"
                min="1"
                max="30"
                value={form.segmentDuration}
                onChange={(event) =>
                  setForm((current) => ({ ...current, segmentDuration: event.target.value }))
                }
                className="mt-2"
              />
              <div className="mt-1 text-xs text-zinc-500">Seconds</div>
            </div>
          </div>

          <div className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
            <div>
              <div className="text-sm font-medium text-zinc-950">Encoding</div>
              <div className="mt-0.5 text-xs text-zinc-500">
                Defaults are tuned for realtime local capture.
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="video-encoder">Encoder</Label>
                <Select
                  value={form.videoEncoder}
                  onValueChange={(value) =>
                    setForm((current) => ({ ...current, videoEncoder: value as VideoEncoder }))
                  }
                >
                  <SelectTrigger id="video-encoder" className="mt-2 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="h264_videotoolbox">VideoToolbox</SelectItem>
                    <SelectItem value="libx264">x264</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="x264-preset">x264 preset</Label>
                <Select
                  value={form.x264Preset}
                  onValueChange={(value) =>
                    setForm((current) => ({ ...current, x264Preset: value as X264Preset }))
                  }
                >
                  <SelectTrigger id="x264-preset" className="mt-2 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ultrafast">ultrafast</SelectItem>
                    <SelectItem value="superfast">superfast</SelectItem>
                    <SelectItem value="veryfast">veryfast</SelectItem>
                    <SelectItem value="faster">faster</SelectItem>
                    <SelectItem value="fast">fast</SelectItem>
                    <SelectItem value="medium">medium</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="frame-rate">FPS</Label>
                <Input
                  id="frame-rate"
                  type="number"
                  min="1"
                  max="60"
                  value={form.frameRate}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, frameRate: event.target.value }))
                  }
                  className="mt-2"
                />
              </div>
              <div>
                <Label htmlFor="output-width">Width</Label>
                <Input
                  id="output-width"
                  type="number"
                  min="320"
                  max="3840"
                  step="2"
                  value={form.outputWidth}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, outputWidth: event.target.value }))
                  }
                  className="mt-2"
                />
              </div>
              <div>
                <Label htmlFor="output-height">Height</Label>
                <Input
                  id="output-height"
                  type="number"
                  min="240"
                  max="2160"
                  step="2"
                  value={form.outputHeight}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, outputHeight: event.target.value }))
                  }
                  className="mt-2"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" onClick={() => applyOutputPreset(1280, 720)}>
                720p landscape
              </Button>
              <Button type="button" variant="outline" onClick={() => applyOutputPreset(720, 1280)}>
                720p portrait
              </Button>
              <Button type="button" variant="outline" onClick={() => applyOutputPreset(1920, 1080)}>
                1080p landscape
              </Button>
              <Button type="button" variant="outline" onClick={() => applyOutputPreset(1080, 1920)}>
                1080p portrait
              </Button>
            </div>

            <div>
              <Label htmlFor="video-bitrate">Video bitrate</Label>
              <div className="mt-2 grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => adjustVideoBitrate(-500)}
                >
                  <Minus />
                </Button>
                <Input
                  id="video-bitrate"
                  type="number"
                  min="250"
                  max="50000"
                  step="250"
                  value={form.videoBitrateKbps}
                  onChange={(event) => setVideoBitrateTarget(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => adjustVideoBitrate(500)}
                >
                  <Plus />
                </Button>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div>
                  <Label htmlFor="video-minrate">Minimum</Label>
                  <Input
                    id="video-minrate"
                    type="number"
                    min="0"
                    max="50000"
                    step="250"
                    value={form.videoMinrateKbps}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, videoMinrateKbps: event.target.value }))
                    }
                    className="mt-2"
                  />
                </div>
                <div>
                  <Label htmlFor="video-maxrate">Maximum</Label>
                  <Input
                    id="video-maxrate"
                    type="number"
                    min="250"
                    max="80000"
                    step="250"
                    value={form.videoMaxrateKbps}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, videoMaxrateKbps: event.target.value }))
                    }
                    className="mt-2"
                  />
                </div>
                <div>
                  <Label htmlFor="video-buffer">Buffer</Label>
                  <Input
                    id="video-buffer"
                    type="number"
                    min="250"
                    max="160000"
                    step="250"
                    value={form.videoBufsizeKbps}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, videoBufsizeKbps: event.target.value }))
                    }
                    className="mt-2"
                  />
                </div>
              </div>
            </div>

            <div>
              <Label htmlFor="audio-bitrate">Audio bitrate</Label>
              <div className="mt-2 grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => adjustAudioBitrate(-32)}
                >
                  <Minus />
                </Button>
                <Input
                  id="audio-bitrate"
                  type="number"
                  min="32"
                  max="512"
                  step="32"
                  value={form.audioBitrateKbps}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, audioBitrateKbps: event.target.value }))
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => adjustAudioBitrate(32)}
                >
                  <Plus />
                </Button>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {error}
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving" : selectedId ? "Save" : "Create"}
          </Button>
          {selected && (
            <>
              {selected.status === "running" || selected.status === "starting" ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => action(`/api/streams/${selected.id}/stop`)}
                >
                  <Square />
                  Stop
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => action(`/api/streams/${selected.id}/start`)}
                >
                  <Play />
                  Start
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => clearMedia(selected)}
                disabled={selected.status === "running" || selected.status === "starting"}
                title="Delete generated segments and manifests"
              >
                <Trash2 />
                Clear media
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => action(`/api/streams/${selected.id}`, "DELETE")}
                title="Delete config"
              >
                <Trash2 />
              </Button>
            </>
          )}
        </div>
      </form>

      <div className="min-w-0 rounded-md border border-zinc-200 bg-white p-4">
        {selected ? (
          <>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-zinc-950">
                    {selected.name}
                  </h2>
                  <StatusPill status={selected.status} />
                </div>
                <p className="mt-1 truncate text-xs text-zinc-500">{selected.outputPath}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={onRefresh}
                title="Refresh"
              >
                <RefreshCw />
              </Button>
            </div>

            <div className="mb-4 rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="mb-2 text-xs font-medium uppercase text-zinc-500">
                DASH stream URL
              </div>
              {selectedStreamUrl ? (
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="truncate rounded border border-zinc-200 bg-white px-3 py-2 font-mono text-xs text-zinc-800">
                    {selectedStreamUrl}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void navigator.clipboard.writeText(selectedStreamUrl)}
                  >
                    <Copy />
                    Copy
                  </Button>
                </div>
              ) : (
                <div className="text-sm text-zinc-500">
                  Start the stream or generate media to create a manifest URL.
                </div>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                label="Encoded"
                value={formatSeconds(selected.metrics.encodedSeconds)}
                icon={Activity}
              />
              <Metric
                label="Speed"
                value={selected.metrics.speed ? `${selected.metrics.speed.toFixed(2)}x` : "-"}
                icon={Gauge}
              />
              <Metric
                label="FPS"
                value={selected.metrics.fps?.toFixed(1) ?? "-"}
                icon={FileVideo}
              />
              <Metric
                label="Size"
                value={formatBytes(selected.metrics.totalSizeBytes)}
                icon={MonitorPlay}
              />
              <Metric
                label="Frame"
                value={selected.metrics.frame?.toLocaleString() ?? "-"}
                icon={FileVideo}
              />
              <Metric label="Bitrate" value={selected.metrics.bitrate ?? "-"} icon={Gauge} />
              <Metric
                label="Dropped"
                value={selected.metrics.droppedFrames?.toLocaleString() ?? "0"}
                icon={AlertTriangle}
              />
              <Metric
                label="Warnings"
                value={`${selected.metrics.warnings} / ${selected.metrics.errors} errors`}
                icon={AlertTriangle}
              />
            </div>

            <EncodingSpeedDiagnostic stream={selected} />

            <div className="mt-4 rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
              <div className="mb-2 flex items-center justify-between text-zinc-400">
                <span>ffmpeg output</span>
                <span>
                  {selected.exitCode === null ? "active session" : `exit ${selected.exitCode}`}
                </span>
              </div>
              <div className="max-h-72 space-y-1 overflow-auto">
                {selected.logs.length > 0 ? (
                  selected.logs.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)
                ) : (
                  <div className="text-zinc-500">No ffmpeg output yet.</div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="grid min-h-64 place-items-center text-sm text-zinc-500">
            Create a stream config to start monitoring ffmpeg.
          </div>
        )}
      </div>
    </section>
  );
}
