const $ = (selector) => document.querySelector(selector);
const statusPill = $("#auth-pill");
const authMessage = $("#auth-message");
const lookupMessage = $("#lookup-message");
const results = $("#results");
let savedTokenOptions = [];
let savedTokenPromptDismissed = false;
let matchedRecords = [];

function setMessage(node, message, kind = "") {
  node.textContent = message;
  node.className = `message${kind ? ` ${kind}` : ""}`;
}

function showSavedTokenPrompt(options, authenticated) {
  const prompt = $("#saved-token-prompt");
  savedTokenOptions = Array.isArray(options) ? options : [];
  if (authenticated || savedTokenPromptDismissed || savedTokenOptions.length === 0) {
    prompt.hidden = true;
    return;
  }

  const choiceLabel = $("#saved-token-choice-label");
  const choice = $("#saved-token-choice");
  const useButton = $("#use-saved-token-button");
  const message = $("#saved-token-prompt-message");
  choice.replaceChildren();

  if (savedTokenOptions.length === 1) {
    message.textContent = `A saved access token was found in ${savedTokenOptions[0].label}. Would you like to use it for this session?`;
    choiceLabel.hidden = true;
    choice.hidden = true;
    useButton.textContent = "Use saved token";
  } else {
    message.textContent = `Found ${savedTokenOptions.length} saved access tokens. Choose which one to use for this session.`;
    choiceLabel.hidden = false;
    choice.hidden = false;
    useButton.textContent = "Use selected token";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a saved token";
    choice.append(placeholder);
    for (const option of savedTokenOptions) {
      const item = document.createElement("option");
      item.value = option.id;
      item.textContent = option.label;
      choice.append(item);
    }
  }
  prompt.hidden = false;
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
  showSavedTokenPrompt(info.savedTokens, authenticated);
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
  const raw = $("#job-reference").value.trim();
  if (/^\d+$/.test(raw)) return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a numeric job ID or paste a complete LinkedIn job-post URL.");
  }
  const ids = jobIdsFromUrl(url);
  if (ids.length !== 1) throw new Error("That LinkedIn URL must contain one valid job ID.");
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function applicationIdentity(record) {
  const data = record?.data && typeof record.data === "object" ? record.data : record;
  const identifiers = new Set();
  const stack = [data];
  const visited = new Set();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (/^(applicationid|applicationrecordid|jobapplicationid|jobapplicationrecordid)$/.test(normalized)
        && (typeof nested === "string" || (typeof nested === "number" && Number.isSafeInteger(nested)))) {
        identifiers.add(String(nested));
      } else if (nested && typeof nested === "object") {
        stack.push(nested);
      }
    }
  }
  return identifiers.size ? `application:${[...identifiers].sort().join("|")}` : `record:${stableJson(data)}`;
}

function uniqueApplications(records) {
  const seen = new Set();
  return records.filter((record) => {
    const identity = applicationIdentity(record);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
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

function humanizeFieldKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function parseQuestionsAndAnswers(value) {
  const text = String(value);
  if (!text.includes("|")) return [];
  const entries = text.split(/\s*\|\s*/).map((entry) => entry.trim()).filter(Boolean);
  const pairs = entries.map((entry) => {
    const separator = entry.indexOf(":");
    if (separator < 0) return null;
    return { question: entry.slice(0, separator).trim(), answer: entry.slice(separator + 1).trim() };
  });
  return pairs.length && pairs.every(Boolean) ? pairs : [];
}

function finishAnswer(value) {
  const answer = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "�").trimEnd();
  if (!answer || /[.!?]$/.test(answer) || /^\d+(?:[.,]\d+)?$/.test(answer)
    || /^\+?[\d\s().-]+$/.test(answer) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer)
    || /^(?:https?:\/\/|www\.)/i.test(answer) || /\.(?:pdf|docx?|odt|rtf|txt)$/i.test(answer)) return answer;
  return `${answer}.`;
}

function readableFields(record) {
  const root = record?.data && typeof record.data === "object" ? record.data : record;
  const fields = [];
  function visit(value, path, seen = new Set()) {
    if (value === null || value === undefined) return;
    if (typeof value === "object") {
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, [...path, String(index + 1)], seen));
      } else {
        for (const [key, nested] of Object.entries(value)) visit(nested, [...path, key], seen);
      }
      seen.delete(value);
      return;
    }
    if (typeof value === "string" && path.length) {
      const pairs = parseQuestionsAndAnswers(value);
      if (pairs.length) {
        for (const pair of pairs) {
          fields.push({ label: pair.question || "Answer", value: finishAnswer(pair.answer), kind: "answer", order: fields.length });
        }
        return;
      }
    }
    const label = path.map(humanizeFieldKey).join(" · ") || "Value";
    const leafKey = String(path.at(-1) || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const inQuestionsAndAnswers = path.slice(0, -1).some((part) => /questionsandanswers|questionanswers/.test(String(part).toLowerCase().replace(/[^a-z0-9]/g, "")));
    const isAnswer = /answer|response|selected|choice/.test(leafKey) || (inQuestionsAndAnswers && /^\d+$/.test(leafKey));
    const kind = isAnswer ? "answer" : /question|prompt/.test(leafKey) ? "question" : "detail";
    const displayValue = kind === "answer" ? finishAnswer(value) : String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "�").trimEnd();
    fields.push({ label, value: displayValue, kind, order: fields.length });
  }
  visit(root, []);
  const rank = { question: 0, answer: 0, detail: 1 };
  return fields.sort((left, right) => rank[left.kind] - rank[right.kind] || left.order - right.order);
}

