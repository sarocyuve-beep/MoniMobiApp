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
process.env.PHOTO_MAX_TOTAL_MB = "0.05";

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
  const samplesFile = await fetch(baseUrl + "/samples.js");
  const serverSource = await fetch(baseUrl + "/src/server.js");
  assert.equal(appPage.status, 200);
  assert.equal(dataFile.status, 200);
  assert.equal(samplesFile.status, 200);
  assert.match(await samplesFile.text(), /window\.SAMPLE_REPORTS/);
  assert.equal(serverSource.status, 404);

  const manifest = await fetch(baseUrl + "/manifest.webmanifest");
  const worker = await fetch(baseUrl + "/sw.js");
  const icon = await fetch(baseUrl + "/icons/icon-192.png");
  const badIcon = await fetch(baseUrl + "/icons/..%2Fsrc%2Fserver.js");
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).short_name, "MoniMobi");
  assert.equal(worker.status, 200);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
  assert.notEqual(badIcon.status, 200);
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
  const payload = { fullName: "Mukamana Jeanne", username: "jeanne.m", password: "jeanne-password-123", level: "Akagari", cell: "KABEZA", jobTitle: "Umukozi ushinzwe Ubworozi", duties: "Gukurikirana ubworozi n’ubuzima bw’amatungo mu Kagari" };

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
  const noDuties = await request("/api/auth/request-account", { method: "POST", body: { ...payload, duties: " " } });
  assert.equal(noDuties.response.status, 400);
  const longDuties = await request("/api/auth/request-account", { method: "POST", body: { ...payload, duties: "a".repeat(201) } });
  assert.equal(longDuties.response.status, 400);
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
  assert.equal(entry.duties, payload.duties);

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
  assert.equal(login.result.user.duties, payload.duties);

  const second = await request("/api/auth/request-account", { method: "POST", body: { fullName: "Uwase Alice", username: "alice.u", password: "alice-password-123", level: "Umurenge", jobTitle: "Umunyamabanga", duties: "Gukurikirana imirimo y’Umurenge" } });
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

const TEST_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAwAEADASIAAhEBAxEB/8QAGQAAAwEBAQAAAAAAAAAAAAAAAwUGBAEH/8QAJxAAAQQCAQMEAgMAAAAAAAAABAABAgMhMREFBhITQVFhByIUI/D/xAAZAQACAwEAAAAAAAAAAAAAAAAGBwIEBQP/xAAlEQABBAIBAgcBAAAAAAAAAAABAAIDBAURMSGBEhMiMkFh8HH/2gAMAwEAAhEDEQA/ANQIusKgBF1hZwRdYVACLrCoZC5ylNi6HHRaARdYVCCLrCzgi6wqAEXWEE37nKY2LocdFoBF1hPxB2rj5O2GQARdO7LXfa0I+MX44QZbsGR2gmJjaQaAShE3/aUlX7yilX7ylJN+8rjGxFdaBRHZ3SB+o9w9K6eZW8qCTaKbYs/DvCU4s7M/th3XptX476O3TLLxriLbXt/l0+jH1LJhzjJ6oNDlv7OI+UviL+/C85BF1hUIIusJl3L7Wghw2kDiqQAALVcA9gB0XTqc977KYWzkz1cQlGNt1TcO0ueeamf4z7qjbsjpEbyoD2ShG2ddYnMvJ63jdCq15N75kzs3w6hARdYTumuNFfk+0JW8nCAW+Vvv2/feimBjse460dKpftcSgCib2EQsse2bvOnjwaMISaFn7fq75ZvnyZRvWXiKeSNF24qunBuPhpO3+yuFX7ylBN+8rIkkjmHoZ4T/AHfx+KMaVRzPc7aCVfvKUE37yjFX7ylBN+1ONiJa0C2Ai6wqAEXWFnBF1hUAIundlqZC5yk3i6HHRHEHauPk7YZcJv8AtFvtaEfGL8cJSVfvKHtmR2yjupWDQAhFX7ylBV+8oxN+8pQVfvKtRsRDWgQSr95Sgq/aMVf9pQVfvKuxsW/WgX//2Q==", "base64");

async function uploadPhoto(token, body = TEST_JPEG, type = "image/jpeg") {
  const response = await fetch(baseUrl + "/api/photos", {
    method: "POST",
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": type },
    body
  });
  return { response, result: await response.json() };
}

