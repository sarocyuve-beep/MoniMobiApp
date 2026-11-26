// Copies MoniMobi launcher icons/colours over the default Capacitor ones in the generated android/ project.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "resources-android", "res");
const target = path.join(root, "android", "app", "src", "main", "res");
if (!fs.existsSync(target)) {
  console.error("android/ ntiraboneka. Banza ukore: npm run add-android");
  process.exit(1);
}
fs.cpSync(source, target, { recursive: true, force: true });
console.log("Amashusho ya app (icons) yashyizwe muri android/.");

// Camera permission, so the "Fata ifoto" button (<input capture>) can open the camera inside the app.
const manifestPath = path.join(root, "android", "app", "src", "main", "AndroidManifest.xml");
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, "utf8");
  if (!manifest.includes("android.permission.CAMERA")) {
    const extra = [
      '    <uses-permission android:name="android.permission.CAMERA" />',
      '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
      '    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />'
    ].join("\n");
    manifest = manifest.replace("</manifest>", extra + "\n</manifest>");
    fs.writeFileSync(manifestPath, manifest);
    console.log("Uburenganzira bwa camera bwongewe muri AndroidManifest.xml.");
  }
}
