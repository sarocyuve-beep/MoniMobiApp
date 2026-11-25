require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const helmet = require("helmet");
const { db } = require("./db");
const { login, publicUser: basePublicUser, requireAuth, requireAdmin } = require("./auth");
const persistence = require("./persist");
const { buildReportDocx, docxFileName } = require("./docx-report");

const app = express();
const publicDirectory = path.resolve(__dirname, "..");
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"]
    }
  }
}));
app.use(express.json({ limit: "10mb" }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT || 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Wagerageje kwinjira inshuro nyinshi. Ongera ugerageze nyuma." }
});

const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.ACCOUNT_REQUEST_RATE_LIMIT || 5),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Wasabye inshuro nyinshi. Ongera ugerageze nyuma y’isaha." }
});

function publicUser(user) {
  return { ...basePublicUser(user), level: user.level || "", cell: user.cell || "", jobTitle: user.job_title || "", duties: user.duties || "" };
}

let cachedLocationNames;
function locationNames() {
  if (!cachedLocationNames) {
    try {
      const source = fs.readFileSync(path.join(publicDirectory, "data.js"), "utf8");
      const json = source.replace(/^\s*window\.REPORT_DATA\s*=\s*/, "").replace(/;\s*$/, "");
      cachedLocationNames = (JSON.parse(json).locations || []).map((item) => item.name);
    } catch {
      cachedLocationNames = [];
    }
  }
  return cachedLocationNames;
}

// Urwego, akagari, icyo ashinzwe (function) n’icyo ashinzwe mu mpine (bikoreshwa mu kwisaba konti).
function readProfile(body) {
  const level = typeof body.level === "string" ? body.level.trim() : "";
  const cell = typeof body.cell === "string" ? body.cell.trim() : "";
  const jobTitle = typeof body.jobTitle === "string" ? body.jobTitle.trim().replace(/\s+/g, " ") : "";
  if (!["Umurenge", "Akagari"].includes(level)) return { error: "Hitamo urwego: Umurenge cyangwa Akagari." };
  if (level === "Akagari") {
    const names = locationNames();
    if (names.length ? !names.includes(cell) : (!cell || cell.length > 60)) return { error: "Hitamo akagari ukoreramo." };
  }
  if (jobTitle.length < 3 || jobTitle.length > 100) return { error: "Andika icyo ushinzwe (inyuguti 3–100)." };
  const duties = typeof body.duties === "string" ? body.duties.trim().replace(/\s+/g, " ") : "";
  if (duties.length < 3 || duties.length > 200) return { error: "Andika icyo ushinzwe mu mpine (inyuguti 3–200)." };
  return { level, cell: level === "Akagari" ? cell : "", jobTitle, duties };
}

// node:sqlite ntishyiraho `code` imwe muri buri bwoko bwa Node, bityo turebera no kuri errcode n’ubutumwa.
function isUniqueViolation(error) {
  return error && (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.errcode === 2067 || /UNIQUE constraint failed/i.test(String(error.message)));
}

function logAction(actorId, action, targetId) {
  db.prepare("INSERT INTO audit_log (actor_user_id, action, target_id) VALUES (?, ?, ?)")
    .run(actorId || null, action, targetId || null);
  persistence.markDirty();
}

function reportFromRow(row) {
  return {
    ...JSON.parse(row.data_json),
    id: row.id,
    reportNumber: row.report_number,
    beneficiaryName: row.beneficiary_name,
    updatedAt: row.updated_at,
    owner: { id: row.created_by, username: row.owner_username, fullName: row.owner_name }
  };
}

function mayEditReport(user, row) {
  return user.role === "ADMIN" || row.created_by === user.id;
}

function validateReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report) ||
      !report.fields || typeof report.fields !== "object" || Array.isArray(report.fields)) {
    return "Imiterere ya raporo ntiyemewe.";
  }
  if (JSON.stringify(report).length > 750000) return "Raporo irenze ingano yemewe.";
  return null;
}

