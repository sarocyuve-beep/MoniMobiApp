require("dotenv").config();

const bcrypt = require("bcryptjs");
const { stdin, stdout } = require("node:process");
const { createInterface } = require("node:readline/promises");
const { db } = require("./db");

async function main() {
  if (db.prepare("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1").get()) {
    throw new Error("An administrator already exists.");
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const fullName = (await prompt.question("Admin full name: ")).trim();
    const username = (await prompt.question("Admin username: ")).trim();
    const password = await prompt.question("Admin password (12+ characters): ");
    if (!fullName || !/^[a-zA-Z0-9._-]{3,40}$/.test(username) || password.length < 12) {
      throw new Error("Enter a full name, a valid username, and a password of at least 12 characters.");
    }
    db.prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, 'ADMIN')")
      .run(username, fullName, bcrypt.hashSync(password, 12));
    console.log("Administrator account created.");
  } finally {
    prompt.close();
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
