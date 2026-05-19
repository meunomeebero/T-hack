const fs = require("fs");
const http = require("http");
const path = require("path");

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json"
};

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://analytics.bero.land https://*.posthog.com",
    "connect-src 'self' wss: https://analytics.bero.land https://*.posthog.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; ")
};

function applySecurityHeaders(headers) {
  return Object.assign({}, SECURITY_HEADERS, headers);
}

function createStaticServer(publicDir, dataStore) {
  return http.createServer(async (req, res) => {
    const requestPath = req.url.split("?")[0];

    // API routes
    if (requestPath === "/api/sponsors" || requestPath === "/api/ads") {
      try {
        const ads = await dataStore.getAds();
        res.writeHead(200, applySecurityHeaders({
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }));
        res.end(JSON.stringify(ads));
      } catch (error) {
        console.error("Failed to load ads:", error);
        res.writeHead(500, applySecurityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ error: "Failed to load ads" }));
      }
      return;
    }

    const filePath = requestPath === "/" ? "/index.html" : requestPath;
    const fullPath = path.join(publicDir, filePath);
    const contentType = MIME_TYPES[path.extname(fullPath)] || "text/plain";

    if (!fullPath.startsWith(publicDir)) {
      res.writeHead(403, applySecurityHeaders({}));
      res.end("Forbidden");
      return;
    }

    fs.readFile(fullPath, (error, content) => {
      if (error) {
        res.writeHead(404, applySecurityHeaders({}));
        res.end("Not Found");
        return;
      }

      res.writeHead(200, applySecurityHeaders({ "Content-Type": contentType }));
      res.end(content);
    });
  });
}

module.exports = {
  createStaticServer
};