function reportWithPhotos(number, photos) {
  return {
    version: 4,
    fields: { reportNumber: number, visitDate: "2026-11-20", visitType: "Mobilization", staffName: "Staff One" },
    targets: [{ id: "t1", category: "UBUKUNGU", goal: "12", beneficiaries: "Itsinda GIRAMATA", sector: "CYUVE", cell: "KABEZA", village: "", details: { photos } }]
  };
}

test("photos: upload, link to a report, view, replace and cascade on delete", async () => {
  const anonymous = await uploadPhoto(null);
  assert.equal(anonymous.response.status, 401);
  const notJpeg = await uploadPhoto(staffToken, Buffer.from("not an image at all"), "image/jpeg");
  assert.equal(notJpeg.response.status, 400);

  const first = await uploadPhoto(staffToken);
  const second = await uploadPhoto(staffToken);
  assert.equal(first.response.status, 201);
  assert.equal(first.result.photo.width, 64);
  assert.equal(first.result.photo.height, 48);

  // another employee cannot attach someone else's unsaved photo
  const stolen = await request("/api/reports", { token: otherStaffToken, method: "POST", body: reportWithPhotos("R-PH-STEAL", [{ id: first.result.photo.id }]) });
  assert.equal(stolen.response.status, 400);
  const unknown = await request("/api/reports", { token: staffToken, method: "POST", body: reportWithPhotos("R-PH-UNKNOWN", [{ id: "missing-id" }]) });
  assert.equal(unknown.response.status, 400);

  const created = await request("/api/reports", { token: staffToken, method: "POST", body: reportWithPhotos("R-PH-1", [{ id: first.result.photo.id, caption: "Ikiraro" }, { id: second.result.photo.id }]) });
  assert.equal(created.response.status, 201);
  const reportId = created.result.report.id;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM photos WHERE report_id = ?").get(reportId).n, 2);

  // every signed-in employee can see the picture; anonymous users cannot
  const viewed = await fetch(baseUrl + "/api/photos/" + first.result.photo.id, { headers: { Authorization: "Bearer " + otherStaffToken } });
  assert.equal(viewed.status, 200);
  assert.equal(viewed.headers.get("content-type"), "image/jpeg");
  assert.equal(Buffer.compare(Buffer.from(await viewed.arrayBuffer()), TEST_JPEG), 0);
  assert.equal((await fetch(baseUrl + "/api/photos/" + first.result.photo.id)).status, 401);

  // saving the report without the second photo deletes it
  const updated = await request("/api/reports/" + reportId, {
    token: staffToken, method: "PUT",
    body: { ...reportWithPhotos("R-PH-1", [{ id: first.result.photo.id, caption: "Ikiraro" }]), expectedUpdatedAt: created.result.report.updatedAt }
  });
  assert.equal(updated.response.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM photos WHERE report_id = ?").get(reportId).n, 1);
  assert.equal((await fetch(baseUrl + "/api/photos/" + second.result.photo.id, { headers: { Authorization: "Bearer " + staffToken } })).status, 404);

  // Word report embeds the real picture
  const docx = await fetch(baseUrl + "/api/reports/docx", {
    method: "POST", headers: { Authorization: "Bearer " + staffToken, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [reportId] })
  });
  assert.equal(docx.status, 200);
  const bytes = Buffer.from(await docx.arrayBuffer());
  assert.ok(bytes.includes(Buffer.from("word/media/")), "docx should contain an embedded media file");

  // deleting the report deletes its photos
  await request("/api/reports/" + reportId, { token: staffToken, method: "DELETE" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM photos WHERE id = ?").get(first.result.photo.id).n, 0);
});

test("photos: unsaved uploads are cleaned up and the total storage is capped", async () => {
  const orphan = await uploadPhoto(staffToken);
  db.prepare("UPDATE photos SET created_at = datetime('now', '-3 days') WHERE id = ?").run(orphan.result.photo.id);
  const photosModule = require("../src/photos");
  assert.ok(photosModule.purgeOrphans() >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM photos WHERE id = ?").get(orphan.result.photo.id).n, 0);

  const tooBig = await uploadPhoto(staffToken, Buffer.concat([TEST_JPEG, Buffer.alloc(700 * 1024)]));
  assert.equal(tooBig.response.status, 413);

  let status = 201;
  for (let i = 0; i < 100 && status === 201; i += 1) status = (await uploadPhoto(staffToken)).response.status;
  assert.equal(status, 507);
  db.prepare("DELETE FROM photos").run();
});
