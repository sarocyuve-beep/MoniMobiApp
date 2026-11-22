require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const token = process.env.GH_DATA_TOKEN;
const repo = process.env.GH_DATA_REPO;
const file = process.env.GH_DATA_PATH || "monimobi.sqlite.enc";
const branch = process.env.GH_DATA_BRANCH || "main";
const api = (process.env.GH_API_URL || "https://api.github.com").replace(/\/$/, "");
const debounceMs = Math.max(1000, Number(process.env.GH_DATA_DEBOUNCE_MS || 15000));
const dbPath = path.resolve(process.env.DB_PATH || "./data/monimobi.sqlite");
const enabled = Boolean(token && repo);
const magic = Buffer.from("MMDB1");

let ready = false;
let dirty = false;
let timer = null;
let running = null;
let contentSha;

function encryptionKey() {
  const value = process.env.GH_DATA_ENCRYPTION_KEY || "";
  if (!/^[\da-fA-F]{64}$/.test(value)) {
    throw new Error("GH_DATA_ENCRYPTION_KEY must be 64 hexadecimal characters (32 random bytes).");
  }
  return Buffer.from(value, "hex");
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted]);
}

function decrypt(snapshot) {
  if (snapshot.length < 33 || !snapshot.subarray(0, magic.length).equals(magic)) {
    throw new Error("GitHub snapshot is not a MoniMobi encrypted database.");
  }
  const iv = snapshot.subarray(5, 17);
  const authTag = snapshot.subarray(17, 33);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(snapshot.subarray(33)), decipher.final()]);
}

function fileUrl() {
  const encodedPath = file.split("/").map(encodeURIComponent).join("/");
  return `${api}/repos/${repo}/contents/${encodedPath}`;
}

function headers(accept) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "User-Agent": "monimobi-app-backup",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function getSnapshot() {
  const response = await fetch(`${fileUrl()}?ref=${encodeURIComponent(branch)}`, {
    headers: headers("application/vnd.github.raw+json"),
    signal: AbortSignal.timeout(30000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub returned ${response.status} while restoring the database.`);
  const snapshot = Buffer.from(await response.arrayBuffer());
  const plaintext = decrypt(snapshot);
  if (plaintext.length < 100 || plaintext.subarray(0, 15).toString("latin1") !== "SQLite format 3") {
    throw new Error("Decrypted snapshot is not a SQLite database.");
  }
  const infoResponse = await fetch(`${fileUrl()}?ref=${encodeURIComponent(branch)}`, {
    headers: headers("application/vnd.github+json"),
    signal: AbortSignal.timeout(30000)
  });
  if (!infoResponse.ok) throw new Error(`GitHub returned ${infoResponse.status} while reading database metadata.`);
  contentSha = (await infoResponse.json()).sha;
  return plaintext;
}

async function restore() {
  if (!enabled) return fs.existsSync(dbPath) ? "local" : "fresh";
  encryptionKey();
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error("GH_DATA_REPO must be in owner/repository format.");
  if (fs.existsSync(dbPath) && process.env.RESTORE_GITHUB_SNAPSHOT !== "true") {
    ready = true;
    return "local";
  }

  const database = await getSnapshot();
  if (!database) {
    ready = true;
    return fs.existsSync(dbPath) ? "local" : "fresh";
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const temporary = `${dbPath}.${process.pid}.restore`;
  try {
    fs.writeFileSync(temporary, database, { mode: 0o600 });
    fs.renameSync(temporary, dbPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  ready = true;
  return "restored";
}

async function pushNow() {
  const { db } = require("./db");
  const temporary = path.join(os.tmpdir(), `monimobi-snapshot-${process.pid}.sqlite`);
  try {
    fs.rmSync(temporary, { force: true });
    db.prepare("VACUUM INTO ?").run(temporary);
    const snapshot = encrypt(fs.readFileSync(temporary)).toString("base64");
    const url = fileUrl();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (contentSha === undefined) {
        const info = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
          headers: headers("application/vnd.github+json"),
          signal: AbortSignal.timeout(30000)
        });
        if (info.status === 404) contentSha = null;
        else if (!info.ok) throw new Error(`GitHub returned ${info.status} while checking database snapshot.`);
        else contentSha = (await info.json()).sha;
      }

      const body = {
        message: "Encrypted MoniMobi database snapshot " + new Date().toISOString(),
        content: snapshot,
        branch
      };
      if (contentSha) body.sha = contentSha;
      const response = await fetch(url, {
        method: "PUT",
        headers: { ...headers("application/vnd.github+json"), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      });
      if (response.ok) {
        contentSha = (await response.json()).content.sha;
        return;
      }
      if (response.status === 409 || response.status === 422) {
        contentSha = undefined;
        continue;
      }
      throw new Error(`GitHub returned ${response.status} while saving database snapshot.`);
    }
    throw new Error("GitHub repeatedly rejected the database snapshot due to a SHA conflict.");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function schedule(delay) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    run();
  }, delay);
  timer.unref();
}

function run() {
  if (running) return running;
  running = (async () => {
    while (dirty) {
      dirty = false;
      try {
        await pushNow();
        console.log("Encrypted database snapshot saved to GitHub.");
      } catch (error) {
        dirty = true;
        console.error("Database snapshot failed; retrying in 60 seconds:", error.message);
        schedule(60000);
        break;
      }
    }
  })().finally(() => {
    running = null;
    if (dirty && !timer) schedule(debounceMs);
  });
  return running;
}

function markDirty() {
  if (!enabled || !ready) return;
  dirty = true;
  schedule(debounceMs);
}

async function flush() {
  if (!enabled || !ready) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (running) await running;
  if (dirty) {
    dirty = false;
    try {
      await pushNow();
      console.log("Final encrypted database snapshot saved to GitHub.");
    } catch (error) {
      dirty = true;
      console.error("Final database snapshot failed:", error.message);
    }
  }
}

module.exports = { enabled, restore, markDirty, flush };
