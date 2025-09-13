// utils/respond-express.js
export const ok  = (res, data, status = 200) => res.status(status).json(data);
export const bad = (res, message, status = 400, extra = {}) =>
  res.status(status).json({ error: message, ...extra });
export const methodNotAllowed = (res) => bad(res, "Method not allowed", 405);
export const unauthorized = (res, msg = "Unauthorized") =>
  res.status(401).set("WWW-Authenticate", 'Basic realm="IKMI Admin", charset="UTF-8"')
     .json({ error: msg });