const reportSelect = `
  SELECT r.*, u.username AS owner_username, u.full_name AS owner_name
  FROM reports r JOIN users u ON u.id = r.created_by
`;

app.get("/api/health", (req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({
      ok: true,
      database: "ok",
      backupConfigured: persistence.enabled,
      timestamp: new Date().toISOString()
    });
  } catch {
    res.status(503).json({ ok: false, database: "error" });
  }
});

app.post("/api/auth/login", loginLimiter, (req, res) => {
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!username || !password) return res.status(400).json({ error: "Andika izina rya konti n’ijambo ry’ibanga." });

  const result = login(username, password);
  if (!result) {
    const request = db.prepare("SELECT * FROM account_requests WHERE username = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1").get(username);
    if (request && request.status !== "APPROVED" && bcrypt.compareSync(password, request.password_hash)) {
      return res.status(403).json({
        error: request.status === "PENDING"
          ? "Ubusabe bwawe bwo gufungura konti buracyategereje kwemezwa n’umuyobozi (admin)."
          : "Ubusabe bwawe bwo gufungura konti ntibwemewe. Vugana n’umuyobozi (admin)."
      });
    }
    const account = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
    const reset = account && db.prepare("SELECT password_hash FROM password_resets WHERE user_id = ? AND status = 'PENDING'").get(account.id);
    if (reset && bcrypt.compareSync(password, reset.password_hash)) {
      return res.status(403).json({ error: "Ubusabe bwo guhindura ijambo ry’ibanga buracyategereje kwemezwa n’umuyobozi (admin)." });
    }
    return res.status(401).json({ error: "Izina rya konti cyangwa ijambo ry’ibanga si byo." });
  }
  logAction(result.user.id, "LOGIN");
  const loggedIn = db.prepare("SELECT * FROM users WHERE id = ?").get(result.user.id);
  res.json({ ...result, user: publicUser(loggedIn) });
});

app.post("/api/auth/request-account", requestLimiter, (req, res) => {
  const fullName = typeof req.body.fullName === "string" ? req.body.fullName.trim().replace(/\s+/g, " ") : "";
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (fullName.length < 3 || fullName.length > 100 || !/^[a-zA-Z0-9._-]{3,40}$/.test(username) || password.length < 12 || password.length > 200) {
    return res.status(400).json({ error: "Andika amazina yuzuye, username y’inyuguti 3–40 (inyuguti, imibare, . _ -), n’ijambo ry’ibanga ry’inyuguti 12 nibura." });
  }
  const profile = readProfile(req.body);
  if (profile.error) return res.status(400).json({ error: profile.error });
  if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
    return res.status(409).json({ error: "Iyo username isanzwe ikoreshwa. Hitamo indi." });
  }
  try {
    const result = db.prepare("INSERT INTO account_requests (username, full_name, password_hash, level, cell, job_title, duties) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(username, fullName, bcrypt.hashSync(password, 12), profile.level, profile.cell, profile.jobTitle, profile.duties);
    logAction(null, "REQUEST_ACCOUNT", String(result.lastInsertRowid));
    res.status(201).json({ message: "Ubusabe bwoherejwe. Utegereze ko admin abwemeza, hanyuma winjire ukoresheje username n’ijambo ry’ibanga wahisemo." });
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "Hari ubusabe bukoresha iyo username bukitegerejwe. Hitamo indi." });
    throw error;
  }
});

app.get("/api/account-requests", requireAuth, requireAdmin, (req, res) => {
  const requests = db.prepare(`
    SELECT id, username, full_name AS fullName, level, cell, job_title AS jobTitle, duties, created_at AS createdAt
    FROM account_requests WHERE status = 'PENDING' ORDER BY id
  `).all();
  res.json({ requests });
});

