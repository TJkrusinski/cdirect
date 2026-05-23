# cdirect

`cdirect` is a local live capture pipeline for writing short audio/video
segments and publishing them directly to S3 or an S3-compatible object store.

The pipeline continuously captures wall-clock segments and uploads:

- `s3://<bucket>/<prefix>/manifest.mpd`
- `s3://<bucket>/<prefix>/segments/init-stream<representation>.m4s`
- `s3://<bucket>/<prefix>/segments/chunk-stream<representation>-<number>.m4s`

The manifest is an MPEG-DASH MPD. The demo player uses dash.js to play the live
stream.

## Streaming Model

The producer starts one long-running FFmpeg process for the capture input. That
process continuously reads audio/video, encodes it, and uses FFmpeg's DASH muxer
to write a live MPD, initialization segments, and `.m4s` media segments into a
temporary spool directory. `cdirect` uploads stable files from that spool and
publishes the MPD after media files, so the manifest should not point at objects
that have not reached S3 yet.

The S3 bucket is the coordination surface. The producer does not require a
streaming server or a server-side database; it overwrites the MPD and media
objects at their object keys.

## Prerequisites

- Rust/Cargo.
- FFmpeg and FFprobe on `PATH`.
- Node.js 18 or newer for the demo player.
- AWS credentials available to the normal AWS SDK provider chain, unless using
  a local S3-compatible server with its own credentials.
- Optional `.env` file in the project root. It is loaded automatically at
  startup and overrides stale shell values. Use normal dotenv syntax such as
  `AWS_ACCESS_KEY_ID=...`, not shell `export` lines.

## Quick Start

Create a config from the example:

```sh
cp cdirect.example.yaml cdirect.yaml
```

List macOS audio/video inputs:

```sh
cargo run -- --list-inputs
```

Check S3 credentials and bucket access:

```sh
cargo run -- --config cdirect.yaml --check-s3
```

Start the continuous live stream:

```sh
cargo run -- --config cdirect.yaml
```

Stop the stream with `Ctrl-C`.

Run the demo player:

```sh
cd player
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Configuration

The default input source is macOS AVFoundation:

```yaml
inputs:
  source: "avfoundation"
  audio:
    name: "Built-in Microphone"
    id: "0"
  video:
    name: "FaceTime HD Camera"
    id: "0"
```

To use a file fixture such as Big Buck Bunny instead of a webcam/mic:

```yaml
inputs:
  source: "file"
  file:
    path: "tests/fixtures/big_buck_bunny.mp4"
    loop_input: true
    realtime: false
```

Segment and encode settings:

```yaml
segment:
  duration_seconds: 2
  extension: "m4s"
  prefix: "segments"
  manifest_name: "manifest.mpd"
  window_size: 12
  extra_window_size: 6

encode:
  video:
    codec: "libx264"
    preset: "veryfast"
    bitrate: "4500k"
    maxrate: "7000k"
    bufsize: "14000k"
    width: 1920
    height: 1080
    framerate: 30
  audio:
    codec: "aac"
    bitrate: "160k"
    sample_rate: 48000
    channels: 2
```

`bitrate` is the target video rate. `maxrate` and `bufsize` configure x264's
VBV rate-control window. If FFmpeg prints `VBV underflow`, capture is still
running, but the encoder could not satisfy the configured peak-rate buffer for a
complex frame. Raise `maxrate`/`bufsize`, use a slower preset if the CPU has
headroom, or lower resolution/framerate/bitrate.

AWS S3 destination:

```yaml
s3:
  bucket: "${ASSET_BUCKET}"
  prefix: "events/demo"
  region: "us-west-2"
```

MinIO, LocalStack, or another S3-compatible endpoint:

```yaml
s3:
  bucket: "cdirect-test"
  prefix: "events/demo"
  region: "us-east-1"
  endpoint_url: "http://127.0.0.1:9000"
  force_path_style: true
