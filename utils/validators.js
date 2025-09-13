// utils/validators.js
export function sanitizeSub(name) {
  if (!name) return null;
  const cleaned = name.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!cleaned || cleaned.length < 3) return null;
  return cleaned;
}

export function isValidEmailLocal(local) {
  return /^[a-z0-9._-]{1,32}$/i.test(local);
}

export function isValidDestinationEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}
