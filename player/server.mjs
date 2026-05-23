import { createServer } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");
const dashBundlePath = path.join(
  __dirname,
  "node_modules",
  "dashjs",
  "dist",
  "modern",
  "umd",
  "dash.all.min.js",
);
const port = Number(process.env.PORT || process.env.PLAYER_PORT || 5173);

await loadEnvFile(path.join(repoDir, ".env"));
await loadEnvFile(path.join(__dirname, ".env"));

const localRoot = resolveLocalRoot(process.env.PLAYER_LOCAL_ROOT || repoDir);
const defaultLocalManifest = process.env.PLAYER_LOCAL_MANIFEST || "chunks/manifest.mpd";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m4s", "video/iso.segment"],
  [".mpd", "application/dash+xml; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (url.pathname === "/api/manifest") {
      await handleManifest(url, response);
      return;
    }

    if (url.pathname.startsWith("/api/object/")) {
      await handleObject(url, response);
      return;
    }

    if (url.pathname.startsWith("/api/local-object/")) {
      await handleLocalObject(url, response);
      return;
    }

    if (url.pathname === "/vendor/dash.all.min.js") {
      await sendFile(dashBundlePath, response, "text/javascript; charset=utf-8");
      return;
    }

    await handleStatic(url, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || "internal server error" });
  }
});

server.listen(port, () => {
  console.log(`cdirect player listening on http://127.0.0.1:${port}`);
});

