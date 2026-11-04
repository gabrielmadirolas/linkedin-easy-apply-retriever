import PDFDocument from "pdfkit";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";

const FORMAT_INFO = {
  pdf: { extension: "pdf", contentType: "application/pdf" },
  docx: { extension: "docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  txt: { extension: "txt", contentType: "text/plain; charset=utf-8" },
  odt: { extension: "odt", contentType: "application/vnd.oasis.opendocument.text" },
  json: { extension: "json", contentType: "application/json; charset=utf-8" },
  html: { extension: "html", contentType: "text/html; charset=utf-8" },
};

function idsFromUrl(value) {
  try {
    const url = new URL(value);
    if (!["linkedin.com", "www.linkedin.com"].includes(url.hostname.toLowerCase()) || !url.pathname.startsWith("/jobs/")) return [];
    const candidates = [
      ...url.searchParams.getAll("currentJobId"),
      ...url.searchParams.getAll("originToLandingJobPostings"),
    ];
    const pathMatch = url.pathname.match(/^\/jobs\/view\/(\d+)(?:\/|$)/);
    if (pathMatch) candidates.push(pathMatch[1]);
    if (candidates.some((id) => !/^\d+$/.test(id))) return [];
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

export function recordMatchesJob(record, jobId) {
  const found = new Set();
  const visited = new Set();
  function visit(value, key = "", inJobContext = false, depth = 0) {
    if (depth > 80) return;
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const referenceKey = /^(jobid|jobpostingid|postingid|joburl|joblink|jobpostingurl|jobpostinglink|postingurl|postinglink)$/.test(normalizedKey);
    const nestedJobContext = inJobContext || /^(job|jobposting|posting)$/.test(normalizedKey);
    if (typeof value === "string") {
      if ((referenceKey || (nestedJobContext && normalizedKey === "id")) && /^\d+$/.test(value.trim())) found.add(value.trim());
      if (referenceKey || nestedJobContext) for (const id of idsFromUrl(value)) found.add(id);
      return;
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && (referenceKey || (nestedJobContext && normalizedKey === "id"))) {
      found.add(String(value));
      return;
    }
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, inJobContext, depth + 1);
    } else {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey, nestedJobContext, depth + 1);
    }
  }
  visit(record);
  return found.has(jobId);
}

function humanize(key) {
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

export function readableFields(record) {
  const root = record?.data && typeof record.data === "object" ? record.data : record;
  const fields = [];
  function visit(value, path, seen = new Set()) {
    if (path.length > 80) throw new Error("Record fields are nested too deeply to export.");
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
          fields.push({ label: pair.question || "Answer", value: finishAnswer(pair.answer), kind: "Answer", order: fields.length });
        }
        return;
      }
    }
    const leafKey = String(path.at(-1) || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const inQuestionsAndAnswers = path.slice(0, -1).some((part) => /questionsandanswers|questionanswers/.test(String(part).toLowerCase().replace(/[^a-z0-9]/g, "")));
    const isAnswer = /answer|response|selected|choice/.test(leafKey) || (inQuestionsAndAnswers && /^\d+$/.test(leafKey));
    const kind = isAnswer ? "Answer" : /question|prompt/.test(leafKey) ? "Question" : "Detail";
    const displayValue = kind === "Answer" ? finishAnswer(value) : String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "�").trimEnd();
    fields.push({ label: path.map(humanize).join(" · ") || "Value", value: displayValue, kind, order: fields.length });
  }
  visit(root, []);
  const rank = { Question: 0, Answer: 0, Detail: 1 };
  return fields.sort((left, right) => rank[left.kind] - rank[right.kind] || left.order - right.order);
}

function recordTitle(record, index) {
  return record.resultType || `Matched record ${index + 1}`;
}

function structuredJsonRecords(records) {
  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === "string") {
        const pairs = parseQuestionsAndAnswers(nested);
        output[key] = pairs.length ? pairs.map(({ question, answer }) => ({ question, answer: finishAnswer(answer) })) : nested;
      } else {
        output[key] = visit(nested);
      }
    }
    return output;
  }
  return records.map(visit);
}

