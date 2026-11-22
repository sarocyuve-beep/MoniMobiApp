const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");

test("SQLite snapshots are encrypted, uploaded, and restored from the private-repository API", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monimobi-persist-test-"));
  const dbPath = path.join(directory, "backup.sqlite");
  let snapshot = null;
  let snapshotSha = "snapshot-1";
  const fakeApi = http.createServer(async (req, res) => {
    if (req.url.startsWith("/repos/test/data/contents/monimobi.sqlite.enc")) {
      if (req.method === "GET" && !snapshot) {
        res.writeHead(404);
        return res.end();
      }
      if (req.method === "GET" && req.headers.accept === "application/vnd.github.raw+json") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(snapshot);
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ sha: snapshotSha }));
      }
      if (req.method === "PUT") {
        let body = "";
        for await (const chunk of req) body += chunk;
        snapshot = Buffer.from(JSON.parse(body).content, "base64");
        snapshotSha = "snapshot-2";
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ content: { sha: snapshotSha } }));
      }
    }
    res.writeHead(404);
    res.end();
  });
  fakeApi.listen(0, "127.0.0.1");
  await new Promise((resolve) => fakeApi.once("listening", resolve));

  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_PATH: dbPath,
    GH_DATA_TOKEN: "test-token",
    GH_DATA_REPO: "test/data",
    GH_DATA_PATH: "monimobi.sqlite.enc",
    GH_DATA_BRANCH: "main",
    GH_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
    GH_DATA_DEBOUNCE_MS: "1000",
    GH_API_URL: "http://127.0.0.1:" + fakeApi.address().port,
    RESTORE_GITHUB_SNAPSHOT: "true"
  });
  let applicationDb;

  try {
    const persistence = require("../src/persist");
    assert.equal(await persistence.restore(), "fresh");
    let database = new DatabaseSync(dbPath);
    database.exec("CREATE TABLE sample (value TEXT NOT NULL)");
    database.prepare("INSERT INTO sample (value) VALUES (?)").run("shared data");
    database.close();

    persistence.markDirty();
    await persistence.flush();
    assert.ok(snapshot);
    assert.equal(snapshot.subarray(0, 5).toString(), "MMDB1");

    applicationDb = require("../src/db").db;
    applicationDb.close();
    applicationDb = null;
    fs.rmSync(dbPath, { force: true });
    assert.equal(await persistence.restore(), "restored");
    database = new DatabaseSync(dbPath);
    assert.equal(database.prepare("SELECT value FROM sample").get().value, "shared data");
    database.close();
  } finally {
    if (applicationDb) applicationDb.close();
    await new Promise((resolve) => fakeApi.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