app.post("/api/account-requests/:id/approve", requireAuth, requireAdmin, (req, res) => {
  const request = db.prepare("SELECT * FROM account_requests WHERE id = ? AND status = 'PENDING'").get(Number(req.params.id));
  if (!request) return res.status(404).json({ error: "Ubusabe ntibwabonetse cyangwa bwamaze gufatwaho icyemezo." });
  if (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(request.username)) {
    return res.status(409).json({ error: "Iyo username isanzwe ikoreshwa. Wange ubu busabe." });
  }
  let userId;
  db.exec("BEGIN");
  try {
    // Umukozi yihitiyemo ijambo ry’ibanga, bityo ntasabwa kurihindura.
    userId = db.prepare(`
      INSERT INTO users (username, full_name, password_hash, role, must_change_password, level, cell, job_title, duties)
      VALUES (?, ?, ?, 'EMPLOYEE', 0, ?, ?, ?, ?)
    `).run(request.username, request.full_name, request.password_hash, request.level || null, request.cell || null, request.job_title || null, request.duties || null).lastInsertRowid;
    db.prepare("UPDATE account_requests SET status = 'APPROVED', decided_by = ?, decided_at = datetime('now') WHERE id = ?")
      .run(req.user.id, request.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  logAction(req.user.id, "APPROVE_ACCOUNT", String(userId));
  res.json({ message: "Konti y’umukozi yemejwe." });
});

app.post("/api/account-requests/:id/reject", requireAuth, requireAdmin, (req, res) => {
  const result = db.prepare("UPDATE account_requests SET status = 'REJECTED', decided_by = ?, decided_at = datetime('now') WHERE id = ? AND status = 'PENDING'")
    .run(req.user.id, Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: "Ubusabe ntibwabonetse cyangwa bwamaze gufatwaho icyemezo." });
  logAction(req.user.id, "REJECT_ACCOUNT", req.params.id);
  res.json({ message: "Ubusabe bwanzwe." });
});

// Kwibagirwa ijambo ry’ibanga: uwibagiwe yandika irishya, admin akaryemeza.
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.ACCOUNT_REQUEST_RATE_LIMIT || 5),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Wasabye inshuro nyinshi. Ongera ugerageze nyuma y’isaha." }
});

app.post("/api/auth/forgot-password", forgotLimiter, (req, res) => {
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username) || newPassword.length < 12 || newPassword.length > 200) {
    return res.status(400).json({ error: "Andika username n’ijambo ry’ibanga rishya ry’inyuguti 12 nibura." });
  }
  const hash = bcrypt.hashSync(newPassword, 12); // buri gihe, kugira ngo igihe gitwara kitagaragaza niba username ibaho
  const user = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND is_active = 1").get(username);
  if (user) {
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE password_resets SET status = 'REJECTED', decided_at = datetime('now') WHERE user_id = ? AND status = 'PENDING'").run(user.id);
      db.prepare("INSERT INTO password_resets (user_id, password_hash) VALUES (?, ?)").run(user.id, hash);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    logAction(null, "REQUEST_PASSWORD_RESET", String(user.id));
  }
  // Igisubizo ni kimwe haba username ibaho cyangwa itabaho.
  res.status(202).json({ message: "Ubusabe bwoherejwe. Niba username ibaho, admin azabwemeza, hanyuma winjire ukoresheje ijambo ry’ibanga rishya wanditse." });
});

app.get("/api/password-resets", requireAuth, requireAdmin, (req, res) => {
  const resets = db.prepare(`
    SELECT p.id, u.username, u.full_name AS fullName, u.role, u.level, u.cell, u.job_title AS jobTitle, u.duties, p.created_at AS createdAt
    FROM password_resets p JOIN users u ON u.id = p.user_id
    WHERE p.status = 'PENDING' ORDER BY p.id
  `).all();
  res.json({ resets });
});