function textContent(jobId, records, fieldsByRecord) {
  const lines = [`Application answers for job ${jobId}`, ""];
  fieldsByRecord.forEach((fields, index) => {
    lines.push(`${index + 1}. ${recordTitle(records[index], index)}`, "");
    for (const field of fields) lines.push(`${field.label}: ${field.value}`);
    lines.push("");
  });
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function htmlContent(jobId, records, fieldsByRecord) {
  const sections = fieldsByRecord.map((fields, index) => `<article><h2>${escapeHtml(recordTitle(records[index], index))}</h2><dl>${fields.map((field) => `<div class="${field.kind.toLowerCase()}"><dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd></div>`).join("")}</dl></article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Application answers for job ${escapeHtml(jobId)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:850px;margin:40px auto;padding:0 20px;color:#172b4d}h1{font-size:28px}article{margin:20px 0;padding:20px;border:1px solid #dfe5ee;border-radius:12px}dl{margin:0}dl div{display:grid;grid-template-columns:minmax(140px,.35fr) 1fr;border-top:1px solid #edf0f4}dt,dd{margin:0;padding:10px;overflow-wrap:anywhere}dt{color:#66758a;font-weight:700;font-size:13px}.question{background:#f4f8fd}.answer dt{color:#084d91}dd{white-space:pre-wrap}</style></head><body><h1>Application answers for job ${escapeHtml(jobId)}</h1>${sections}</body></html>`;
}

function escapeXml(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "�").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function odtXml(jobId, records, fieldsByRecord) {
  const sections = fieldsByRecord.map((fields, index) => `<text:h text:outline-level="2">${escapeXml(recordTitle(records[index], index))}</text:h>${fields.map((field) => `<text:p><text:span text:style-name="Bold">${escapeXml(field.label)}: </text:span>${escapeXml(field.value)}</text:p>`).join("")}`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:version="1.2"><office:automatic-styles><style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"/></style:style></office:automatic-styles><office:body><office:text><text:h text:outline-level="1">Application answers for job ${escapeXml(jobId)}</text:h>${sections}</office:text></office:body></office:document-content>`;
}

async function pdfBuffer(jobId, records, fieldsByRecord) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ margin: 52 });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    document.fontSize(20).font("Helvetica-Bold").text(`Application answers for job ${jobId}`);
    document.moveDown();
    fieldsByRecord.forEach((fields, index) => {
      document.fontSize(14).font("Helvetica-Bold").text(recordTitle(records[index], index));
      document.moveDown(0.4);
      for (const field of fields) {
        document.fontSize(10).font("Helvetica-Bold").text(`${field.label}: `, { continued: true });
        document.font("Helvetica").text(field.value);
        document.moveDown(0.2);
      }
      document.moveDown();
    });
    document.end();
  });
}

async function docxBuffer(jobId, records, fieldsByRecord) {
  const children = [new Paragraph({ text: `Application answers for job ${jobId}`, heading: HeadingLevel.TITLE })];
  fieldsByRecord.forEach((fields, index) => {
    children.push(new Paragraph({ text: recordTitle(records[index], index), heading: HeadingLevel.HEADING_1 }));
    for (const field of fields) {
      children.push(new Paragraph({ children: [new TextRun({ text: `${field.label}: `, bold: true }), new TextRun({ text: field.value })] }));
    }
  });
  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}

async function odtBuffer(jobId, records, fieldsByRecord) {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text", { compression: "STORE" });
  zip.file("content.xml", odtXml(jobId, records, fieldsByRecord));
  zip.file("styles.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"><office:styles/></office:document-styles>`);
  zip.file("META-INF/manifest.xml", `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export async function createExport(format, jobId, records) {
  const info = FORMAT_INFO[format];
  if (!info) throw new Error("Choose a supported export format.");
  const fieldsByRecord = records.map(readableFields);
  let buffer;
  if (format === "txt") buffer = Buffer.from(textContent(jobId, records, fieldsByRecord), "utf8");
  else if (format === "json") buffer = Buffer.from(JSON.stringify({ jobId, records: structuredJsonRecords(records) }, null, 2), "utf8");
  else if (format === "html") buffer = Buffer.from(htmlContent(jobId, records, fieldsByRecord), "utf8");
  else if (format === "pdf") buffer = await pdfBuffer(jobId, records, fieldsByRecord);
  else if (format === "docx") buffer = await docxBuffer(jobId, records, fieldsByRecord);
  else buffer = await odtBuffer(jobId, records, fieldsByRecord);
  return { buffer, ...info };
}
