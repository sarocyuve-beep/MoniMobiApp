// Report photos. The browser shrinks every photo (small JPEG) before upload.
// Storage: when R2_* variables are set, the JPEG bytes go to a private Cloudflare R2 bucket and SQLite only keeps
// a small metadata row (so the encrypted GitHub snapshot stays tiny). Without R2, bytes stay in SQLite as before.
const { db } = require("./db");
const persistence = require("./persist");
const r2 = require("./r2");

const MAX_BYTES = Number(process.env.PHOTO_MAX_BYTES || 600 * 1024);
const MAX_PER_REPORT = 30;
const ORPHAN_HOURS = 24;
const EMPTY = Buffer.alloc(0);

// SQLite mode: PHOTO_MAX_TOTAL_MB (25). R2 mode: R2_MAX_TOTAL_MB (8000), kept under the 10 GB free tier.
function maxTotalBytes() {
  const mb = r2.enabled() ? Number(process.env.R2_MAX_TOTAL_MB || 8000) : Number(process.env.PHOTO_MAX_TOTAL_MB || 25);
  return mb * 1024 * 1024;
}

const objectKey = (id) => "photos/" + id + ".jpg";

// Reads width/height from the JPEG header (so we never trust the client) and checks it is a real JPEG.
function jpegInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

