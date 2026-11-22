const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "monimobi-test-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(temporaryDirectory, "test.sqlite");
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");

const { db, ensureAdmin } = require("../src/db");
const bcrypt = require("bcryptjs");
ensureAdmin({ username: "admin", password: "admin-password-123", fullName: "Admin Test" });
db.prepare("UPDATE users SET must_change_password = 0").run();
db.prepare("INSERT INTO users (username, full_name, password_hash, role, must_change_password) VALUES (?, ?, ?, 'EMPLOYEE', 0)")
  .run("staff1", "Staff One", bcrypt.hashSync("staff-password-123", 4));
db.prepare("INSERT INTO users (username, full_name, password_hash, role, must_change_password) VALUES (?, ?, ?, 'EMPLOYEE', 0)")
  .run("staff2", "Staff Two", bcrypt.hashSync("other-password-123", 4));

const app = require("../src/server");
let server;
let baseUrl;
let adminToken;
let staffToken;
let otherStaffToken;

async function request(pathname, { token, method = "GET", body } = {}) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const result = response.status === 204 ? null : await response.json();
  return { response, result };
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;

  const admin = await request("/api/auth/login", { method: "POST", body: { username: "admin", password: "admin-password-123" } });
  const staff = await request("/api/auth/login", { method: "POST", body: { username: "staff1", password: "staff-password-123" } });
  const other = await request("/api/auth/login", { method: "POST", body: { username: "staff2", password: "other-password-123" } });
  adminToken = admin.result.token;
  staffToken = staff.result.token;
  otherStaffToken = other.result.token;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("health endpoint is public and reports the database status", async () => {
  const { response, result } = await request("/api/health");
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.database, "ok");
});

test("only the report app and its public data file are served", async () => {
  const appPage = await fetch(baseUrl + "/");
  const dataFile = await fetch(baseUrl + "/data.js");
  const serverSource = await fetch(baseUrl + "/src/server.js");
  assert.equal(appPage.status, 200);
  assert.equal(dataFile.status, 200);
  assert.equal(serverSource.status, 404);
});

test("employees can view shared reports but only edit their own; admins can view all", async () => {
  const created = await request("/api/reports", {
    token: staffToken,
    method: "POST",
    body: { version: 3, fields: { reportNumber: "MUS-TEST-1", beneficiaryName: "Test Farmer" }, actions: [], followups: [] }
  });
  assert.equal(created.response.status, 201);
  const reportId = created.result.report.id;

  const ownReports = await request("/api/reports", { token: staffToken });
  const sharedReports = await request("/api/reports", { token: otherStaffToken });
  const adminReports = await request("/api/reports", { token: adminToken });
  assert.equal(ownReports.result.reports.length, 1);
  assert.equal(sharedReports.result.reports.length, 1);
  assert.equal(adminReports.result.reports.length, 1);
  assert.equal(adminReports.result.reports[0].owner.username, "staff1");

  const sharedRead = await request("/api/reports/" + reportId, { token: otherStaffToken });
  assert.equal(sharedRead.response.status, 200);
  const forbiddenDelete = await request("/api/reports/" + reportId, { token: otherStaffToken, method: "DELETE" });
  assert.equal(forbiddenDelete.response.status, 403);
  const forbiddenEdit = await request("/api/reports/" + reportId, {
    token: otherStaffToken,
    method: "PUT",
    body: { ...sharedRead.result.report, expectedUpdatedAt: sharedRead.result.report.updatedAt }
  });
  assert.equal(forbiddenEdit.response.status, 403);
});

test("stale edits are rejected instead of overwriting another user's update", async () => {
  const initial = await request("/api/reports", {
    token: staffToken,
    method: "POST",
    body: { version: 3, fields: { reportNumber: "MUS-TEST-2", beneficiaryName: "Farmer Two" }, actions: [], followups: [] }
  });
  const report = initial.result.report;
  const update = await request("/api/reports/" + report.id, {
    token: adminToken,
    method: "PUT",
    body: { ...report, expectedUpdatedAt: report.updatedAt, fields: { ...report.fields, notes: "Reviewed" } }
  });
  assert.equal(update.response.status, 200);
  const stale = await request("/api/reports/" + report.id, {
    token: staffToken,
    method: "PUT",
    body: { ...report, expectedUpdatedAt: report.updatedAt, fields: { ...report.fields, notes: "Stale edit" } }
  });
  assert.equal(stale.response.status, 409);
});

test("legacy report imports deduplicate per employee without colliding across employees", async () => {
  const item = {
    legacyId: "browser-report-1",
    report: { version: 3, fields: { reportNumber: "LEGACY-IMPORT" }, actions: [], followups: [] }
  };
  const invalidBatch = await request("/api/reports/import", {
    token: staffToken,
    method: "POST",
    body: { reports: [item, { legacyId: "invalid", report: null }] }
  });
  assert.equal(invalidBatch.response.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reports WHERE report_number = ?").get("LEGACY-IMPORT").count, 0);

  const firstImport = await request("/api/reports/import", {
    token: staffToken,
    method: "POST",
    body: { reports: [item] }
  });
  const duplicateImport = await request("/api/reports/import", {
    token: staffToken,
    method: "POST",
    body: { reports: [item] }
  });
  const otherImport = await request("/api/reports/import", {
    token: otherStaffToken,
    method: "POST",
    body: { reports: [item] }
  });
  assert.equal(firstImport.result.imported, 1);
  assert.equal(duplicateImport.result.imported, 0);
  assert.equal(otherImport.result.imported, 1);
  db.prepare("DELETE FROM reports WHERE report_number = ?").run("LEGACY-IMPORT");
});

test("admins can create employee accounts but employees cannot", async () => {
  const created = await request("/api/users", {
    token: adminToken,
    method: "POST",
    body: { fullName: "New Staff", username: "newstaff", temporaryPassword: "temporary-pass-123" }
  });
  assert.equal(created.response.status, 201);

  const login = await request("/api/auth/login", {
    method: "POST",
    body: { username: "newstaff", password: "temporary-pass-123" }
  });
  assert.equal(login.result.user.mustChangePassword, true);
  const blocked = await request("/api/reports", { token: login.result.token });
  assert.equal(blocked.response.status, 403);
  const changed = await request("/api/auth/change-password", {
    token: login.result.token,
    method: "POST",
    body: { currentPassword: "temporary-pass-123", newPassword: "a-new-secure-pass-456" }
  });
  assert.equal(changed.result.user.mustChangePassword, false);

  const denied = await request("/api/users", {
    token: staffToken,
    method: "POST",
    body: { fullName: "Other", username: "otheruser", temporaryPassword: "temporary-pass-456" }
  });
  assert.equal(denied.response.status, 403);
});