app.post("/api/password-resets/:id/approve", requireAuth, requireAdmin, (req, res) => {
  const reset = db.prepare("SELECT * FROM password_resets WHERE id = ? AND status = 'PENDING'").get(Number(req.params.id));
  if (!reset) return res.status(404).json({ error: "Ubusabe ntibwabonetse cyangwa bwamaze gufatwaho icyemezo." });
  if (reset.user_id === req.user.id) return res.status(400).json({ error: "Ntushobora kwemeza ubusabe bwawe bwite. Saba undi admin." });
  const user = db.prepare("SELECT id, is_active FROM users WHERE id = ?").get(reset.user_id);
  if (!user || !user.is_active) return res.status(409).json({ error: "Iyi konti ntikora. Wange ubu busabe." });
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(reset.password_hash, reset.user_id);
    db.prepare("UPDATE password_resets SET status = 'APPROVED', decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(req.user.id, reset.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  logAction(req.user.id, "APPROVE_PASSWORD_RESET", String(reset.user_id));
  res.json({ message: "Ijambo ry’ibanga rishya ryemejwe." });
});

app.post("/api/password-resets/:id/reject", requireAuth, requireAdmin, (req, res) => {
  const result = db.prepare("UPDATE password_resets SET status = 'REJECTED', decided_by = ?, decided_at = datetime('now') WHERE id = ? AND status = 'PENDING'")
    .run(req.user.id, Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: "Ubusabe ntibwabonetse cyangwa bwamaze gufatwaho icyemezo." });
  logAction(req.user.id, "REJECT_PASSWORD_RESET", req.params.id);
  res.json({ message: "Ubusabe bwanzwe." });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const currentPassword = typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
  const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";
  if (!bcrypt.compareSync(currentPassword, req.user.password_hash)) {
    return res.status(400).json({ error: "Ijambo ry’ibanga rishaje si ryo." });
  }
  if (newPassword.length < 12) {
    return res.status(400).json({ error: "Ijambo rishya rigomba kugira inyuguti 12 nibura." });
  }
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
    .run(bcrypt.hashSync(newPassword, 12), req.user.id);
  logAction(req.user.id, "CHANGE_PASSWORD");
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id)) });
});

app.get("/api/reports", requireAuth, (req, res) => {
  const rows = db.prepare(reportSelect + " ORDER BY r.updated_at DESC").all();
  res.json({ reports: rows.map(reportFromRow) });
});

app.post("/api/reports/docx", requireAuth, async (req, res) => {
  let reports;
  if (req.body && Array.isArray(req.body.ids) && req.body.ids.length) {
    const ids = req.body.ids;
    if (ids.length > 50 || ids.some((id) => typeof id !== "string")) {
      return res.status(400).json({ error: "Hitamo raporo kuva kuri 1 kugeza kuri 50." });
    }
    reports = ids.map((id) => db.prepare(reportSelect + " WHERE r.id = ?").get(id)).filter(Boolean).map(reportFromRow);
    if (reports.length !== ids.length) return res.status(404).json({ error: "Hari raporo itabonetse." });
  } else if (req.body && req.body.report && typeof req.body.report === "object") {
    reports = [req.body.report];
  } else {
    return res.status(400).json({ error: "Hitamo raporo cyangwa ohereza raporo yo gukorera Word." });
  }

  try {
    const buffer = await buildReportDocx(reports, {
      staffName: req.user.full_name,
      authorityName: req.body && req.body.authorityName,
      authorityTitle: req.body && req.body.authorityTitle,
      memoText: req.body && req.body.memoText
    });
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": 'attachment; filename="' + docxFileName(reports) + '"'
    });
    res.send(buffer);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/reports/:id", requireAuth, (req, res) => {
  const row = db.prepare(reportSelect + " WHERE r.id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Raporo ntiyabonetse." });
  res.json({ report: reportFromRow(row) });
});