function totalBytes() {
  return Number(db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM photos").get().total);
}

async function save({ id, userId, buffer }) {
  const info = jpegInfo(buffer);
  if (!info) throw Object.assign(new Error("Ifoto igomba kuba JPEG nyayo."), { status: 400 });
  if (info.width > 4000 || info.height > 4000) throw Object.assign(new Error("Ifoto ni nini cyane."), { status: 400 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error("Ifoto irenze ingano yemewe (" + Math.round(MAX_BYTES / 1024) + " KB)."), { status: 413 });
  if (totalBytes() + buffer.length > maxTotalBytes()) {
    throw Object.assign(new Error("Ububiko bw’amafoto bwuzuye. Vugana na admin."), { status: 507 });
  }
  const useR2 = r2.enabled();
  if (useR2) {
    try {
      await r2.put(objectKey(id), buffer);
    } catch (error) {
      console.error("R2 upload failed:", error.message);
      throw Object.assign(new Error("Ifoto ntiyabashije kujya mu bubiko. Ongera ugerageze."), { status: 502 });
    }
  }
  try {
    db.prepare("INSERT INTO photos (id, uploaded_by, width, height, bytes, data, storage) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, info.width, info.height, buffer.length, useR2 ? EMPTY : buffer, useR2 ? "r2" : "db");
  } catch (error) {
    if (useR2) removeObjects([id]);
    throw error;
  }
  persistence.markDirty();
  return { id, width: info.width, height: info.height, bytes: buffer.length };
}

// Returns { id, width, height, data } or null when the photo (or its stored bytes) cannot be found.
async function read(id) {
  if (typeof id !== "string") return null;
  const row = db.prepare("SELECT id, width, height, data, storage FROM photos WHERE id = ?").get(id);
  if (!row) return null;
  if (row.storage === "r2") {
    const data = await r2.get(objectKey(row.id));
    return data ? { id: row.id, width: row.width, height: row.height, data } : null;
  }
  return { id: row.id, width: row.width, height: row.height, data: Buffer.from(row.data) };
}

// Loads many photos at once (for Word export) into a Map(id -> photo), a few at a time.
async function readMany(ids, concurrency = 6) {
  const map = new Map();
  const queue = [...new Set(ids)];
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      try {
        const photo = await read(id);
        if (photo) map.set(id, photo);
      } catch (error) {
        console.error("Photo read failed:", error.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return map;
}

function idsOf(report) {
  const ids = [];
  (Array.isArray(report && report.targets) ? report.targets : []).forEach((target) => {
    const list = target && target.details && target.details.photos;
    if (Array.isArray(list)) list.forEach((item) => { if (item && typeof item.id === "string") ids.push(item.id); });
  });
  return [...new Set(ids)];
}

// Returns an error message when a report points at photos it is not allowed to use.
function checkReferences(report, reportId, user) {
  const ids = idsOf(report);
  if (ids.length > MAX_PER_REPORT) return "Raporo ifite amafoto menshi cyane (uzuza " + MAX_PER_REPORT + " cyangwa munsi).";
  for (const id of ids) {
    const row = db.prepare("SELECT report_id, uploaded_by FROM photos WHERE id = ?").get(id);
    if (!row) return "Ifoto imwe cyangwa nyinshi ntizibonetse kuri server. Zongere ukoherezeho.";
    const free = row.report_id === null && (row.uploaded_by === user.id || user.role === "ADMIN");
    if (row.report_id !== reportId && !free) return "Hari ifoto itemewe kuri iyi raporo.";
  }
  return null;
}

// Best effort and non-blocking: a failed delete only leaves an unused object in the bucket (logged).
function removeObjects(ids) {
  if (!r2.enabled()) return;
  ids.forEach((id) => {
    r2.del(objectKey(id)).catch((error) => console.error("R2 delete failed for " + id + ":", error.message));
  });
}

// Links the referenced photos to the report and removes photos the report no longer lists.
function sync(report, reportId) {
  const ids = idsOf(report);
  let dropped = [];
  db.exec("BEGIN");
  try {
    const link = db.prepare("UPDATE photos SET report_id = ? WHERE id = ?");
    ids.forEach((id) => link.run(reportId, id));
    const current = db.prepare("SELECT id, storage FROM photos WHERE report_id = ?").all(reportId);
    const drop = db.prepare("DELETE FROM photos WHERE id = ?");
    dropped = current.filter((row) => !ids.includes(row.id));
    dropped.forEach((row) => drop.run(row.id));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  removeObjects(dropped.filter((row) => row.storage === "r2").map((row) => row.id));
  persistence.markDirty();
}

// Call before deleting a report: removes its photo rows and their R2 objects (the FK cascade alone would orphan the objects).
function releaseReport(reportId) {
  const rows = db.prepare("SELECT id, storage FROM photos WHERE report_id = ?").all(reportId);
  if (!rows.length) return;
  db.prepare("DELETE FROM photos WHERE report_id = ?").run(reportId);
  removeObjects(rows.filter((row) => row.storage === "r2").map((row) => row.id));
  persistence.markDirty();
}

function purgeOrphans() {
  const age = "-" + ORPHAN_HOURS + " hours";
  const rows = db.prepare("SELECT id, storage FROM photos WHERE report_id IS NULL AND created_at < datetime('now', ?)").all(age);
  if (!rows.length) return 0;
  const result = db.prepare("DELETE FROM photos WHERE report_id IS NULL AND created_at < datetime('now', ?)").run(age);
  removeObjects(rows.filter((row) => row.storage === "r2").map((row) => row.id));
  if (result.changes) persistence.markDirty();
  return Number(result.changes);
}

// Moves photos that are still stored inside SQLite to R2 (one by one; safe to run again after a restart).
async function migrateToR2() {
  if (!r2.enabled()) return 0;
  const rows = db.prepare("SELECT id FROM photos WHERE storage = 'db'").all();
  let moved = 0;
  for (const { id } of rows) {
    try {
      const row = db.prepare("SELECT data FROM photos WHERE id = ? AND storage = 'db'").get(id);
      if (!row) continue;
      await r2.put(objectKey(id), Buffer.from(row.data));
      db.prepare("UPDATE photos SET storage = 'r2', data = ? WHERE id = ? AND storage = 'db'").run(EMPTY, id);
      moved += 1;
    } catch (error) {
      console.error("Photo migration to R2 stopped at " + id + ":", error.message);
      break;
    }
  }
  if (moved) {
    persistence.markDirty();
    console.log("Moved " + moved + " photo(s) from SQLite to R2.");
  }
  return moved;
}

module.exports = { jpegInfo, save, read, readMany, idsOf, checkReferences, sync, releaseReport, purgeOrphans, migrateToR2, totalBytes, MAX_BYTES };
