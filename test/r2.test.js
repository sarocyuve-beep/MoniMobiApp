const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "monimobi-r2-test-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(temporaryDirectory, "r2.sqlite");
process.env.R2_ACCESS_KEY_ID = "TESTKEY";
process.env.R2_SECRET_ACCESS_KEY = "testsecret";
process.env.R2_BUCKET = "monimobi-photos";

const r2 = require("../src/r2");

test("SigV4 signer matches the AWS documented example", () => {
  const { signature } = r2.sign({
    method: "GET",
    path: "/test.txt",
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      range: "bytes=0-9",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20130524T000000Z"
    },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    amzDate: "20130524T000000Z",
    region: "us-east-1"
  });
  assert.equal(signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

// A tiny in-memory stand-in for R2 that checks every request signature.
const objects = new Map();
let mock;
let signatureFailures = 0;

before(async () => {
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const auth = req.headers.authorization || "";
      const signedNames = (/SignedHeaders=([^,]+)/.exec(auth) || [])[1];
      const headers = {};
      (signedNames || "").split(";").forEach((name) => { headers[name] = req.headers[name]; });
      const expected = r2.sign({
        method: req.method,
        path: req.url.split("?")[0],
        headers,
        payloadHash: req.headers["x-amz-content-sha256"],
        accessKeyId: "TESTKEY",
        secretAccessKey: "testsecret",
        amzDate: req.headers["x-amz-date"]
      }).authorization;
      const payloadOk = req.headers["x-amz-content-sha256"] === crypto.createHash("sha256").update(body).digest("hex");
      if (auth !== expected || !payloadOk) { signatureFailures += 1; res.writeHead(403).end("SignatureDoesNotMatch"); return; }
      if (req.method === "PUT") { objects.set(req.url, body); res.writeHead(200).end(); return; }
      if (req.method === "GET") {
        if (!objects.has(req.url)) { res.writeHead(404).end("NoSuchKey"); return; }
        res.writeHead(200, { "Content-Type": "image/jpeg" }).end(objects.get(req.url));
        return;
      }
      if (req.method === "DELETE") { objects.delete(req.url); res.writeHead(204).end(); return; }
      res.writeHead(405).end();
    });
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  process.env.R2_ENDPOINT = "http://127.0.0.1:" + mock.address().port;
});

after(async () => {
  await new Promise((resolve) => mock.close(resolve));
  require("../src/db").db.close();
});

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
  Buffer.alloc(40, 7), Buffer.from([0xff, 0xd9])
]);

test("photos use R2 for bytes and SQLite for metadata only", async () => {
  const { db } = require("../src/db");
  const photos = require("../src/photos");
  db.prepare("INSERT INTO users (username, full_name, password_hash, role, must_change_password) VALUES ('u1', 'U One', 'x', 'EMPLOYEE', 0)").run();
  const userId = db.prepare("SELECT id FROM users WHERE username = 'u1'").get().id;

  const saved = await photos.save({ id: "photo-a", userId, buffer: JPEG });
  assert.equal(saved.width, 64);
  assert.equal(saved.height, 48);
  const row = db.prepare("SELECT storage, bytes, length(data) AS stored FROM photos WHERE id = 'photo-a'").get();
  assert.equal(row.storage, "r2");
  assert.equal(row.bytes, JPEG.length);
  assert.equal(row.stored, 0, "SQLite must not hold the image bytes");
  assert.equal(objects.size, 1);

  const read = await photos.read("photo-a");
  assert.equal(Buffer.compare(read.data, JPEG), 0);
  assert.equal((await photos.readMany(["photo-a", "nope"])).size, 1);

  // linking to a report, then dropping the photo from the report removes the R2 object
  db.prepare("INSERT INTO reports (id, report_number, data_json, created_by, updated_by) VALUES ('rep1', 'R1', '{}', ?, ?)").run(userId, userId);
  const report = { targets: [{ details: { photos: [{ id: "photo-a" }] } }] };
  photos.sync(report, "rep1");
  await photos.save({ id: "photo-b", userId, buffer: JPEG });
  photos.sync({ targets: [{ details: { photos: [{ id: "photo-a" }, { id: "photo-b" }] } }] }, "rep1");
  assert.equal(objects.size, 2);
  photos.sync(report, "rep1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(objects.size, 1);
  assert.equal(await photos.read("photo-b"), null);

  // deleting a report releases its objects
  photos.releaseReport("rep1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(objects.size, 0);
  assert.equal(signatureFailures, 0);
});

test("photos still stored in SQLite are migrated to R2", async () => {
  const { db } = require("../src/db");
  const photos = require("../src/photos");
  const userId = db.prepare("SELECT id FROM users WHERE username = 'u1'").get().id;
  db.prepare("INSERT INTO photos (id, uploaded_by, width, height, bytes, data, storage) VALUES ('old-1', ?, 64, 48, ?, ?, 'db')").run(userId, JPEG.length, JPEG);
  assert.equal(await photos.migrateToR2(), 1);
  assert.equal(db.prepare("SELECT storage, length(data) AS n FROM photos WHERE id = 'old-1'").get().storage, "r2");
  assert.equal(Buffer.compare((await photos.read("old-1")).data, JPEG), 0);
  assert.equal(await photos.migrateToR2(), 0);
});

test("a failing R2 upload is reported and nothing is stored", async () => {
  const { db } = require("../src/db");
  const photos = require("../src/photos");
  const userId = db.prepare("SELECT id FROM users WHERE username = 'u1'").get().id;
  const good = process.env.R2_SECRET_ACCESS_KEY;
  process.env.R2_SECRET_ACCESS_KEY = "wrong-secret";
  await assert.rejects(() => photos.save({ id: "photo-bad", userId, buffer: JPEG }), (error) => error.status === 502);
  process.env.R2_SECRET_ACCESS_KEY = good;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM photos WHERE id = 'photo-bad'").get().n, 0);
});