function addResultCard(container, type, record, index) {
  const card = document.createElement("article");
  card.className = "result-card";
  const heading = document.createElement("h3");
  heading.textContent = `${type} ${index + 1}`;
  const fields = readableFields(record);
  if (!fields.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "This matching record has no readable fields.";
    card.append(heading, empty);
    container.append(card);
    return;
  }
  const list = document.createElement("dl");
  list.className = "result-fields";
  for (const field of fields) {
    const row = document.createElement("div");
    row.className = `result-field ${field.kind}`;
    const label = document.createElement("dt");
    label.textContent = field.label;
    const value = document.createElement("dd");
    value.textContent = field.value;
    row.append(label, value);
    list.append(row);
  }
  card.append(heading, list);
  container.append(card);
}

function renderResults(jobId, applications, responses) {
  results.replaceChildren();
  results.hidden = false;
  matchedRecords = [];
  const applicationMatches = uniqueApplications(applications.filter((record) => recordJobIds(record).includes(jobId)));
  const responseMatches = responses.filter((record) => recordJobIds(record).includes(jobId));

  const header = document.createElement("div");
  header.className = "results-header";
  const text = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = `Matching results for job ${jobId}`;
  const detail = document.createElement("p");
  const count = applicationMatches.length + responseMatches.length;
  detail.textContent = `${count} matching ${count === 1 ? "record" : "records"}`;
  text.append(title, detail);
  header.append(text);
  results.append(header);

  const allMatches = [
    ...applicationMatches.map((record) => ({ type: "Application record", record })),
    ...responseMatches.map((record) => ({ type: "Screening response", record })),
  ];
  matchedRecords = allMatches.map(({ type, record }) => ({ ...record, resultType: type }));
  if (!allMatches.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No application or saved screening response was matched to this job.";
    results.append(empty);
    return;
  }

  const exportPanel = document.createElement("div");
  exportPanel.className = "result-export";
  const formatLabel = document.createElement("label");
  const formatSelect = document.createElement("select");
  formatSelect.id = "export-format";
  formatLabel.htmlFor = formatSelect.id;
  formatLabel.textContent = "Save matching results as";
  const formats = [
    ["pdf", "PDF"],
    ["docx", "DOCX (Word)"],
    ["txt", "TXT"],
    ["odt", "ODT (OpenDocument)"],
    ["json", "JSON"],
    ["html", "HTML"],
  ];
  for (const [value, label] of formats) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = value === "txt";
    formatSelect.append(option);
  }
  const exportButton = document.createElement("button");
  exportButton.className = "button button-primary";
  exportButton.type = "button";
  exportButton.textContent = "Download";
  exportButton.addEventListener("click", () => downloadResults(jobId, formatSelect.value, exportButton));
  exportPanel.append(formatLabel, formatSelect, exportButton);
  results.append(exportPanel);

  const typeCounts = new Map();
  for (const match of allMatches) {
    const index = typeCounts.get(match.type) || 0;
    typeCounts.set(match.type, index + 1);
    addResultCard(results, match.type, match.record, index);
  }
}

async function downloadResults(jobId, format, button) {
  button.disabled = true;
  setMessage(lookupMessage, "Preparing your file…");
  try {
    const response = await fetch("/api/export", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, format, records: matchedRecords }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Export failed (${response.status}).`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `linkedin-answers-${jobId}.${format}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(lookupMessage, `Downloaded matching results as ${format.toUpperCase()}.`, "success");
  } catch (error) {
    setMessage(lookupMessage, error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function runLookup() {
  setMessage(lookupMessage, "");
  results.hidden = true;
  matchedRecords = [];
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

$("#use-saved-token-button").addEventListener("click", async () => {
  const id = savedTokenOptions.length === 1 ? savedTokenOptions[0].id : $("#saved-token-choice").value;
  if (!id) return setMessage(authMessage, "Choose one of the saved tokens first.", "error");
  const button = $("#use-saved-token-button");
  button.disabled = true;
  try {
    setAuthStatus(await api("/api/token/use-saved", { method: "POST", body: JSON.stringify({ id }) }));
  } catch (error) {
    setMessage(authMessage, error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#skip-saved-token-button").addEventListener("click", () => {
  savedTokenPromptDismissed = true;
  $("#saved-token-prompt").hidden = true;
});

$("#disconnect-button").addEventListener("click", async () => {
  try {
    setAuthStatus(await api("/api/logout", { method: "POST", body: "{}" }));
    $("#token-input").value = "";
    matchedRecords = [];
    results.replaceChildren();
    results.hidden = true;
  } catch (error) {
    setMessage(authMessage, error.message, "error");
  }
});

$("#search-button").addEventListener("click", runLookup);

$("#clear-job-reference").addEventListener("click", () => {
  const input = $("#job-reference");
  input.value = "";
  input.focus();
  matchedRecords = [];
  results.replaceChildren();
  results.hidden = true;
  setMessage(lookupMessage, "");
});

refreshStatus();
