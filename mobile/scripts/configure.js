// Writes mobile/capacitor.config.json from the APP_URL environment variable
// (or from mobile/app-url.txt). The APK loads that deployed address in a native WebView.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
let raw = process.env.APP_URL || "";
const urlFile = path.join(root, "app-url.txt");
if (!raw && fs.existsSync(urlFile)) raw = fs.readFileSync(urlFile, "utf8");
raw = raw.trim().replace(/\/+$/, "");

let parsed;
try { parsed = new URL(raw); } catch { parsed = null; }
if (!parsed || parsed.protocol !== "https:") {
  console.error("APP_URL ntabwo yashyizweho cyangwa ntiyemewe. Koresha https, urugero: https://monimobi-app.onrender.com");
  console.error("Ushobora gushyiraho APP_URL (environment variable) cyangwa ugashyira iyo URL muri mobile/app-url.txt");
  process.exit(1);
}

const config = {
  appId: "rw.gov.cyuve.monimobi",
  appName: "MoniMobi",
  webDir: "www",
  server: {
    url: parsed.origin,
    cleartext: false,
    errorPath: "offline.html",
    allowNavigation: [parsed.host]
  },
  android: { allowMixedContent: false }
};
fs.writeFileSync(path.join(root, "capacitor.config.json"), JSON.stringify(config, null, 2) + "\n");
console.log("capacitor.config.json yanditswe; app izafungura:", parsed.origin);
