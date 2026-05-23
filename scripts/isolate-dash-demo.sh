#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/isolate-dash-demo.sh [options]

Captures a macOS AVFoundation camera/microphone pair and writes a local
MPEG-DASH live mux into chunks/manifest.mpd.

Options:
  --list-devices          Print AVFoundation devices and exit.
  --output-dir DIR        DASH output directory. Default: chunks
  --manifest NAME         Manifest filename. Default: manifest.mpd
  --video-device DEVICE   AVFoundation video device name or index. Default: 0
  --audio-device DEVICE   AVFoundation audio device name or index. Default: 0
  --video-size SIZE       Capture size. Default: 1280x720
  --framerate FPS         Capture frame rate. Default: 30
  --seg-duration SEC      DASH segment duration. Default: 2
  --keep-existing         Do not delete old local DASH files before starting.
  -h, --help              Show this help.

Environment overrides:
  OUTPUT_DIR, MANIFEST_NAME, VIDEO_DEVICE, AUDIO_DEVICE, VIDEO_SIZE, FRAMERATE,
  SEG_DURATION, WINDOW_SIZE, EXTRA_WINDOW_SIZE, VIDEO_BITRATE, AUDIO_BITRATE,
  AUDIO_RATE, AUDIO_CHANNELS

Examples:
  scripts/isolate-dash-demo.sh --list-devices
  scripts/isolate-dash-demo.sh --video-device "FaceTime HD Camera" --audio-device "Built-in Microphone"
  VIDEO_DEVICE=0 AUDIO_DEVICE=0 scripts/isolate-dash-demo.sh
USAGE
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: $1 is not on PATH" >&2
    exit 1
  fi
}

OUTPUT_DIR="${OUTPUT_DIR:-chunks}"
MANIFEST_NAME="${MANIFEST_NAME:-manifest.mpd}"
VIDEO_DEVICE="${VIDEO_DEVICE:-0}"
AUDIO_DEVICE="${AUDIO_DEVICE:-0}"
VIDEO_SIZE="${VIDEO_SIZE:-1280x720}"
FRAMERATE="${FRAMERATE:-30}"
SEG_DURATION="${SEG_DURATION:-2}"
WINDOW_SIZE="${WINDOW_SIZE:-12}"
EXTRA_WINDOW_SIZE="${EXTRA_WINDOW_SIZE:-6}"
VIDEO_BITRATE="${VIDEO_BITRATE:-3500k}"
AUDIO_BITRATE="${AUDIO_BITRATE:-160k}"
AUDIO_RATE="${AUDIO_RATE:-48000}"
AUDIO_CHANNELS="${AUDIO_CHANNELS:-2}"
CLEAN_OUTPUT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list-devices)
      require_command ffmpeg
      ffmpeg -hide_banner -f avfoundation -list_devices true -i "" || true
      exit 0
      ;;
    --output-dir)
      OUTPUT_DIR="${2:?missing value for --output-dir}"
      shift 2
      ;;
    --manifest)
      MANIFEST_NAME="${2:?missing value for --manifest}"
      shift 2
      ;;
    --video-device)
      VIDEO_DEVICE="${2:?missing value for --video-device}"
      shift 2
      ;;
    --audio-device)
      AUDIO_DEVICE="${2:?missing value for --audio-device}"
      shift 2
      ;;
    --video-size)
      VIDEO_SIZE="${2:?missing value for --video-size}"
      shift 2
      ;;
    --framerate)
      FRAMERATE="${2:?missing value for --framerate}"
      shift 2
      ;;
    --seg-duration)
      SEG_DURATION="${2:?missing value for --seg-duration}"
      shift 2
      ;;
    --keep-existing)
      CLEAN_OUTPUT=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_command ffmpeg

mkdir -p "$OUTPUT_DIR"

if [[ "$CLEAN_OUTPUT" -eq 1 ]]; then
  find "$OUTPUT_DIR" -maxdepth 1 -type f \( \
    -name "$MANIFEST_NAME" \
    -o -name 'init-stream*' \
    -o -name 'chunk-stream*' \
  \) -delete
fi

MANIFEST_PATH="$OUTPUT_DIR/$MANIFEST_NAME"
DEVICE_SPEC="${VIDEO_DEVICE}:${AUDIO_DEVICE}"

echo "Writing local DASH stream to $MANIFEST_PATH"
echo "Using AVFoundation input $DEVICE_SPEC at $VIDEO_SIZE@$FRAMERATE"
echo "Stop with Ctrl-C."

exec ffmpeg \
  -hide_banner \
  -loglevel info \
  -thread_queue_size 512 \
  -f avfoundation \
  -framerate "$FRAMERATE" \
  -video_size "$VIDEO_SIZE" \
  -i "$DEVICE_SPEC" \
  -map 0:v:0 \
  -map 0:a:0 \
  -c:v libx264 \
  -preset veryfast \
  -tune zerolatency \
  -pix_fmt yuv420p \
  -r "$FRAMERATE" \
  -b:v "$VIDEO_BITRATE" \
  -c:a aac \
  -b:a "$AUDIO_BITRATE" \
  -ar "$AUDIO_RATE" \
  -ac "$AUDIO_CHANNELS" \
  -force_key_frames "expr:gte(t,n_forced*$SEG_DURATION)" \
  -sc_threshold 0 \
  -f dash \
  -seg_duration "$SEG_DURATION" \
  -window_size "$WINDOW_SIZE" \
  -extra_window_size "$EXTRA_WINDOW_SIZE" \
  -remove_at_exit 0 \
  -use_template 1 \
  -use_timeline 1 \
  -init_seg_name 'init-stream$RepresentationID$.$ext$' \
  -media_seg_name 'chunk-stream$RepresentationID$-$Number%05d$.$ext$' \
  "$MANIFEST_PATH"
