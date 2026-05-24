import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
import DashStreamPlayer from "@/components/dash-stream-player";
import EncodingSpeedDiagnostic from "@/components/encoding-diagnostic";
import StreamDiagnosticsPanel from "@/components/stream-diagnostics-panel";
import { PlayerProvider } from "@/contexts/player-context";

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

function slugifyStreamSegment(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "stream"
  );
}

function streamRouteSegment(stream: ConfiguredStream, streams: ConfiguredStream[]) {
  const nameSlug = slugifyStreamSegment(stream.name);
  const duplicateName = streams.some(
    (candidate) => candidate.id !== stream.id && slugifyStreamSegment(candidate.name) === nameSlug,
  );

  if (!duplicateName) {
    return nameSlug;
  }

  return `${nameSlug}--${slugifyStreamSegment(stream.id)}`;
}

function findStreamByRouteSegment(streams: ConfiguredStream[], streamName: string | undefined) {
  if (!streamName) return null;
  const decoded = decodeURIComponent(streamName);
  return (
    streams.find((stream) => streamRouteSegment(stream, streams) === decoded) ??
    streams.find((stream) => stream.id === decoded || stream.name === decoded) ??
    null
  );
}

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
  const { streamName } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = findStreamByRouteSegment(streams, streamName);
  const selectedStreamUrl = selected?.manifestUrl
    ? `${window.location.origin}${selected.manifestUrl}`
    : null;
  const selectedPlaybackUrl = selected?.manifestUrl
    ? `${selected.manifestUrl}?v=${encodeURIComponent(selected.updatedAt)}`
    : null;

  useEffect(() => {
    if (!selected) {
      setForm(emptyForm);
      return;
    }
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
    setCreating(true);
    navigate("/producer");
    setForm(emptyForm);
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
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
      const response = await fetch(selected ? `/api/streams/${selected.id}` : "/api/streams", {
        method: selected ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Failed to save stream.");
      const savedStream = body.stream as ConfiguredStream;
      const nextStreams = [
        ...streams.filter((stream) => stream.id !== savedStream.id),
        savedStream,
      ];
      setCreating(false);
      await onRefresh();
      navigate(`/producer/${streamRouteSegment(savedStream, nextStreams)}`);
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
      return false;
    }
    await onRefresh();
    return true;
  };

  const clearMedia = async (stream: ConfiguredStream) => {
    const confirmed = window.confirm(
      `Delete generated segments and manifests for "${stream.name}"?`,
    );
    if (!confirmed) return;
    await action(`/api/streams/${stream.id}/media`, "DELETE");
  };

  const missingStreamName = streamName && !selected ? streamName : null;

  if (!streamName && !creating) {
    return (
      <ProducerIndex
        streams={streams}
        missingStreamName={null}
        onCreate={() => setCreating(true)}
      />
    );
  }

  if (missingStreamName) {
    return (
      <ProducerIndex
        streams={streams}
        missingStreamName={missingStreamName}
        onCreate={() => {
          setCreating(true);
          navigate("/producer");
        }}
      />
    );
  }

  return (
    <section className="mx-auto max-w-7xl">
      <div className="mb-3 flex justify-end">
        <Button asChild variant="outline" size="sm">
          <Link to="/player">
            <MonitorPlay />
            Player
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <ProducerForm
          form={form}
          setForm={setForm}
          streams={streams}
          selected={selected}
          configPath={configPath}
          streamRoot={streamRoot}
          inputs={inputs}
          inputsLoading={inputsLoading}
          inputsError={inputsError}
          saving={saving}
          error={error}
          onSubmit={submit}
          onNew={resetForm}
          onSelectStream={(stream) => {
            setCreating(false);
            navigate(`/producer/${streamRouteSegment(stream, streams)}`);
          }}
          onRefreshInputs={onRefreshInputs}
          onClearMedia={clearMedia}
          onDeleteStream={async (stream) => {
            const deleted = await action(`/api/streams/${stream.id}`, "DELETE");
            if (deleted) {
              navigate("/producer");
            }
          }}
        />

        <div className="min-w-0 rounded-sm border border-border bg-card p-4">
          {selected ? (
            <>
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-foreground">
                      {selected.name}
                    </h2>
                    <StatusPill status={selected.status} />
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {selected.outputPath}
                  </p>
                </div>
                <div className="flex items-center gap-2">
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
                      onClick={() => action(`/api/streams/${selected.id}/start`)}
                    >
                      <Play />
                      Start
                    </Button>
                  )}
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
              </div>

              <PlayerProvider key={selected.id}>
                <div className="mb-4">
                  <DashStreamPlayer
                    manifestUrl={selected.manifestUrl}
                    playbackVersion={selected.updatedAt}
                    label={selected.name}
                  />
                </div>

                <StreamDiagnosticsPanel
                  manifestUrl={selectedPlaybackUrl}
                  manifestLabel={selected.manifestUrl ?? "No manifest available"}
                />
              </PlayerProvider>

              <div className="mb-4 rounded-sm border border-border bg-muted p-3">
                <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                  DASH stream URL
                </div>
                {selectedStreamUrl ? (
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="truncate rounded-sm border border-border bg-input px-3 py-2 font-mono text-xs text-foreground">
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
                  <div className="text-sm text-muted-foreground">
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
                <Metric
                  label="Audio issues"
                  value={`${selected.metrics.audioWarnings} / ${selected.metrics.audioErrors} errors`}
                  icon={Mic}
                />
              </div>

              {selected.metrics.lastAudioIssue && (
                <div className="mt-4 rounded-sm border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                  <div className="font-semibold">Last audio ffmpeg issue</div>
                  <div className="mt-1 break-words font-mono">
                    {selected.metrics.lastAudioIssue}
                  </div>
                </div>
              )}

              <EncodingSpeedDiagnostic stream={selected} />

              <div className="mt-4 rounded-sm border border-border bg-black p-3 font-mono text-xs text-zinc-200">
                <div className="mb-2 flex items-center justify-between text-muted-foreground">
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
            <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
              Create a stream config to start monitoring ffmpeg.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

type ProducerFormProps = {
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  streams: ConfiguredStream[];
  selected: ConfiguredStream | null;
  configPath: string;
  streamRoot: string;
  inputs: CaptureInputsResponse | null;
  inputsLoading: boolean;
  inputsError: string | null;
  saving: boolean;
  error: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onNew: () => void;
  onSelectStream: (stream: ConfiguredStream) => void;
  onRefreshInputs: () => Promise<void>;
  onClearMedia: (stream: ConfiguredStream) => Promise<void>;
  onDeleteStream: (stream: ConfiguredStream) => Promise<void>;
};

function ProducerForm({
  form,
  setForm,
  streams,
  selected,
  configPath,
  streamRoot,
  inputs,
  inputsLoading,
  inputsError,
  saving,
  error,
  onSubmit,
  onNew,
  onSelectStream,
  onRefreshInputs,
  onClearMedia,
  onDeleteStream,
}: ProducerFormProps) {
  const videoDevices = inputs?.video ?? [];
  const audioDevices = inputs?.audio ?? [];

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
    <form onSubmit={onSubmit} className="rounded-sm border border-border bg-card p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {selected ? "Producer" : "New stream"}
          </h2>
          <p className="text-xs text-muted-foreground">Config: {configPath}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Local output root: {streamRoot}</p>
        </div>
        <Button type="button" size="icon" variant="outline" onClick={onNew} title="New stream">
          <Plus />
        </Button>
      </div>

      {selected && streams.length > 0 && (
        <div className="mb-4">
          <Label htmlFor="stream-select">Configured stream</Label>
          <Select
            value={selected?.id ?? ""}
            onValueChange={(value) => {
              const nextStream = streams.find((stream) => stream.id === value);
              if (nextStream) {
                onSelectStream(nextStream);
              }
            }}
          >
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
          <div className="mt-2 grid grid-cols-2 gap-2 rounded-sm border border-border bg-muted p-1">
            <Button
              type="button"
              variant={form.inputKind === "file" ? "default" : "ghost"}
              onClick={() => setForm((current) => ({ ...current, inputKind: "file" }))}
            >
              <FileVideo />
              File
            </Button>
            <Button
              type="button"
              variant={form.inputKind === "device" ? "default" : "ghost"}
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
          <div className="space-y-3 rounded-sm border border-border bg-muted p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-foreground">Live inputs</div>
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
              <div className="rounded-sm border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                {inputsError}
              </div>
            )}

            {!inputs?.supported && !inputsLoading && (
              <div className="rounded-sm border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
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
              disabled={Boolean(selected)}
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
            <div className="mt-1 text-xs text-muted-foreground">Seconds</div>
          </div>
        </div>

        <div className="space-y-3 rounded-sm border border-border bg-muted p-3">
          <div>
            <div className="text-sm font-medium text-foreground">Encoding</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
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
                  step="1"
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
                  step="1"
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
                  step="1"
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
        <div className="mt-4 rounded-sm border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          {error}
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving" : selected ? "Save" : "Create"}
        </Button>
        {selected && (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => onClearMedia(selected)}
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
              onClick={() => onDeleteStream(selected)}
              title="Delete config"
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

function ProducerIndex({
  streams,
  missingStreamName,
  onCreate,
}: {
  streams: ConfiguredStream[];
  missingStreamName: string | null;
  onCreate: () => void;
}) {
  return (
    <section className="grid min-h-[calc(100vh-1.5rem)] place-items-center px-2 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-medium text-foreground">Produce a stream</h1>
            {missingStreamName ? (
              <p className="mt-1 text-sm text-muted-foreground">Stream not found.</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/player">
                <MonitorPlay />
                Player
              </Link>
            </Button>
            <Button type="button" size="sm" onClick={onCreate}>
              <Plus />
              New stream
            </Button>
          </div>
        </div>

        {streams.length > 0 ? (
          <div className="overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10">
            <div className="divide-y divide-border">
              {streams.map((stream) => (
                <Link
                  key={stream.id}
                  to={`/producer/${streamRouteSegment(stream, streams)}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/70"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{stream.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {stream.outputSubdir}
                    </span>
                  </span>
                  <StatusPill status={stream.status} />
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">
            No streams are configured yet.
          </div>
        )}
      </div>
    </section>
  );
}