```

## Watching A Stream

Start the player:

```sh
cd player
npm run dev
```

For the local DASH files produced under `chunks/`, open:

```text
http://127.0.0.1:5173/local
```

The local view assumes `chunks/manifest.mpd` and serves the matching
`init-stream*.m4s` and `chunk-stream*.m4s` files from that directory. The normal
player also has a `Local chunks` button for the same setup.

Paste these into the UI:

- `Manifest URL`: local path to `manifest.mpd` or a full HTTP URL.
- `Object Base URL`: optional base URL for MPD-relative objects. If omitted, the
  player server uses the manifest directory.

For public S3 objects:

```text
Manifest URL:     https://bucket.s3.region.amazonaws.com/events/demo/manifest.mpd
Object Base URL:  https://bucket.s3.region.amazonaws.com/events/demo/
```

For MinIO or LocalStack:

```text
Manifest URL:     http://127.0.0.1:9000/cdirect-test/events/demo/manifest.mpd
Object Base URL:  http://127.0.0.1:9000/cdirect-test/events/demo/
```

You can also start the player with defaults:

```sh
cd player
PLAYER_MANIFEST_URL="https://bucket.s3.region.amazonaws.com/events/demo/manifest.mpd" \
PLAYER_SEGMENT_BASE_URL="https://bucket.s3.region.amazonaws.com/events/demo/" \
npm run dev
```

The player server proxies the MPD through `/api/manifest`, injects a DASH
`BaseURL` pointing at `/api/object/...`, and lets dash.js fetch the init and
media segments through that proxy. The browser does not need S3 CORS rules. For
AWS S3 URLs, the proxy signs requests with AWS credentials from the repo `.env`
or the shell. MinIO, LocalStack, and other S3-compatible URLs are fetched
directly.

## Integration Tests

The default test suite is deterministic and does not touch cameras, microphones,
or S3:

```sh
cargo test
```

The ignored integration suite captures or transcodes one segment, publishes it,
downloads `manifest.mpd` and DASH media back from the server, then validates the
downloaded init+media bytes with `ffprobe`.

File-fixture test:

```sh
export CDIRECT_TEST_S3_BUCKET="cdirect-test"
export CDIRECT_TEST_S3_PREFIX="manual"
export CDIRECT_TEST_MEDIA_PATH="tests/fixtures/big_buck_bunny.mp4"
cargo test --test integration_stream publishes_file_fixture_segment_and_manifest -- --ignored
```

Webcam/mic test on macOS:

```sh
cargo run -- --list-inputs
export CDIRECT_TEST_S3_BUCKET="cdirect-test"
export CDIRECT_TEST_AVFOUNDATION_VIDEO_ID="0"
export CDIRECT_TEST_AVFOUNDATION_AUDIO_ID="0"
cargo test --test integration_stream publishes_webcam_and_mic_segment_and_manifest -- --ignored
```

Optional integration environment variables:

- `CDIRECT_TEST_S3_REGION`, default `us-east-1`.
- `CDIRECT_TEST_S3_ENDPOINT_URL`, for S3-compatible local servers.
- `CDIRECT_TEST_S3_FORCE_PATH_STYLE`, set to `true` when required by the server.

Run all ignored integration tests:

```sh
cargo test --test integration_stream -- --ignored
```

## Redundancy Model

The DASH publisher is intended for one active producer per S3 prefix. It stores
no server-side state, but FFmpeg's DASH segment numbers are local to the active
encoder process, so two simultaneous producers with the same prefix can overwrite
each other's MPD and segment objects.

## Current Status

Implemented:

- CLI parsing.
- YAML config loading with environment variable expansion.
- Audio and video input listing through FFmpeg's `avfoundation` input.
- Continuous config-driven FFmpeg capture and segmenting from AVFoundation or a
  media file, using one long-running FFmpeg process.
- DASH MPD, init segment, and `.m4s` media publication to S3.
- S3-compatible endpoint support for local test servers.
- Ignored end-to-end tests that validate published manifests and media segments.
- dash.js demo web player under `player/`.
- Cleanup of local temporary segment files after publish.

Still stubbed:

- Multi-bitrate ladders.
