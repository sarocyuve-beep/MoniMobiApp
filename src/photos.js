// Report photos: stored as small JPEG blobs in the same SQLite database (and therefore
// included in the encrypted GitHub snapshot). The browser shrinks every photo before upload.
const { db } = require("./db");
const persistence = require("./persist");

const MAX_BYTES = Number(process.env.PHOTO_MAX_BYTES || 600 * 1024);
const MAX_TOTAL_BYTES = Number(process.env.PHOTO_MAX_TOTAL_MB || 25) * 1024 * 1024;
const MAX_PER_REPORT = 30;
const ORPHAN_HOURS = 24;

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

function save({ id, userId, buffer }) {
  const info = jpegInfo(buffer);
  if (!info) throw Object.assign(new Error("Ifoto igomba kuba JPEG nyayo."), { status: 400 });
  if (info.width > 4000 || info.height > 4000) throw Object.assign(new Error("Ifoto ni nini cyane."), { status: 400 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error("Ifoto irenze ingano yemewe (" + Math.round(MAX_BYTES / 1024) + " KB)."), { status: 413 });
  if (totalBytes() + buffer.length > MAX_TOTAL_BYTES) {
    throw Object.assign(new Error("Ububiko bw’amafoto bwuzuye. Vugana na admin."), { status: 507 });
  }
  db.prepare("INSERT INTO photos (id, uploaded_by, width, height, bytes, data) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, userId, info.width, info.height, buffer.length, buffer);
  persistence.markDirty();
  return { id, width: info.width, height: info.height, bytes: buffer.length };
}

function read(id) {
  if (typeof id !== "string") return null;
  const row = db.prepare("SELECT id, width, height, data FROM photos WHERE id = ?").get(id);
  return row ? { id: row.id, width: row.width, height: row.height, data: Buffer.from(row.data) } : null;
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

// Links the referenced photos to the report and removes photos the report no longer lists.
function sync(report, reportId) {
  const ids = idsOf(report);
  db.exec("BEGIN");
  try {
    const link = db.prepare("UPDATE photos SET report_id = ? WHERE id = ?");
    ids.forEach((id) => link.run(reportId, id));
    const current = db.prepare("SELECT id FROM photos WHERE report_id = ?").all(reportId);
    const drop = db.prepare("DELETE FROM photos WHERE id = ?");
    current.filter((row) => !ids.includes(row.id)).forEach((row) => drop.run(row.id));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  persistence.markDirty();
}

function purgeOrphans() {
  const result = db.prepare("DELETE FROM photos WHERE report_id IS NULL AND created_at < datetime('now', ?)").run("-" + ORPHAN_HOURS + " hours");
  if (result.changes) persistence.markDirty();
  return Number(result.changes);
}

module.exports = { jpegInfo, save, read, checkReferences, sync, purgeOrphans, totalBytes, MAX_BYTES };
