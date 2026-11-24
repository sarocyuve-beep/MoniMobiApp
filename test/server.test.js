const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "monimobi-test-"));
process.env.NODE_ENV = "test";
process.env.LOGIN_RATE_LIMIT = "1000";
process.env.ACCOUNT_REQUEST_RATE_LIMIT = "1000";
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

test("Word report endpoint builds a .docx from saved reports", async () => {
  const sample = (visitType) => ({
    version: 3,
    fields: { reportNumber: "R-DOCX-" + visitType, visitDate: "2026-11-20", visitType, goal: "12", cell: "KABEZA", village: "GASHANGIRO", beneficiaryName: "Itsinda GIRAMATA", staffName: "Staff One" },
    actions: [{ action: "Gutera intanga", owner: "Aborozi", deadline: "2026-12-01" }],
    followups: [{ recommendation: "Inama", status: "Yego", reason: "" }]
  });
  const created = await request("/api/reports", { token: staffToken, method: "POST", body: sample("Monitoring") });
  const response = await fetch(baseUrl + "/api/reports/docx", {
    method: "POST",
    headers: { Authorization: "Bearer " + staffToken, "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [created.result.report.id] })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /Raporo_Imihigo_Monitoring_2026-11-20\.docx/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), "PK");

  const missing = await request("/api/reports/docx", { token: staffToken, method: "POST", body: { ids: ["does-not-exist"] } });
  assert.equal(missing.response.status, 404);
  const anonymous = await request("/api/reports/docx", { method: "POST", body: { ids: [created.result.report.id] } });
  assert.equal(anonymous.response.status, 401);

  const mixed = await request("/api/reports", { token: staffToken, method: "POST", body: sample("Follow-up") });
  const mixedResponse = await request("/api/reports/docx", { token: staffToken, method: "POST", body: { ids: [created.result.report.id, mixed.result.report.id] } });
  assert.equal(mixedResponse.status ? mixedResponse.status : mixedResponse.response.status, 400);

  // Multi-target report and editable authority / memo test
  const multiTargetSample = {
    version: 4,
    fields: {
      reportNumber: "R-MULTI-001",
      visitDate: "2026-11-24",
      visitType: "Mobilization",
      staffName: "Staff One",
      staffRole: "Umukozi ushinzwe Ubworozi"
    },
    targets: [
      {
        id: "target-1",
        category: "UBUKUNGU",
        goal: "12",
        beneficiaries: "Aborozi bagize itsinda GIRAMATA",
        sector: "CYUVE",
        cell: "KABEZA",
        village: "GASHANGIRO",
        details: { messageGiven: "Akamaro ko gutera intanga inka", mobilizationAgreement: "Kuzitera mu minsi 7" }
      },
      {
        id: "target-2",
        category: "UBUKUNGU",
        goal: "14",
        beneficiaries: "Koperative Tuzamurane",
        sector: "CYUVE",
        cell: "BURUBA",
        village: "BAZIZANA",
        details: { messageGiven: "Gukingiza inka", mobilizationAgreement: "Kwitegura urukingo" }
      }
    ],
    staffParticipants: [
      { name: "Staff One", role: "Umukozi ushinzwe Ubworozi", phone: "0788000001", signature: "S.1" },
      { name: "Staff Two", role: "Veterinarian", phone: "0788000002", signature: "S.2" }
    ],
    authorityName: "MUKESHIMANA Jeanette",
    authorityTitle: "Acting Executive Secretary/Cyuve Sector",
    memoText: "Bwana Muyobozi, iyi ni memo yihariye yakozwe na acting ES."
  };

  const createdMulti = await request("/api/reports", { token: staffToken, method: "POST", body: multiTargetSample });
  assert.equal(createdMulti.response.status, 201);
  assert.ok(createdMulti.result.report.beneficiaryName.includes("GIRAMATA"));

  // Download DOCX using saved ID
  const multiDocxRes = await fetch(baseUrl + "/api/reports/docx", {
    method: "POST",
    headers: { Authorization: "Bearer " + staffToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      ids: [createdMulti.result.report.id],
      authorityName: "MUKESHIMANA Jeanette",
      authorityTitle: "Acting Executive Secretary/Cyuve Sector",
      memoText: "Bwana Muyobozi, iyi ni memo yihariye yakozwe na acting ES."
    })
  });
  assert.equal(multiDocxRes.status, 200);
  const multiBytes = Buffer.from(await multiDocxRes.arrayBuffer());
  assert.equal(multiBytes.subarray(0, 2).toString(), "PK");

  // Download DOCX directly from unsaved report payload
  const directDocxRes = await fetch(baseUrl + "/api/reports/docx", {
    method: "POST",
    headers: { Authorization: "Bearer " + staffToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      report: multiTargetSample,
      authorityName: "MUKESHIMANA Jeanette",
      authorityTitle: "Acting Executive Secretary/Cyuve Sector"
    })
  });
  assert.equal(directDocxRes.status, 200);
  const directBytes = Buffer.from(await directDocxRes.arrayBuffer());
  assert.equal(directBytes.subarray(0, 2).toString(), "PK");
});

test("employees can request an account and an admin approves or rejects it", async () => {
  const payload = { fullName: "Mukamana Jeanne", username: "jeanne.m", password: "jeanne-password-123", level: "Akagari", cell: "KABEZA", jobTitle: "Umukozi ushinzwe Ubworozi" };

  const weak = await request("/api/auth/request-account", { method: "POST", body: { ...payload, password: "short" } });
  assert.equal(weak.response.status, 400);
  const noLevel = await request("/api/auth/request-account", { method: "POST", body: { ...payload, level: "" } });
  assert.equal(noLevel.response.status, 400);
  const noCell = await request("/api/auth/request-account", { method: "POST", body: { ...payload, cell: "" } });
  assert.equal(noCell.response.status, 400);
  const badCell = await request("/api/auth/request-account", { method: "POST", body: { ...payload, cell: "NTIBAHO" } });
  assert.equal(badCell.response.status, 400);
  const noJob = await request("/api/auth/request-account", { method: "POST", body: { ...payload, jobTitle: " " } });
  assert.equal(noJob.response.status, 400);
  const taken = await request("/api/auth/request-account", { method: "POST", body: { ...payload, username: "staff1" } });
  assert.equal(taken.response.status, 409);

  const created = await request("/api/auth/request-account", { method: "POST", body: payload });
  assert.equal(created.response.status, 201);
  const duplicate = await request("/api/auth/request-account", { method: "POST", body: payload });
  assert.equal(duplicate.response.status, 409);

  // Mbere yo kwemezwa: ntiyinjira, ariko abwirwa ko ategereje.
  const early = await request("/api/auth/login", { method: "POST", body: { username: "jeanne.m", password: payload.password } });
  assert.equal(early.response.status, 403);
  assert.match(early.result.error, /itegereje|buracyategereje/);
  const wrongPassword = await request("/api/auth/login", { method: "POST", body: { username: "jeanne.m", password: "not-the-password-1" } });
  assert.equal(wrongPassword.response.status, 401);

  // Umukozi ntashobora kureba cyangwa kwemeza ubusabe.
  assert.equal((await request("/api/account-requests", { token: staffToken })).response.status, 403);

  const pending = await request("/api/account-requests", { token: adminToken });
  assert.equal(pending.response.status, 200);
  const entry = pending.result.requests.find((item) => item.username === "jeanne.m");
  assert.ok(entry);
  assert.equal(entry.password_hash, undefined);
  assert.equal(entry.level, "Akagari");
  assert.equal(entry.cell, "KABEZA");
  assert.equal(entry.jobTitle, "Umukozi ushinzwe Ubworozi");

  assert.equal((await request("/api/account-requests/" + entry.id + "/approve", { token: staffToken, method: "POST" })).response.status, 403);
  const approved = await request("/api/account-requests/" + entry.id + "/approve", { token: adminToken, method: "POST" });
  assert.equal(approved.response.status, 200);
  assert.equal((await request("/api/account-requests/" + entry.id + "/approve", { token: adminToken, method: "POST" })).response.status, 404);

  const login = await request("/api/auth/login", { method: "POST", body: { username: "jeanne.m", password: payload.password } });
  assert.equal(login.response.status, 200);
  assert.equal(login.result.user.role, "EMPLOYEE");
  assert.equal(login.result.user.mustChangePassword, false);
  assert.equal(login.result.user.level, "Akagari");
  assert.equal(login.result.user.cell, "KABEZA");
  assert.equal(login.result.user.jobTitle, "Umukozi ushinzwe Ubworozi");

  const second = await request("/api/auth/request-account", { method: "POST", body: { fullName: "Uwase Alice", username: "alice.u", password: "alice-password-123", level: "Umurenge", jobTitle: "Umunyamabanga" } });
  assert.equal(second.response.status, 201);
  const list = await request("/api/account-requests", { token: adminToken });
  const alice = list.result.requests.find((item) => item.username === "alice.u");
  assert.equal((await request("/api/account-requests/" + alice.id + "/reject", { token: adminToken, method: "POST" })).response.status, 200);
  const rejected = await request("/api/auth/login", { method: "POST", body: { username: "alice.u", password: "alice-password-123" } });
  assert.equal(rejected.response.status, 403);
});

test("a user who forgot the password asks for a new one and an admin approves it", async () => {
  const same = await request("/api/auth/forgot-password", { method: "POST", body: { username: "staff2", newPassword: "short" } });
  assert.equal(same.response.status, 400);

  // Igisubizo kiba kimwe haba username ibaho cyangwa itabaho.
  const unknown = await request("/api/auth/forgot-password", { method: "POST", body: { username: "nobody.here", newPassword: "brand-new-password-1" } });
  assert.equal(unknown.response.status, 202);
  const asked = await request("/api/auth/forgot-password", { method: "POST", body: { username: "staff2", newPassword: "brand-new-password-1" } });
  assert.equal(asked.response.status, 202);
  assert.equal(asked.result.message, unknown.result.message);

  // Mbere yo kwemezwa ijambo rya kera riracyakora, irishya ntirikora.
  const stillOld = await request("/api/auth/login", { method: "POST", body: { username: "staff2", password: "other-password-123" } });
  assert.equal(stillOld.response.status, 200);
  const early = await request("/api/auth/login", { method: "POST", body: { username: "staff2", password: "brand-new-password-1" } });
  assert.equal(early.response.status, 403);

  assert.equal((await request("/api/password-resets", { token: staffToken })).response.status, 403);
  const pending = await request("/api/password-resets", { token: adminToken });
  const entry = pending.result.resets.find((item) => item.username === "staff2");
  assert.ok(entry);
  assert.equal(entry.password_hash, undefined);

  assert.equal((await request("/api/password-resets/" + entry.id + "/approve", { token: staffToken, method: "POST" })).response.status, 403);
  assert.equal((await request("/api/password-resets/" + entry.id + "/approve", { token: adminToken, method: "POST" })).response.status, 200);
  assert.equal((await request("/api/password-resets/" + entry.id + "/approve", { token: adminToken, method: "POST" })).response.status, 404);

  const fresh = await request("/api/auth/login", { method: "POST", body: { username: "staff2", password: "brand-new-password-1" } });
  assert.equal(fresh.response.status, 200);
  const oldNow = await request("/api/auth/login", { method: "POST", body: { username: "staff2", password: "other-password-123" } });
  assert.equal(oldNow.response.status, 401);

  // Admin ntiyemeza ubusabe bwe bwite; ubusabe bushya busimbura ubwahozeho; kwanga ntihindura ijambo.
  const adminAsk = await request("/api/auth/forgot-password", { method: "POST", body: { username: "admin", newPassword: "admin-new-password-1" } });
  assert.equal(adminAsk.response.status, 202);
  const adminPending = (await request("/api/password-resets", { token: adminToken })).result.resets.find((item) => item.username === "admin");
  assert.equal((await request("/api/password-resets/" + adminPending.id + "/approve", { token: adminToken, method: "POST" })).response.status, 400);
  assert.equal((await request("/api/password-resets/" + adminPending.id + "/reject", { token: adminToken, method: "POST" })).response.status, 200);
  const adminStill = await request("/api/auth/login", { method: "POST", body: { username: "admin", password: "admin-password-123" } });
  assert.equal(adminStill.response.status, 200);
});
