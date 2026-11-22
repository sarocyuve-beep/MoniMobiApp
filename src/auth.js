const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { db } = require("./db");

const jwtSecret = process.env.JWT_SECRET;
if (process.env.NODE_ENV === "production" && (!jwtSecret || jwtSecret.length < 32)) {
  throw new Error("JWT_SECRET must be set to a random value of at least 32 characters.");
}

function createToken(user) {
  return jwt.sign({ id: user.id }, jwtSecret || "local-development-secret-change-me", { expiresIn: "12h" });
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    mustChangePassword: Boolean(user.must_change_password)
  };
}

function login(username, password) {
  const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!user || !user.is_active || !bcrypt.compareSync(password, user.password_hash)) return null;
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  return { token: createToken(user), user: publicUser(user) };
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Ugomba kubanza kwinjira muri konti." });
  try {
    const claims = jwt.verify(token, jwtSecret || "local-development-secret-change-me");
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(claims.id);
    if (!user || !user.is_active) return res.status(401).json({ error: "Konti ntiyemewe cyangwa yahagaritswe." });
    req.user = user;
    if (user.must_change_password && !["/api/auth/me", "/api/auth/change-password"].includes(req.path)) {
      return res.status(403).json({ error: "Banza uhindure ijambo ry’ibanga ry’igihe gito." });
    }
    next();
  } catch {
    res.status(401).json({ error: "Igihe cyo kwinjira cyarangiye. Ongera winjire." });
  }
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === "ADMIN") return next();
  return res.status(403).json({ error: "Abayobozi ba sisitemu gusa ni bo bemerewe iki gikorwa." });
}

module.exports = { login, publicUser, requireAuth, requireAdmin };
