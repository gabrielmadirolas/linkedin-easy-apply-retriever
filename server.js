import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const CLIENT_ID = loadClientId();
const API_DOMAINS = new Set(["JOB_APPLICATIONS", "TALENT_QUESTION_SAVED_RESPONSE"]);
const MAX_BODY = 64 * 1024;
const MAX_COUNT = 100;
const MAX_START = 1_000_000;

let serverPort = 0;
let accessToken = "";
let tokenExpiresAt = 0;
let authMethod = "";
let pendingOAuth = null;
let authNotice = "";

function loadClientId() {
  if (process.env.LINKEDIN_CLIENT_ID) return process.env.LINKEDIN_CLIENT_ID.trim();
  try {
    const contents = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    const line = contents.split(/\r?\n/).find((entry) => /^\s*LINKEDIN_CLIENT_ID\s*=/.test(entry));
    if (!line) return "";
    const value = line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
    return value;
  } catch {
    return "";
  }
}

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

function sendHtml(res, status, html) {
  securityHeaders(res);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LinkedIn connection</title><body><h1>LinkedIn connection</h1><p>${html}</p><p>You can return to the lookup app tab.</p></body></html>`);
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
  if (accessToken && tokenExpiresAt && Date.now() >= tokenExpiresAt) {
    accessToken = "";
    tokenExpiresAt = 0;
    authMethod = "";
    authNotice = "Your LinkedIn token expired. Connect again or paste a new token.";
  }
  return accessToken;
}

function statusPayload() {
  const token = currentToken();
  if (pendingOAuth && Date.now() >= pendingOAuth.expiresAt) {
    pendingOAuth = null;
    authNotice = "The LinkedIn sign-in request expired. Start again or use the token-paste fallback.";
  }
  return {
    authenticated: Boolean(token),
    expiresAt: tokenExpiresAt || null,
    method: token ? authMethod : "",
    clientIdConfigured: Boolean(CLIENT_ID),
    oauthPending: Boolean(pendingOAuth),
    notice: authNotice,
  };
}

function callbackPage(res) {
  res.writeHead(303, { Location: "/oauth/result", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end();
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

async function handleOAuthCallback(req, res, url) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const error = url.searchParams.get("error") || "";
  const pending = pendingOAuth;
  pendingOAuth = null;

  if (!pending || Date.now() > pending.expiresAt || !constantTimeEqual(state, pending.state)) {
    authNotice = "LinkedIn sign-in could not be verified. Start the connection again.";
    return callbackPage(res);
  }
  if (error || !code) {
    authNotice = "LinkedIn sign-in was cancelled or declined. You can try again or paste a token.";
    return callbackPage(res);
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pending.verifier,
    });
    const response = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      authNotice = "LinkedIn could not complete OAuth. Confirm PKCE is enabled for your app, then use the token-paste fallback if needed.";
      return callbackPage(res);
    }
    const payload = await response.json();
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      authNotice = "LinkedIn did not return an access token. Try again or use the token-paste fallback.";
      return callbackPage(res);
    }
    accessToken = payload.access_token;
    tokenExpiresAt = Number.isFinite(Number(payload.expires_in))
      ? Date.now() + Number(payload.expires_in) * 1000
      : 0;
    authMethod = "oauth";
    authNotice = "LinkedIn is connected for this app session.";
  } catch {
    authNotice = "Could not reach LinkedIn to finish sign-in. Try again or use the token-paste fallback.";
  }
  return callbackPage(res);
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

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, 200, { clientIdConfigured: Boolean(CLIENT_ID) });
  }
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    return sendJson(res, 200, statusPayload());
  }
  if (req.method === "GET" && url.pathname === "/oauth/callback") {
    return handleOAuthCallback(req, res, url);
  }
  if (req.method === "GET" && url.pathname === "/oauth/result") {
    return sendHtml(res, 200, "Sign-in has finished. Return to the lookup app tab.");
  }
  if (req.method === "GET" && staticFile(req, res, url.pathname)) return;
  if (req.method !== "POST") return sendJson(res, 404, { error: "Page not found." });

  let input;
  try {
    input = await readJson(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Invalid request." });
  }

  if (url.pathname === "/api/oauth/start") {
    if (!CLIENT_ID) return sendJson(res, 400, { error: "Set LINKEDIN_CLIENT_ID in .env before connecting." });
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = `http://127.0.0.1:${serverPort}/oauth/callback`;
    pendingOAuth = { state, verifier, redirectUri, expiresAt: Date.now() + 10 * 60 * 1000 };
    authNotice = "Waiting for LinkedIn sign-in in the browser.";
    const authorize = new URL("https://www.linkedin.com/oauth/native-pkce/authorization");
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      state,
      scope: "r_dma_portability_self_serve",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return sendJson(res, 200, { authorizationUrl: authorize.toString() });
  }

  if (url.pathname === "/api/token") {
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (!token || token.length > 10_000 || /\s/.test(token)) {
      return sendJson(res, 400, { error: "Paste a valid access token without spaces or line breaks." });
    }
    accessToken = token;
    tokenExpiresAt = 0;
    authMethod = "manual";
    pendingOAuth = null;
    authNotice = "Token accepted for this app session only.";
    return sendJson(res, 200, statusPayload());
  }

  if (url.pathname === "/api/logout") {
    accessToken = "";
    tokenExpiresAt = 0;
    authMethod = "";
    pendingOAuth = null;
    authNotice = "Disconnected. The app session token was cleared.";
    return sendJson(res, 200, statusPayload());
  }

  if (url.pathname === "/api/snapshot") {
    if (!currentToken()) return sendJson(res, 401, { error: "Connect to LinkedIn or paste a token first." });
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
          tokenExpiresAt = 0;
          authMethod = "";
          authNotice = "LinkedIn rejected or expired this token. Reconnect or paste a new token.";
        }
        return sendJson(res, response.status, { error: response.status === 401 ? "LinkedIn rejected or expired this token. Reconnect or paste a new token." : "LinkedIn denied access. Confirm Member Data Portability access and the requested scope." });
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
