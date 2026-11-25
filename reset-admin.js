const bcrypt = require("bcryptjs");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("./Data/monimobi.sqlite");
const hash = bcrypt.hashSync("Cyuve@Imihigo2026-2027", 12);
db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE username = 'admin'").run(hash);
console.log("Admin password updated.");
