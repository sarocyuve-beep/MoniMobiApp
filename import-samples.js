const fs = require("fs");
const http = require("http");

const BASE = "http://localhost:3001";
const ADMIN_USER = "admin";
const ADMIN_PASS = "Cyuve@Imihigo2026-2027";

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json" }
    };
    if (token) opts.headers.Authorization = "Bearer " + token;
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  // 1. Login as admin
  const login = await request("POST", "/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASS });
  if (login.status !== 200 || !login.body.token) {
    console.error("Login failed:", login);
    process.exit(1);
  }
  let token = login.body.token;
  console.log("Logged in as admin. mustChangePassword:", login.body.user && login.body.user.mustChangePassword);

  // 2. Change password to clear must_change_password flag
  if (login.body.user && login.body.user.mustChangePassword) {
    const cp = await request("POST", "/api/auth/change-password", {
      currentPassword: ADMIN_PASS,
      newPassword: ADMIN_PASS
    }, token);
    if (cp.status !== 200) {
      console.error("Change password failed:", cp);
      process.exit(1);
    }
    console.log("Password changed. must_change_password cleared.");
  }

  // 3. Load samples
  const data = JSON.parse(fs.readFileSync("./sample-reports.json", "utf8"));
  const reports = data.reports;
  console.log("Samples to import:", reports.length);

  // 4. Import in batches of 100
  const BATCH = 100;
  let totalImported = 0;
  for (let i = 0; i < reports.length; i += BATCH) {
    const batch = reports.slice(i, i + BATCH);
    const result = await request("POST", "/api/reports/import", { reports: batch }, token);
    if (result.status !== 200) {
      console.error("Import batch failed:", result);
      continue;
    }
    totalImported += result.body.imported;
    console.log("Batch " + (i / BATCH + 1) + ": imported " + result.body.imported + " / " + result.body.total);
  }

  console.log("Total imported:", totalImported);

  // 5. Verify
  const verify = await request("GET", "/api/reports", null, token);
  if (verify.status === 200) {
    const all = verify.body.reports || [];
    const count = all.length;
    const byType = {};
    all.forEach((r) => {
      const t = (r.fields && r.fields.visitType) || r.visitType;
      byType[t] = (byType[t] || 0) + 1;
    });
    console.log("Reports in DB:", count);
    console.log("By type:", JSON.stringify(byType));
  } else {
    console.error("Verify failed:", verify);
  }
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
