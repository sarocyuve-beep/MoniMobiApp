// Minimal Cloudflare R2 client (S3-compatible API, AWS Signature V4). No extra npm packages needed.
// Configure with: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// (R2_ENDPOINT is optional and only used for tests / custom endpoints).
const crypto = require("node:crypto");

const REGION = "auto";
const SERVICE = "s3";
const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex");
const TIMEOUT_MS = Number(process.env.R2_TIMEOUT_MS || 20000);

function settings() {
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
  const bucket = process.env.R2_BUCKET || "";
  const endpoint = (process.env.R2_ENDPOINT || (accountId ? "https://" + accountId + ".r2.cloudflarestorage.com" : "")).replace(/\/$/, "");
  return { accessKeyId, secretAccessKey, bucket, endpoint, ok: Boolean(accessKeyId && secretAccessKey && bucket && endpoint) };
}

function enabled() {
  return settings().ok;
}

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// RFC 3986 encoding, as required by SigV4 (every byte except A-Z a-z 0-9 - _ . ~).
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodePath(path) {
  return path.split("/").map(encodeRfc3986).join("/");
}

// Returns the Authorization header value. `headers` must hold every header that will be signed (lower-case names).
function sign({ method, path, query = "", headers, payloadHash, accessKeyId, secretAccessKey, amzDate, region = REGION, service = SERVICE }) {
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = names.map((name) => name + ":" + String(headers[name]).trim().replace(/\s+/g, " ") + "\n").join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = [date, region, service, "aws4_request"].join("/");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + secretAccessKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    signature,
    authorization: "AWS4-HMAC-SHA256 Credential=" + accessKeyId + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature
  };
}

async function call(method, key, { body, contentType } = {}) {
  const cfg = settings();
  if (!cfg.ok) throw new Error("R2 is not configured.");
  const url = new URL(cfg.endpoint);
  const path = "/" + encodeRfc3986(cfg.bucket) + "/" + encodePath(key);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
  const headers = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (body && contentType) headers["content-type"] = contentType;
  const { authorization } = sign({ method, path, headers, payloadHash, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate });
  const { host, ...sendHeaders } = headers;
  const response = await fetch(url.origin + path, {
    method,
    headers: { ...sendHeaders, Authorization: authorization },
    body: body || undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return response;
}

async function fail(action, response) {
  let detail = "";
  try { detail = (await response.text()).slice(0, 200); } catch (error) { /* ignore */ }
  return new Error("R2 " + action + " failed (" + response.status + ")" + (detail ? ": " + detail : ""));
}

async function put(key, buffer, contentType = "image/jpeg") {
  const response = await call("PUT", key, { body: buffer, contentType });
  if (!response.ok) throw await fail("PUT", response);
}

// Returns a Buffer, or null when the object does not exist.
async function get(key) {
  const response = await call("GET", key);
  if (response.status === 404) return null;
  if (!response.ok) throw await fail("GET", response);
  return Buffer.from(await response.arrayBuffer());
}

// Deleting a missing object is not an error in S3/R2 (204).
async function del(key) {
  const response = await call("DELETE", key);
  if (!response.ok && response.status !== 404) throw await fail("DELETE", response);
}

module.exports = { enabled, put, get, del, sign, encodeRfc3986 };
