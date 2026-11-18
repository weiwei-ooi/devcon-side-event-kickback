#!/usr/bin/env node
// Serves dist/ on http://localhost:8080 (or --port), to try the pages locally: node scripts/serve.mjs [--port 8080] [--dir dist]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const dir = path.resolve(root, opt("dir", "dist"));
const port = Number(opt("port", 8080));
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml" };
export function serve(d = dir, p = port) {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let f = path.join(d, u.endsWith("/") ? u + "index.html" : u);
    if (!f.startsWith(d) || !fs.existsSync(f)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(p, () => r(server)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) serve().then(() => console.log(`Serving ${dir} on http://localhost:${port}`));
