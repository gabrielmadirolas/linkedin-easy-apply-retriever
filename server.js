import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const API_DOMAINS = new Set(["JOB_APPLICATIONS", "TALENT_QUESTION_SAVED_RESPONSE"]);
const MAX_BODY = 64 * 1024;
const MAX_COUNT = 100;
const MAX_START = 1_000_000;

let serverPort = 0;
let accessToken = "";
let authNotice = "";

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function securityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  res.setHeader("X-Frame-Options", "DENY");
}

function requestOriginIsLocal(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://127.0.0.1:${serverPort}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY) {
        tooLarge = true;
        data = "";
      }
    });
    req.on("end", () => {
      if (tooLarge) return reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error("Request must contain valid JSON."), { status: 400 }));
      }
    });
    req.on("error", () => reject(Object.assign(new Error("Request could not be read."), { status: 400 })));
  });
}

function currentToken() {
  return accessToken;
}

function statusPayload() {
  const token = currentToken();
  return {
    authenticated: Boolean(token),
    notice: authNotice,
  };
}

function staticFile(req, res, pathname) {
  const knownFiles = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ]);
  const entry = knownFiles.get(pathname);
  if (!entry) return false;
  const filePath = path.join(PUBLIC, entry[0]);
  try {
    const contents = fs.readFileSync(filePath);
    securityHeaders(res);
    res.writeHead(200, { "Content-Type": entry[1], "Content-Length": contents.length });
    res.end(contents);
  } catch {
    sendJson(res, 500, { error: "The app page could not be loaded." });
  }
  return true;
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${serverPort || 1}`);
  if (!requestOriginIsLocal(req)) return sendJson(res, 403, { error: "Request origin was rejected." });

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    return sendJson(res, 200, statusPayload());
  }
  if (req.method === "GET" && staticFile(req, res, url.pathname)) return;
  if (req.method !== "POST") return sendJson(res, 404, { error: "Page not found." });

  let input;
  try {
    input = await readJson(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Invalid request." });
  }

  if (url.pathname === "/api/token") {
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (!token || token.length > 10_000 || /\s/.test(token)) {
      return sendJson(res, 400, { error: "Paste a valid access token without spaces or line breaks." });
    }
    accessToken = token;
    authNotice = "Token accepted for this app session only.";
    return sendJson(res, 200, statusPayload());
  }

  if (url.pathname === "/api/logout") {
    accessToken = "";
    authNotice = "Disconnected. The app session token was cleared.";
    return sendJson(res, 200, statusPayload());
  }

  if (url.pathname === "/api/snapshot") {
    if (!currentToken()) return sendJson(res, 401, { error: "Paste a LinkedIn access token before searching." });
    const domain = input.domain;
    const start = Number(input.start ?? 0);
    const count = Number(input.count ?? 10);
    if (!API_DOMAINS.has(domain) || !Number.isInteger(start) || start < 0 || start > MAX_START || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      return sendJson(res, 400, { error: "Snapshot request parameters were invalid." });
    }
    const upstream = new URL("https://api.linkedin.com/rest/memberSnapshotData");
    upstream.searchParams.set("q", "criteria");
    upstream.searchParams.set("domain", domain);
    upstream.searchParams.set("start", String(start));
    upstream.searchParams.set("count", String(count));
    try {
      const response = await fetch(upstream, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Linkedin-Version": "202312",
          "X-Restli-Protocol-Version": "2.0.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) {
        if (response.status === 401) {
          accessToken = "";
          authNotice = "LinkedIn rejected or expired this token. Generate a new access token with LinkedIn OAuth Token Tools and paste it again.";
        }
        return sendJson(res, response.status, { error: response.status === 401 ? "LinkedIn rejected or expired this token. Generate a new access token with LinkedIn OAuth Token Tools and paste it again." : "LinkedIn denied access. Confirm Member Data Portability access and the requested scope." });
      }
      if (!response.ok) return sendJson(res, 502, { error: `LinkedIn returned an API error (${response.status}). Check API access and try again.` });
      const payload = await response.json();
      return sendJson(res, 200, payload);
    } catch {
      return sendJson(res, 502, { error: "Could not reach LinkedIn. Check your connection and try again." });
    }
  }

  return sendJson(res, 404, { error: "API route not found." });
});

app.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
app.listen(0, "127.0.0.1", () => {
  serverPort = app.address().port;
  console.log(`LinkedIn Easy Apply Retriever is ready at http://127.0.0.1:${serverPort}`);
  console.log("Stop the app with Ctrl+C. Tokens are cleared when the process exits.");
});
