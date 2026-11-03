const $ = (selector) => document.querySelector(selector);
const statusPill = $("#auth-pill");
const authMessage = $("#auth-message");
const lookupMessage = $("#lookup-message");
const results = $("#results");

function setMessage(node, message, kind = "") {
  node.textContent = message;
  node.className = `message${kind ? ` ${kind}` : ""}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function setAuthStatus(info) {
  const authenticated = Boolean(info.authenticated);
  statusPill.textContent = authenticated ? "Token ready" : "Token needed";
  statusPill.className = `status-pill ${authenticated ? "status-online" : "status-offline"}`;
  $("#disconnect-button").hidden = !authenticated;
  if (info.notice) setMessage(authMessage, info.notice, authenticated ? "success" : "");
  else if (authenticated) setMessage(authMessage, "Your token is ready for this session and is held in memory only.", "success");
}

async function refreshStatus() {
  try {
    const info = await api("/api/auth/status");
    setAuthStatus(info);
    return info;
  } catch (error) {
    setMessage(authMessage, error.message, "error");
    return null;
  }
}

function targetJobId() {
  const mode = $("input[name='target-mode']:checked").value;
  if (mode === "id") {
    const id = $("#job-id").value.trim();
    if (!/^\d+$/.test(id)) throw new Error("Enter a numeric LinkedIn job ID.");
    return id;
  }
  const raw = $("#job-url").value.trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Paste a complete LinkedIn job-post URL.");
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname) || !url.pathname.startsWith("/jobs/")) {
    throw new Error("Use a LinkedIn URL whose path starts with /jobs/.");
  }
  const ids = jobIdsFromUrl(url);
  if (ids.length !== 1) throw new Error("That URL has no single valid job ID. Use a LinkedIn job URL with one ID, or choose the Job ID option.");
  return ids[0];
}

function jobIdsFromUrl(url) {
  const hostname = url.hostname.toLowerCase();
  if (!["linkedin.com", "www.linkedin.com"].includes(hostname) || !url.pathname.startsWith("/jobs/")) return [];
  const candidates = [
    ...url.searchParams.getAll("currentJobId"),
    ...url.searchParams.getAll("originToLandingJobPostings"),
  ];
  const pathMatch = url.pathname.match(/^\/jobs\/view\/(\d+)(?:\/|$)/);
  if (pathMatch) candidates.push(pathMatch[1]);
  if (candidates.some((id) => !/^\d+$/.test(id))) return [];
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique : [];
}

function idsFromUrl(text) {
  try {
    return jobIdsFromUrl(new URL(text));
  } catch {
    return [];
  }
}

function recordJobIds(record) {
  const found = new Set();
  const visited = new Set();
  function visit(value, key = "", inJobContext = false) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const referenceKey = /^(jobid|jobpostingid|postingid|joburl|joblink|jobpostingurl|jobpostinglink|postingurl|postinglink)$/.test(normalizedKey);
    const nestedJobContext = inJobContext || /^(job|jobposting|posting)$/.test(normalizedKey);
    if (typeof value === "string") {
      if ((referenceKey || (nestedJobContext && normalizedKey === "id")) && /^\d+$/.test(value.trim())) found.add(value.trim());
      if (referenceKey || nestedJobContext) {
        for (const id of idsFromUrl(value)) found.add(id);
      }
      return;
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && (referenceKey || (nestedJobContext && normalizedKey === "id"))) {
      found.add(String(value));
      return;
    }
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, inJobContext);
    } else {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey, nestedJobContext);
    }
  }
  visit(record);
  return [...found];
}

function snapshotRecords(payload, domain) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.elements)) {
    throw new Error(`LinkedIn returned an unexpected response format for ${domain}. Check API access/version and try again.`);
  }
  const elements = payload.elements;
  const flattened = [];
  for (const element of elements) {
    if (!element || typeof element !== "object" || !Array.isArray(element.snapshotData)) {
      throw new Error(`LinkedIn returned an unexpected response format for ${domain}. Check API access/version and try again.`);
    }
    if (element.snapshotDomain && element.snapshotDomain !== domain) {
      throw new Error(`LinkedIn returned data for an unexpected domain while requesting ${domain}.`);
    }
    for (const row of element.snapshotData) {
      if (!row || typeof row !== "object") {
        throw new Error(`LinkedIn returned an unexpected response format for ${domain}. Check API access/version and try again.`);
      }
      flattened.push({ snapshotDomain: element.snapshotDomain || domain, data: row });
    }
  }
  return flattened;
}

async function fetchDomain(domain) {
  const output = [];
  const seen = new Set();
  let start = 0;
  let count = 100;
  for (let page = 0; page < 200; page += 1) {
    const key = `${start}:${count}`;
    if (seen.has(key)) throw new Error(`LinkedIn returned a repeated page for ${domain}; stopped pagination safely.`);
    seen.add(key);
    const payload = await api("/api/snapshot", { method: "POST", body: JSON.stringify({ domain, start, count }) });
    output.push(...snapshotRecords(payload, domain));
    const next = Array.isArray(payload?.paging?.links) ? payload.paging.links.find((link) => link.rel === "next") : null;
    if (!next?.href) return output;
    const nextUrl = new URL(next.href, "https://api.linkedin.com");
    const parsedStart = Number(nextUrl.searchParams.get("start"));
    const parsedCount = Number(nextUrl.searchParams.get("count") || count);
    if (!Number.isInteger(parsedStart) || parsedStart < 0 || !Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > 100) {
      throw new Error(`LinkedIn returned invalid pagination values for ${domain}.`);
    }
    start = parsedStart;
    count = parsedCount;
  }
  throw new Error(`Stopped ${domain} pagination after 200 pages to avoid an unbounded request.`);
}

function addResultCard(container, title, subtitle, record, index) {
  const card = document.createElement("article");
  card.className = "result-card";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const copy = document.createElement("button");
  copy.className = "button button-secondary result-copy";
  copy.type = "button";
  copy.textContent = "Copy JSON";
  const pre = document.createElement("pre");
  pre.className = "result-json";
  pre.textContent = JSON.stringify(record, null, 2);
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy JSON"; }, 1200);
    } catch {
      copy.textContent = "Copy unavailable";
    }
  });
  const description = document.createElement("p");
  description.className = "result-subtitle";
  description.textContent = subtitle || `Record ${index + 1}`;
  card.append(heading, copy, description, pre);
  container.append(card);
}

function renderResults(jobId, applications, responses) {
  results.replaceChildren();
  results.hidden = false;
  const applicationMatches = applications.filter((record) => recordJobIds(record).includes(jobId));
  const responseMatches = responses.filter((record) => recordJobIds(record).includes(jobId));
  const otherResponses = responses.filter((record) => !recordJobIds(record).includes(jobId));

  const header = document.createElement("div");
  header.className = "results-header";
  const text = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = `Results for job ${jobId}`;
  const detail = document.createElement("p");
  detail.textContent = `${applications.length} application records · ${responses.length} saved screening response records returned`;
  text.append(title, detail);
  header.append(text);
  results.append(header);

  const allMatches = [
    ...applicationMatches.map((record) => ({ type: "Application record", record })),
    ...responseMatches.map((record) => ({ type: "Screening response linked by job ID", record })),
  ];
  if (allMatches.length) {
    for (const [index, match] of allMatches.entries()) addResultCard(results, match.type, `Matched job ID ${jobId}`, match.record, index);
  } else {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No returned record contained this job ID. The API may not associate historical saved answers with a specific application. Review the unassociated saved responses below.";
    results.append(empty);
  }

  const otherHeading = document.createElement("div");
  otherHeading.className = "results-header";
  const otherTitle = document.createElement("h2");
  otherTitle.textContent = `Saved responses not matched to job ${jobId}`;
  const otherDetail = document.createElement("p");
  otherDetail.textContent = otherResponses.length
    ? "These may not be tied to the target job. They are shown for inspection, not as confirmed application answers."
    : "No unmatched saved responses were returned.";
  otherHeading.append(otherTitle, otherDetail);
  results.append(otherHeading);
  if (otherResponses.length) {
    otherResponses.forEach((record, index) => {
      const ids = recordJobIds(record);
      const subtitle = ids.length ? `Contains other job reference(s): ${ids.join(", ")}` : "No job ID found in this record; association is unknown.";
      addResultCard(results, "Unmatched saved screening response", subtitle, record, index);
    });
  }
}

async function runLookup() {
  setMessage(lookupMessage, "");
  results.hidden = true;
  let jobId;
  try {
    jobId = targetJobId();
  } catch (error) {
    return setMessage(lookupMessage, error.message, "error");
  }
  const auth = await api("/api/auth/status").catch(() => null);
  if (!auth?.authenticated) return setMessage(lookupMessage, "Add a LinkedIn access token before searching.", "error");

  const button = $("#search-button");
  button.disabled = true;
  button.textContent = "Looking up records…";
  try {
    setMessage(lookupMessage, "Loading application and saved screening response data…");
    const [applications, responses] = await Promise.all([
      fetchDomain("JOB_APPLICATIONS"),
      fetchDomain("TALENT_QUESTION_SAVED_RESPONSE"),
    ]);
    renderResults(jobId, applications, responses);
    setMessage(lookupMessage, "Lookup finished. Data remains in this page until you close or refresh it.", "success");
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setMessage(lookupMessage, error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Find application answers";
  }
}

$("#token-button").addEventListener("click", async () => {
  const input = $("#token-input");
  const token = input.value.trim();
  if (!token) return setMessage(authMessage, "Paste your LinkedIn access token first.", "error");
  try {
    const status = await api("/api/token", { method: "POST", body: JSON.stringify({ token }) });
    input.value = "";
    setAuthStatus(status);
  } catch (error) {
    setMessage(authMessage, error.message, "error");
  }
});

$("#disconnect-button").addEventListener("click", async () => {
  try {
    setAuthStatus(await api("/api/logout", { method: "POST", body: "{}" }));
    $("#token-input").value = "";
    results.replaceChildren();
    results.hidden = true;
  } catch (error) {
    setMessage(authMessage, error.message, "error");
  }
});

$("#search-button").addEventListener("click", runLookup);

for (const radio of document.querySelectorAll("input[name='target-mode']")) {
  radio.addEventListener("change", () => {
    const urlMode = radio.checked && radio.value === "url";
    $("#id-field").hidden = urlMode;
    $("#url-field").hidden = !urlMode;
    setMessage(lookupMessage, "");
  });
}

refreshStatus();