app.post("/api/reports", requireAuth, (req, res) => {
  const invalid = validateReport(req.body);
  if (invalid) return res.status(400).json({ error: invalid });

  const id = crypto.randomUUID();
  const report = { ...req.body, id: undefined, owner: undefined, updatedAt: undefined };
  const reportNumber = String(report.fields.reportNumber || "").trim();
  if (!reportNumber) return res.status(400).json({ error: "Raporo igomba kugira nomero." });

  const now = new Date().toISOString();
  const beneficiaryName = String(
    report.fields.beneficiaryName ||
    (Array.isArray(report.targets) && report.targets.map((t) => (Array.isArray(t.beneficiaries) ? t.beneficiaries.map((b) => b.name).join(", ") : t.beneficiaries || "")).filter(Boolean).join("; ")) ||
    ""
  );
  if (!report.fields.beneficiaryName) report.fields.beneficiaryName = beneficiaryName;
  db.prepare(`
    INSERT INTO reports (id, report_number, visit_date, beneficiary_name, data_json, created_by, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    reportNumber,
    String(report.fields.visitDate || ""),
    beneficiaryName,
    JSON.stringify(report),
    req.user.id,
    req.user.id,
    now
  );
  logAction(req.user.id, "CREATE_REPORT", id);
  res.status(201).json({ report: reportFromRow(db.prepare(reportSelect + " WHERE r.id = ?").get(id)) });
});

app.put("/api/reports/:id", requireAuth, (req, res) => {
  const invalid = validateReport(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  const existing = db.prepare(reportSelect + " WHERE r.id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Raporo ntiyabonetse." });
  if (!mayEditReport(req.user, existing)) return res.status(403).json({ error: "Nta burenganzira ufite kuri iyi raporo." });
  if (!req.body.expectedUpdatedAt || req.body.expectedUpdatedAt !== existing.updated_at) {
    return res.status(409).json({ error: "Undi muntu yahinduye iyi raporo. Ongera uyifungure mbere yo kubika." });
  }

  const report = { ...req.body, id: undefined, owner: undefined, updatedAt: undefined, expectedUpdatedAt: undefined };
  const reportNumber = String(report.fields.reportNumber || "").trim();
  if (!reportNumber) return res.status(400).json({ error: "Raporo igomba kugira nomero." });
  const now = new Date().toISOString();
  const beneficiaryName = String(
    report.fields.beneficiaryName ||
    (Array.isArray(report.targets) && report.targets.map((t) => (Array.isArray(t.beneficiaries) ? t.beneficiaries.map((b) => b.name).join(", ") : t.beneficiaries || "")).filter(Boolean).join("; ")) ||
    ""
  );
  if (!report.fields.beneficiaryName) report.fields.beneficiaryName = beneficiaryName;
  db.prepare(`
    UPDATE reports SET report_number = ?, visit_date = ?, beneficiary_name = ?, data_json = ?, updated_by = ?, updated_at = ?
    WHERE id = ?
  `).run(
    reportNumber,
    String(report.fields.visitDate || ""),
    beneficiaryName,
    JSON.stringify(report),
    req.user.id,
    now,
    req.params.id
  );
  logAction(req.user.id, "UPDATE_REPORT", req.params.id);
  res.json({ report: reportFromRow(db.prepare(reportSelect + " WHERE r.id = ?").get(req.params.id)) });
});

app.delete("/api/reports/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Raporo ntiyabonetse." });
  if (!mayEditReport(req.user, row)) return res.status(403).json({ error: "Nta burenganzira ufite kuri iyi raporo." });
  db.prepare("DELETE FROM reports WHERE id = ?").run(req.params.id);
  logAction(req.user.id, "DELETE_REPORT", req.params.id);
  res.status(204).end();
});

app.post("/api/reports/import", requireAuth, (req, res) => {
  const reports = req.body && req.body.reports;
  if (!Array.isArray(reports) || reports.length > 500) {
    return res.status(400).json({ error: "Hitamo raporo zitarenze 500 zo kwimura." });
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO reports
      (id, legacy_id, report_number, visit_date, beneficiary_name, data_json, created_by, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const importReports = (items) => {
    let imported = 0;
    db.exec("BEGIN");
    try {
      for (const item of items) {
        const invalid = validateReport(item.report);
        if (invalid) throw new Error(invalid);
        const reportNumber = String(item.report.fields.reportNumber || "").trim();
        const sourceId = String(item.legacyId || "").trim();
        if (!reportNumber || !sourceId || sourceId.length > 200) throw new Error("Raporo yoherejwe ntifite nomero yemewe.");
        const now = new Date().toISOString();
        const result = insert.run(
          crypto.randomUUID(),
          req.user.id + ":" + sourceId,
          reportNumber,
          String(item.report.fields.visitDate || ""),
          String(item.report.fields.beneficiaryName || ""),
          JSON.stringify(item.report),
          req.user.id,
          req.user.id,
          now
        );
        if (result.changes) imported += 1;
      }
      db.exec("COMMIT");
      return imported;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  try {
    const imported = importReports(reports);
    if (imported) logAction(req.user.id, "IMPORT_REPORTS", String(imported));
    res.json({ imported, total: reports.length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/users", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, full_name AS fullName, role, level, cell, job_title AS jobTitle, duties, is_active AS isActive, created_at AS createdAt
    FROM users ORDER BY full_name COLLATE NOCASE
  `).all();
  res.json({ users });
});

