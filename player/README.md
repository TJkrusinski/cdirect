# cdirect Player

Demo browser player for a `cdirect` DASH stream.

The server proxies the MPD and segment objects so the browser does not need S3
CORS rules. For AWS S3 URLs, it signs proxy requests with
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN`
from the repo `.env` or the shell, so the bucket does not need to be public.

## Run

```sh
cd player
npm run dev
```

Then open:

```text
http://127.0.0.1:5173
```

For local DASH output written by `scripts/isolate-dash-demo.sh`, open:

```text
http://127.0.0.1:5173/local
```

That view assumes `chunks/manifest.mpd` and fetches the init/media segments
from the same local directory. In the normal UI, the `Local chunks` button does
the same thing.

You can either paste the URLs into the UI or start the server with defaults:

```sh
PLAYER_MANIFEST_URL="https://bucket.s3.region.amazonaws.com/events/demo/manifest.mpd" \
PLAYER_SEGMENT_BASE_URL="https://bucket.s3.region.amazonaws.com/events/demo/" \
npm run dev
```

For the default repo config and `.env`, use:

```text
Manifest URL:    https://cdirect-live-595775492152-us-west-2.s3.us-west-2.amazonaws.com/events/demo/manifest.mpd
Object Base URL: https://cdirect-live-595775492152-us-west-2.s3.us-west-2.amazonaws.com/events/demo/
```

For MinIO or LocalStack, use the manifest directory as the object base:

```sh
PLAYER_MANIFEST_URL="http://127.0.0.1:9000/cdirect-test/events/demo/manifest.mpd" \
PLAYER_SEGMENT_BASE_URL="http://127.0.0.1:9000/cdirect-test/events/demo/" \
npm run dev
```

The server injects a proxied DASH `BaseURL` into the MPD. dash.js then starts
near the live edge and fetches initialization and media segments through
`/api/object/...`.

For local manifests, `Manifest URL` can be a repo-relative path like
`chunks/manifest.mpd`, an absolute path, or a `file://` URL. Local reads are
restricted to the repo directory by default; set `PLAYER_LOCAL_ROOT` if you need
to expose a different directory. Set `PLAYER_LOCAL_MANIFEST` to change the
default used by `/local`.
