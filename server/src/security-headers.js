// CSP starts in report-only mode so Google sign-in and voice can be qualified.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://accounts.google.com https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "connect-src 'self' https://bluffx.onrender.com wss://bluffx.onrender.com https://accounts.google.com https://*.googleapis.com",
  "frame-src https://accounts.google.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
function securityHeaders(req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy":
      "camera=(), geolocation=(), payment=(), microphone=(self)",
    "Content-Security-Policy-Report-Only": CSP,
  });
  if (process.env.NODE_ENV === "production" && req.secure)
    res.set("Strict-Transport-Security", "max-age=31536000");
  next();
}
module.exports = { CSP, securityHeaders };
