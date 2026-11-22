require("dotenv").config();

const persistence = require("./persist");

async function start() {
  if (process.env.NODE_ENV === "production" && !persistence.enabled) {
    throw new Error("Configure GH_DATA_TOKEN, GH_DATA_REPO, and GH_DATA_ENCRYPTION_KEY before production startup.");
  }

  const restoreMode = await persistence.restore();
  console.log("Database source:", restoreMode);

  const { db, ensureAdmin } = require("./db");
  const adminCreated = ensureAdmin({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    fullName: process.env.ADMIN_FULL_NAME
  });

  const app = require("./server");
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, "0.0.0.0", () => {
    console.log("MoniMobiApp listening on port", port);
  });

  if (restoreMode === "fresh" || adminCreated) persistence.markDirty();

  let stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(signal, "received; saving database snapshot.");
    await persistence.flush();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

start().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});
