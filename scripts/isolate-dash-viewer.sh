#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/isolate-dash-viewer.sh [manifest-path-or-url]

Plays a local DASH manifest with ffplay. Defaults to chunks/manifest.mpd.

Options:
  --wait SECONDS          Wait for a local manifest before launching. Default: 20
  --no-low-latency        Do not pass low-latency ffplay flags.
  -h, --help              Show this help.

Environment overrides:
  MANIFEST, WAIT_SECONDS, LOW_LATENCY

Examples:
  scripts/isolate-dash-viewer.sh
  scripts/isolate-dash-viewer.sh chunks/manifest.mpd
  MANIFEST=http://127.0.0.1:8000/manifest.mpd scripts/isolate-dash-viewer.sh
USAGE
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: $1 is not on PATH" >&2
    exit 1
  fi
}

is_url() {
  [[ "$1" == http://* || "$1" == https://* ]]
}

MANIFEST="${MANIFEST:-chunks/manifest.mpd}"
WAIT_SECONDS="${WAIT_SECONDS:-20}"
LOW_LATENCY="${LOW_LATENCY:-1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait)
      WAIT_SECONDS="${2:?missing value for --wait}"
      shift 2
      ;;
    --no-low-latency)
      LOW_LATENCY=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      MANIFEST="$1"
      shift
      ;;
  esac
done

require_command ffplay

if ! is_url "$MANIFEST"; then
  elapsed=0
  while [[ ! -s "$MANIFEST" && "$elapsed" -lt "$WAIT_SECONDS" ]]; do
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if [[ ! -s "$MANIFEST" ]]; then
    echo "error: manifest not found after ${WAIT_SECONDS}s: $MANIFEST" >&2
    echo "start scripts/isolate-dash-demo.sh in another terminal first" >&2
    exit 1
  fi
fi

echo "Playing $MANIFEST"

ffplay_args=(
  -hide_banner
  -loglevel warning
)

if [[ "$LOW_LATENCY" -eq 1 ]]; then
  ffplay_args+=(
    -fflags nobuffer
    -flags low_delay
    -framedrop
  )
fi

exec ffplay "${ffplay_args[@]}" "$MANIFEST"
