# cdirect

Create DASH manifest and segments directly at input. Rather than sending an RTMP or SRT stream to a server to remux into DASH segments, this server uses ffmpeg to create the segments directly to disk. The player is then able to read the manifest and pull down the segments.

## Requirements

- Bun
- ffmpeg and ffplay on `PATH`
- macOS for live camera/microphone capture through AVFoundation

## Install

```bash
bun install
```

## Run

```bash
bun run dev
```

The server prints its local URL at startup. Open:

- `/producer` to configure, start, stop, and monitor streams
- `/player` to play available DASH manifests with dash.js

For production:

```bash
bun run start
```

## Producer

The producer page can create stream configs backed by either a media file or live AVFoundation devices. For live Mac camera capture, the app requests the configured output size from AVFoundation with `-video_size`, for example `1280x720`, so the built-in camera can provide a landscape capture buffer instead of being letterboxed after capture.

Generated media is written under the configured stream root, defaulting to `streams/`. Stream config is stored in `stream-config.json` unless `STREAM_CONFIG_PATH` is set.

The producer detail panel includes:

- ffmpeg status, metrics, and logs
- encoding FPS diagnostic against the configured target FPS
- an absolute DASH manifest URL that can be copied into VLC

## Player

The player page scans generated `.mpd` files and plays them with dash.js. It includes:

- manifest health checks
- playback, network, and dash.js diagnostics
- browser media error reporting
- per-producer-run manifest versioning so dash.js resets cleanly after a stream restart

Media responses are served with `Cache-Control: no-store` and `Pragma: no-cache`. Segment filenames are unique per producer run to avoid stale browser cache collisions.

## Build

```bash
bun run build
```

## Useful Checks

List AVFoundation devices:

```bash
ffmpeg -hide_banner -f avfoundation -list_devices true -i ""
```

Test the built-in camera in landscape:

```bash
ffplay -f avfoundation -framerate 30 -video_size 1280x720 -i "0:none"
```

Probe a generated video init segment:

```bash
ffprobe -v error -show_streams -select_streams v:0 streams/<stream>/init-*-stream0.m4s
```
