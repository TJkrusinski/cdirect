const form = document.querySelector("#connect-form");
const video = document.querySelector("#video");
const manifestInput = document.querySelector("#manifest-url");
const segmentBaseInput = document.querySelector("#segment-base-url");
const statusEl = document.querySelector("#status");
const modeEl = document.querySelector("#mode");
const latencyEl = document.querySelector("#latency");
const bufferedEl = document.querySelector("#buffered");
const updatedAtEl = document.querySelector("#updated-at");
const logEl = document.querySelector("#log");
const liveButton = document.querySelector("#live-button");
const localButton = document.querySelector("#local-button");

const defaultLocalManifest = "chunks/manifest.mpd";

const state = {
  player: null,
  metricsTimer: null,
};

const savedManifestUrl = localStorage.getItem("cdirect.manifestUrl");
const savedSegmentBaseUrl = localStorage.getItem("cdirect.segmentBaseUrl");

if (savedManifestUrl) {
  manifestInput.value = savedManifestUrl;
} else {
  manifestInput.value = defaultLocalManifest;
}
if (savedSegmentBaseUrl) segmentBaseInput.value = savedSegmentBaseUrl;

if (window.location.pathname === "/local") {
  useLocalChunks({ autoConnect: true });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const manifestUrl = manifestInput.value.trim();
  const segmentBaseUrl = segmentBaseInput.value.trim();
  localStorage.setItem("cdirect.manifestUrl", manifestUrl);
  localStorage.setItem("cdirect.segmentBaseUrl", segmentBaseUrl);
  connect(manifestUrl, segmentBaseUrl);
});

localButton.addEventListener("click", () => {
  useLocalChunks({ autoConnect: true });
});

liveButton.addEventListener("click", () => {
  const end = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : video.duration;
  if (Number.isFinite(end) && end > 0) {
    video.currentTime = Math.max(0, end - 0.35);
  }
  video.play().catch(() => {});
});

video.addEventListener("timeupdate", renderMetrics);
video.addEventListener("progress", renderMetrics);

function connect(manifestUrl, segmentBaseUrl) {
  reset();

  if (!manifestUrl) {
    setStatus("Manifest URL is required");
    return;
  }

  const params = new URLSearchParams({ manifestUrl });
  if (segmentBaseUrl) params.set("segmentBaseUrl", segmentBaseUrl);

  const playerUrl = `/api/manifest?${params}`;
  const player = dashjs.MediaPlayer().create();
  state.player = player;

  player.updateSettings({
    streaming: {
      buffer: {
        bufferTimeAtTopQuality: 8,
        bufferTimeAtTopQualityLongForm: 8,
        stableBufferTime: 6,
      },
      delay: {
        liveDelayFragmentCount: 3,
      },
      liveCatchup: {
        enabled: true,
      },
    },
  });

  const events = dashjs.MediaPlayer.events;
  player.on(events.ERROR, (event) => {
    const message = event?.error?.message || event?.event?.message || "dash.js playback error";
    setStatus(message);
    log(message);
  });
  player.on(events.MANIFEST_LOADED, () => {
    setStatus("DASH manifest loaded");
    log("manifest loaded");
    renderMetrics();
  });
  player.on(events.STREAM_INITIALIZED, () => {
    modeEl.textContent = "DASH";
    setStatus("Playing DASH live stream");
    video.play().catch(() => {});
  });
  player.on(events.PLAYBACK_STALLED, () => {
    setStatus("Buffering");
  });
  player.on(events.PLAYBACK_PLAYING, () => {
    setStatus("Playing DASH live stream");
  });

  player.initialize(video, playerUrl, true);
  state.metricsTimer = window.setInterval(renderMetrics, 1000);
  setStatus("Connecting");
}

function useLocalChunks({ autoConnect }) {
  manifestInput.value = defaultLocalManifest;
  segmentBaseInput.value = "";
  localStorage.setItem("cdirect.manifestUrl", defaultLocalManifest);
  localStorage.removeItem("cdirect.segmentBaseUrl");

  if (autoConnect) {
    connect(defaultLocalManifest, "");
  }
}

function reset() {
  if (state.metricsTimer) {
    window.clearInterval(state.metricsTimer);
  }

  if (state.player) {
    state.player.reset();
  }

  state.player = null;
  state.metricsTimer = null;
  video.removeAttribute("src");
  video.load();
  latencyEl.textContent = "-";
  bufferedEl.textContent = "0s";
  updatedAtEl.textContent = "-";
  logEl.textContent = "";
  modeEl.textContent = "DASH";
}

function renderMetrics() {
  updatedAtEl.textContent = new Date().toLocaleTimeString();
  renderBuffered();

  if (!state.player || typeof state.player.getCurrentLiveLatency !== "function") {
    latencyEl.textContent = "-";
    return;
  }

  const latency = state.player.getCurrentLiveLatency();
  latencyEl.textContent = Number.isFinite(latency) ? `${latency.toFixed(1)}s` : "-";
}

function renderBuffered() {
  if (!video.buffered.length) {
    bufferedEl.textContent = "0s";
    return;
  }

  const end = video.buffered.end(video.buffered.length - 1);
  const remaining = Math.max(0, end - video.currentTime);
  bufferedEl.textContent = `${remaining.toFixed(1)}s`;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.textContent = `${line}\n${logEl.textContent}`.slice(0, 6000);
}