async function handleManifest(url, response) {
  const manifestUrl =
    url.searchParams.get("manifestUrl") ||
    process.env.PLAYER_MANIFEST_URL ||
    defaultLocalManifest;
  const segmentBaseInput =
    url.searchParams.get("segmentBaseUrl") ||
    process.env.PLAYER_SEGMENT_BASE_URL ||
    manifestDirectoryUrl(manifestUrl);

  if (!manifestUrl) {
    sendJson(response, 400, {
      error: "manifestUrl is required. Set PLAYER_MANIFEST_URL or pass ?manifestUrl=...",
    });
    return;
  }

  const manifest = await readManifest(manifestUrl);
  const objectBaseUrl = localSource(manifestUrl)
    ? localObjectBaseUrl(segmentBaseInput || manifestDirectoryUrl(manifestUrl))
    : `/api/object/${encodeURIComponent(segmentBaseInput)}/`;
  const body = injectBaseUrl(manifest, objectBaseUrl);

  response.writeHead(200, {
    "content-type": "application/dash+xml; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

async function readManifest(manifestUrl) {
  if (!localSource(manifestUrl)) {
    return fetchText(manifestUrl, "application/dash+xml, application/xml, text/xml");
  }

  const manifestPath = resolveLocalPath(manifestUrl);
  return readFile(manifestPath, "utf8");
}

async function handleObject(url, response) {
  const prefix = "/api/object/";
  const rest = url.pathname.slice(prefix.length);
  const separator = rest.indexOf("/");

  if (separator < 0) {
    sendJson(response, 400, {
      error: "object proxy path must include a base URL and object key",
    });
    return;
  }

  const segmentBaseUrl = decodeURIComponent(rest.slice(0, separator));
  const key = rest
    .slice(separator + 1)
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .join("/");
  const objectUrl = joinUrl(segmentBaseUrl, key);
  const upstream = await fetchObject(objectUrl, {
    headers: {
      "cache-control": "no-cache",
    },
  });

  response.statusCode = upstream.status;
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("cache-control", "no-store");

  const contentType =
    upstream.headers.get("content-type") ||
    contentTypes.get(path.extname(key)) ||
    "application/octet-stream";
  response.setHeader("content-type", contentType);

  if (!upstream.body) {
    response.end();
    return;
  }

  for await (const chunk of upstream.body) {
    response.write(chunk);
  }
  response.end();
}

async function handleLocalObject(url, response) {
  const prefix = "/api/local-object/";
  const rest = url.pathname.slice(prefix.length);
  const separator = rest.indexOf("/");

  if (separator < 0) {
    sendJson(response, 400, {
      error: "local object proxy path must include a base path and object key",
    });
    return;
  }

  const segmentBasePath = decodeURIComponent(rest.slice(0, separator));
  const key = rest
    .slice(separator + 1)
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .join("/");
  const objectPath = resolveLocalPath(path.join(segmentBasePath, key));

  await sendFileStream(
    response,
    objectPath,
    contentTypes.get(path.extname(objectPath)) || "application/octet-stream",
  );
}

async function handleStatic(url, response) {
  const pathname = url.pathname === "/" || url.pathname === "/local" ? "/index.html" : url.pathname;
  const requestedPath = path.normalize(path.join(publicDir, pathname));

  if (!requestedPath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("forbidden");
    return;
  }

  try {
    await sendFile(
      requestedPath,
      response,
      contentTypes.get(path.extname(requestedPath)) || "application/octet-stream",
    );
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }
}

async function sendFile(filePath, response, contentType) {
  const body = await readFile(filePath);
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function sendFileStream(response, filePath, contentType) {
  const fileStat = await stat(filePath);

  response.writeHead(200, {
    "content-type": contentType,
    "content-length": fileStat.size,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });

  createReadStream(filePath).pipe(response);
}

async function fetchText(sourceUrl, accept) {
  const parsed = new URL(sourceUrl);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("manifestUrl must be an http or https URL");
  }

  const response = await fetchObject(sourceUrl, {
    headers: {
      accept,
      "cache-control": "no-cache",
    },
  });

  if (!response.ok) {
    throw new Error(`manifest fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function fetchObject(sourceUrl, options = {}) {
  const parsed = new URL(sourceUrl);
  const headers = signedS3Headers(parsed, options.headers || {});

  return fetch(parsed, {
    ...options,
    headers,
  });
}

function joinUrl(baseUrl, key) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedKey = key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return new URL(normalizedKey, normalizedBase).toString();
}

function manifestDirectoryUrl(manifestUrl) {
  if (!manifestUrl) return "";

  if (localSource(manifestUrl)) {
    const manifestPath = resolveLocalPath(manifestUrl);
    return path.dirname(manifestPath);
  }

  const parsed = new URL(manifestUrl);
  parsed.pathname = parsed.pathname.replace(/\/[^/]*$/, "/");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function localObjectBaseUrl(segmentBasePath) {
  const resolved = resolveLocalPath(segmentBasePath);
  const relative = path.relative(repoDir, resolved);
  const displayPath = !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : resolved;

  return `/api/local-object/${encodeURIComponent(displayPath)}/`;
}

function localSource(source) {
  if (!source) return false;
  if (source.startsWith("file://")) return true;
  return !/^https?:\/\//i.test(source);
}

function resolveLocalRoot(input) {
  return path.resolve(repoDir, input);
}

function resolveLocalPath(input) {
  let resolved;

  if (input.startsWith("file://")) {
    resolved = fileURLToPath(input);
  } else if (path.isAbsolute(input)) {
    resolved = path.resolve(input);
  } else {
    resolved = path.resolve(repoDir, input);
  }

  if (!isPathInside(resolved, localRoot)) {
    throw new Error(
      `local path is outside PLAYER_LOCAL_ROOT (${pathToFileURL(localRoot).toString()}): ${input}`,
    );
  }

  return resolved;
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function injectBaseUrl(manifest, baseUrl) {
  const escapedBaseUrl = escapeXml(baseUrl);
  const baseUrlElement = `\n  <BaseURL>${escapedBaseUrl}</BaseURL>`;

  if (/<BaseURL>/.test(manifest)) {
    return manifest.replace(/<BaseURL>[\s\S]*?<\/BaseURL>/, `<BaseURL>${escapedBaseUrl}</BaseURL>`);
  }

  return manifest.replace(/(<MPD\b[^>]*>)/, `$1${baseUrlElement}`);
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadEnvFile(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;

    const [, name, rawValue] = match;
    if (process.env[name] !== undefined) continue;

    process.env[name] = unquoteEnvValue(rawValue.trim());
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function signedS3Headers(url, inputHeaders) {
  const headers = new Headers(inputHeaders);
  const region = awsS3Region(url);
  const credentials = awsCredentials();

  if (!region || !credentials) {
    return headers;
  }

  headers.set("host", url.host);
  headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");

  const now = new Date();
  const amzDate = iso8601Basic(now);
  const date = amzDate.slice(0, 8);
  headers.set("x-amz-date", amzDate);

  if (credentials.sessionToken) {
    headers.set("x-amz-security-token", credentials.sessionToken);
  }

  const signedHeaderNames = [...headers.keys()]
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${normalizeHeaderValue(headers.get(name) || "")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const scope = `${date}/${region}/s3/aws4_request`;
  const canonicalRequest = [
    "GET",
    canonicalUri(url),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(signingKey(credentials.secretAccessKey, date, region), stringToSign);

  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );

  return headers;
}

function awsCredentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

function awsS3Region(url) {
  const host = url.hostname;
  const virtualHosted = /\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  if (virtualHosted) return virtualHosted[1];

  const pathStyle = /^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  if (pathStyle) return pathStyle[1];

  return null;
}

function canonicalUri(url) {
  return url.pathname
    .split("/")
    .map((part) => encodeURIComponent(decodeURIComponent(part)).replace(/%2F/g, "/"))
    .join("/");
}

function canonicalQuery(url) {
  return [...url.searchParams.entries()]
    .flatMap(([name, value]) => [[awsEncode(name), awsEncode(value)]])
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function normalizeHeaderValue(value) {
  return value.trim().replace(/\s+/g, " ");
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function iso8601Basic(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function signingKey(secretAccessKey, date, region) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(body, null, 2));
}
