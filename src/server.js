require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const helmet = require("helmet");
const { db } = require("./db");
const { login, publicUser, requireAuth, requireAdmin } = require("./auth");
const persistence = require("./persist");

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
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Wagerageje kwinjira inshuro nyinshi. Ongera ugerageze nyuma." }
});

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
  if (!result) return res.status(401).json({ error: "Izina rya konti cyangwa ijambo ry’ibanga si byo." });
  logAction(result.user.id, "LOGIN");
  res.json(result);
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
  db.prepare(`
    INSERT INTO reports (id, report_number, visit_date, beneficiary_name, data_json, created_by, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    reportNumber,
    String(report.fields.visitDate || ""),
    String(report.fields.beneficiaryName || ""),
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
  db.prepare(`
    UPDATE reports SET report_number = ?, visit_date = ?, beneficiary_name = ?, data_json = ?, updated_by = ?, updated_at = ?
    WHERE id = ?
  `).run(
    reportNumber,
    String(report.fields.visitDate || ""),
    String(report.fields.beneficiaryName || ""),
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
    SELECT id, username, full_name AS fullName, role, is_active AS isActive, created_at AS createdAt
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
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "Iyo username isanzwe ikoreshwa." });
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