app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
  const fullName = typeof req.body.fullName === "string" ? req.body.fullName.trim() : "";
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body.temporaryPassword === "string" ? req.body.temporaryPassword : "";
  if (!fullName || !/^[a-zA-Z0-9._-]{3,40}$/.test(username) || password.length < 12) {
    return res.status(400).json({ error: "Andika amazina, username y’inyuguti 3–40, n’ijambo ry’ibanga ry’inyuguti 12 nibura." });
  }
  try {
    const result = db.prepare(`
      INSERT INTO users (username, full_name, password_hash, role)
      VALUES (?, ?, ?, 'EMPLOYEE')
    `).run(username, fullName, bcrypt.hashSync(password, 12));
    logAction(req.user.id, "CREATE_USER", String(result.lastInsertRowid));
    res.status(201).json({ message: "Konti y’umukozi yakozwe." });
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: "Iyo username isanzwe ikoreshwa." });
    throw error;
  }
});

app.patch("/api/users/:id/status", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT id, role, is_active FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "Konti ntiyabonetse." });
  if (id === req.user.id && req.body.isActive === false) return res.status(400).json({ error: "Ntushobora guhagarika konti winjiyemo." });
  if (user.role === "ADMIN" && req.body.isActive === false) {
    const activeAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND is_active = 1").get().count;
    if (activeAdmins <= 1) return res.status(400).json({ error: "Sisitemu igomba kugira admin nibura umwe ukora." });
  }
  if (typeof req.body.isActive !== "boolean") return res.status(400).json({ error: "Hitamo niba konti ikora cyangwa idakora." });
  db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(Number(req.body.isActive), id);
  logAction(req.user.id, req.body.isActive ? "ACTIVATE_USER" : "DEACTIVATE_USER", String(id));
  res.json({ message: "Imiterere ya konti yahinduwe." });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "Ntushobora gusuba konti winjiyemo." });
  const user = db.prepare("SELECT id, role, is_active FROM users WHERE id = ?").get(id);
  if (!user) return res.status(404).json({ error: "Konti ntiyabonetse." });
  if (user.role === "ADMIN") {
    const activeAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND is_active = 1").get().count;
    if (activeAdmins <= 1) return res.status(400).json({ error: "Sisitemu igomba kugira admin nibura umwe ukora." });
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  logAction(req.user.id, "DELETE_USER", String(id));
  res.status(204).end();
});

app.get("/", (req, res) => res.sendFile(path.join(publicDirectory, "index.html")));
app.get("/data.js", (req, res) => res.sendFile(path.join(publicDirectory, "data.js")));
app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint ntiyabonetse." }));

app.use((error, req, res, next) => {
  console.error("Request failed:", error.message);
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ error: "Amakuru wohereje ntiyemewe." });
  }
  res.status(500).json({ error: "Habaye ikibazo kuri server. Ongera ugerageze." });
});

module.exports = app;
