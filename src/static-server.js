const fs = require("fs");
const http = require("http");
const path = require("path");

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json"
};

function createStaticServer(publicDir) {
  return http.createServer((req, res) => {
    // API routes
    if (req.url === "/api/ads") {
      res.writeHead(200, { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      const { getAds } = require("../db");
      res.end(JSON.stringify(getAds()));
      return;
    }

    const filePath = req.url === "/" ? "/index.html" : req.url;
    const fullPath = path.join(publicDir, filePath);
    const contentType = MIME_TYPES[path.extname(fullPath)] || "text/plain";

    if (!fullPath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(fullPath, (error, content) => {
      if (error) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    });
  });
}

module.exports = {
  createStaticServer
};
