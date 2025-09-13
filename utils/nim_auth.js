// utils/nim_auth.js
import { unauthorized, bad } from "./respond-express.js";

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let res = 0;
  for (let i = 0; i < len; i++) {
    res |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return res === 0 && a.length === b.length;
}

function parseBasicAuth(headers) {
  const h = headers["authorization"] || headers["Authorization"];
  if (!h || !h.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function isProtectedNim(nim) {
  return (process.env.PROTECTED_NIMS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(nim).trim());
}

export function enforceNimAuthOrResponse(req, res, nim) {
  if (!isProtectedNim(nim)) return null;
  const creds = parseBasicAuth(req.headers);
  const u = process.env[`NIM_${nim}_USER`] || "";
  const p = process.env[`NIM_${nim}_PASS`] || "";
  if (!creds) return unauthorized(res, "Credentials required for this NIM");
  if (!u || !p) return bad(res, "Server auth for this NIM not configured", 500);
  if (!safeEqual(creds.user, u) || !safeEqual(creds.pass, p))
    return unauthorized(res, "Invalid credentials for this NIM");
  return null;
}

export function requireAdmin(req, res) {
  const creds = parseBasicAuth(req.headers);
  const u = process.env.ADMIN_USER || "",
    p = process.env.ADMIN_PASS || "";
  if (!creds) return unauthorized(res, "Admin credentials required");
  if (!safeEqual(creds.user, u) || !safeEqual(creds.pass, p))
    return unauthorized(res, "Invalid admin credentials");
  return true;
}
