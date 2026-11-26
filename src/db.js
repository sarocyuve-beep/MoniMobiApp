const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dbPath = path.resolve(process.env.DB_PATH || "./data/monimobi.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'EMPLOYEE')),
    is_active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    legacy_id TEXT UNIQUE,
    report_number TEXT NOT NULL,
    visit_date TEXT,
    beneficiary_name TEXT,
    data_json TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (updated_by) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER,
    action TEXT NOT NULL,
    target_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS account_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by INTEGER,
    decided_at TEXT,
    FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by INTEGER,
    decided_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_password_resets_pending ON password_resets(user_id) WHERE status = 'PENDING';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_account_requests_pending ON account_requests(username) WHERE status = 'PENDING';
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    report_id TEXT,
    uploaded_by INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_photos_report ON photos(report_id);
  CREATE INDEX IF NOT EXISTS idx_reports_updated_at ON reports(updated_at);
  CREATE INDEX IF NOT EXISTS idx_reports_created_by ON reports(created_by);
  CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
`);
const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
if (!userColumns.includes("must_change_password")) {
  db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1");
}

function addColumn(table, column, definition) {
  const names = db.prepare("PRAGMA table_info(" + table + ")").all().map((item) => item.name);
  if (!names.includes(column)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
}
// Urwego (Umurenge/Akagari), akagari, icyo umukozi ashinzwe (function) n’icyo ashinzwe mu mpine.
for (const table of ["users", "account_requests"]) {
  addColumn(table, "level", "TEXT");
  addColumn(table, "cell", "TEXT");
  addColumn(table, "job_title", "TEXT");
  addColumn(table, "duties", "TEXT"); // icyo ashinzwe mu mpine (inshingano mu magambo make)
}

// Aho ifoto ibitse: 'db' (muri SQLite) cyangwa 'r2' (Cloudflare R2; SQLite ibika amakuru make gusa).
addColumn("photos", "storage", "TEXT NOT NULL DEFAULT 'db'");

function ensureAdmin({ username, password, fullName }) {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1").get();
  if (existing) return false;
  if (!username || !password || !fullName) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Set ADMIN_USERNAME, ADMIN_PASSWORD, and ADMIN_FULL_NAME for the first admin account.");
    }
    return false;
  }
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must contain at least 12 characters.");
  const bcrypt = require("bcryptjs");
  db.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, 'ADMIN')")
    .run(username.trim(), fullName.trim(), bcrypt.hashSync(password, 12));
  console.log("Created the initial administrator account.");
  return true;
}

// Kugarura uburyo bwo kwinjira nka admin (urugero admin wibagiwe ijambo ry’ibanga cyangwa nta admin ukiriho).
// Bikora gusa iyo ADMIN_RESET_ON_START=true, ADMIN_USERNAME na ADMIN_PASSWORD (12+) byashyizweho muri Render.
function resetAdmin({ username, password, fullName }) {
  const name = typeof username === "string" ? username.trim() : "";
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(name) || !password || password.length < 12) {
    throw new Error("ADMIN_RESET_ON_START needs a valid ADMIN_USERNAME and an ADMIN_PASSWORD of at least 12 characters.");
  }
  const bcrypt = require("bcryptjs");
  const hash = bcrypt.hashSync(password, 12);
  const existing = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(name);
  if (existing) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'ADMIN', is_active = 1, must_change_password = 1 WHERE id = ?").run(hash, existing.id);
    db.prepare("UPDATE password_resets SET status = 'REJECTED', decided_at = datetime('now') WHERE user_id = ? AND status = 'PENDING'").run(existing.id);
  } else {
    db.prepare("INSERT INTO users (username, full_name, password_hash, role, must_change_password) VALUES (?, ?, ?, 'ADMIN', 1)")
      .run(name, (fullName || name).trim(), hash);
  }
  console.warn("ADMIN ACCESS RESET for \"" + name + "\". Set ADMIN_RESET_ON_START back to false now, otherwise the password is reset on every restart.");
  return true;
}

module.exports = { db, dbPath, ensureAdmin, resetAdmin };
