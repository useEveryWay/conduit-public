import type { IncomingMessage, ServerResponse } from "node:http";
import {
  geminiApiKey,
  geminiGenerateContent,
  geminiResponseText,
  type GeminiRequestBody,
} from "./gemini.ts";

/**
 * Turns one uploaded document into functional profile proposals.
 * Uses the shared Gemini client. It does not write a session, a route,
 * or a diagnosis.
 */
export const PROFILE_INTAKE_PATH = "/v1/profile-intake/extract";

const MAX_DOCUMENT_BYTES = 1_000_000;

export const INTAKE_FIELDS = [
  "requirements.avoidStairs",
  "requirements.maxSlope",
  "requirements.minWidthM",
  "preferences.preferLowCrowd",
  "preferences.preferLowNoise",
  "preferences.preferShorterDistance",
  "presentation.audioGuidance",
  "presentation.visualGuidance",
  "presentation.highContrast",
  "presentation.language",
] as const;

export type IntakeField = (typeof INTAKE_FIELDS)[number];

export type IntakeProposal = {
  field: IntakeField;
  value: boolean | number | string;
  confidence: number;
  evidence: { text: string; page?: number };
  confirmationRequired: true;
};

export type IntakeResult = {
  available: boolean;
  unavailable?: boolean;
  proposals: IntakeProposal[];
};

type SendJson = (res: ServerResponse, status: number, body: unknown) => void;

type DocumentPart = {
  mimeType: string;
  filename: string;
  data: Buffer;
  text?: string;
};

const TEXT_MIME = new Set(["text/plain", "text/markdown"]);
const BINARY_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const DIAGNOSIS = /\b(diagnos(?:is|ed|es)|disease|syndrome|disorder|icd(?:-\d+)?|medication|prescribed|prognosis)\b/i;

const FUNCTIONAL: Record<IntakeField, RegExp> = {
  "requirements.avoidStairs": /\b(stairs?|step[-\s]?free|wheelchair|walker|ramp|elevator|lift)\b/i,
  "requirements.maxSlope": /\b(slope|grade|incline)\b/i,
  "requirements.minWidthM": /\b(width|clearance|doorway|passage|aisle|wide)\b/i,
  "preferences.preferLowCrowd": /\b(crowds?|crowded)\b/i,
  "preferences.preferLowNoise": /\b(noise|noisy|quiet|loud)\b/i,
  "preferences.preferShorterDistance": /\b(shorter (?:walking )?distance|limited walking|cannot walk far|walking distance)\b/i,
  "presentation.audioGuidance": /\b(audio|spoken|verbal|hearing)\b/i,
  "presentation.visualGuidance": /\b(visual|large print|sighted|display)\b/i,
  "presentation.highContrast": /\b(high[-\s]?contrast|contrast)\b/i,
  "presentation.language": /\b(language|interpreter)\b/i,
};

const INTAKE_PROMPT = [
  "Translate this document into functional indoor-navigation needs.",
  "Reply with JSON only, matching the schema. Do not write prose.",
  "Allowed fields are requirements.avoidStairs, requirements.maxSlope, requirements.minWidthM,",
  "preferences.preferLowCrowd, preferences.preferLowNoise, preferences.preferShorterDistance,",
  "presentation.audioGuidance, presentation.visualGuidance, presentation.highContrast, and presentation.language.",
  "A clinical condition may inform a functional need, but do not name any condition, history, or medication in a field, value, or evidence quote.",
  "evidenceText must be a short quote from the document. evidencePage is the page number when one is shown, otherwise omit it.",
  "value is a string: true, false, a number, or a language name that appears in the quote.",
  "confidence is from 0 to 1.",
  "Omit a field when the document does not support it.",
  "If two statements conflict, omit that field.",
  "Never invent a slope or a width. Omit requirements.maxSlope and requirements.minWidthM unless the quote states the measurement.",
  "maxSlope is a rise/run decimal. minWidthM is meters.",
  "Return an empty proposals array when nothing functional is supported.",
].join(" ");

const INTAKE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    proposals: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          field: { type: "STRING", enum: [...INTAKE_FIELDS] },
          value: { type: "STRING" },
          confidence: { type: "NUMBER" },
          evidenceText: { type: "STRING" },
          evidencePage: { type: "INTEGER" },
        },
        required: ["field", "value", "confidence", "evidenceText"],
      },
    },
  },
  required: ["proposals"],
};

function unavailable(): IntakeResult {
  return { available: false, unavailable: true, proposals: [] };
}

export function isProfileIntakePath(pathname: string): boolean {
  return pathname === PROFILE_INTAKE_PATH || pathname === `${PROFILE_INTAKE_PATH}/`;
}

function readLimited(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function headerValue(headers: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(headers);
  return match?.[1]?.trim();
}

function boundaryOf(contentType: string): string | undefined {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim();
  if (!boundary || boundary.length > 200 || boundary.includes("\r") || boundary.includes("\n")) return undefined;
  return boundary;
}

function splitParts(body: Buffer, boundary: string): Buffer[] {
  const marker = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let cursor = body.indexOf(marker);
  if (cursor < 0) return [];
  cursor += marker.length;
  while (cursor < body.length) {
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;
    else if (body[cursor] === 10) cursor += 1;
    const next = body.indexOf(marker, cursor);
    if (next < 0) return [];
    let end = next;
    if (end >= 2 && body[end - 2] === 13 && body[end - 1] === 10) end -= 2;
    else if (end >= 1 && body[end - 1] === 10) end -= 1;
    parts.push(body.subarray(cursor, end));
    cursor = next + marker.length;
  }
  return parts;
}

function mimeFromName(filename: string): string | undefined {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "txt") return "text/plain";
  if (extension === "md") return "text/markdown";
  if (extension === "pdf") return "application/pdf";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return undefined;
}

function parseDocument(contentType: string, body: Buffer): { ok: true; document: DocumentPart } | { ok: false; error: string } {
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return { ok: false, error: "document upload must be multipart" };
  }
  const boundary = boundaryOf(contentType);
  if (!boundary) return { ok: false, error: "document upload is malformed" };
  const parts = splitParts(body, boundary);
  if (parts.length === 0) return { ok: false, error: "document upload is malformed" };
  let found: DocumentPart | undefined;
  for (const part of parts) {
    const splitAt = part.indexOf(Buffer.from("\r\n\r\n"));
    const split = splitAt >= 0 ? splitAt : part.indexOf(Buffer.from("\n\n"));
    if (split < 0) continue;
    const sep = part.subarray(split, split + 4).equals(Buffer.from("\r\n\r\n")) ? 4 : 2;
    const headers = part.subarray(0, split).toString("utf8");
    const disposition = headerValue(headers, "content-disposition") ?? "";
    const name = /name="([^"]+)"/i.exec(disposition)?.[1];
    if (name !== "document") continue;
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? "document.txt";
    const declared = headerValue(headers, "content-type")?.split(";")[0]?.trim().toLowerCase();
    const mimeType = declared && (TEXT_MIME.has(declared) || BINARY_MIME.has(declared))
      ? declared
      : mimeFromName(filename);
    if (!mimeType || (!TEXT_MIME.has(mimeType) && !BINARY_MIME.has(mimeType))) {
      return { ok: false, error: "document type is not supported" };
    }
    const data = part.subarray(split + sep);
    if (data.length === 0) return { ok: false, error: "document is empty" };
    const text = TEXT_MIME.has(mimeType) ? data.toString("utf8") : undefined;
    if (text !== undefined && text.trim() === "") return { ok: false, error: "document is empty" };
    found = { mimeType, filename, data, text };
  }
  if (!found) return { ok: false, error: "document field is required" };
  return { ok: true, document: found };
}

function norm(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.02;
}

function matchMeasure(model: number, candidates: number[]): number | undefined {
  if (!Number.isFinite(model) || candidates.length === 0) return undefined;
  const matched = candidates.find((candidate) => close(candidate, model));
  if (matched !== undefined) return round4(matched);
  if (candidates.length === 1) return round4(candidates[0]);
  return undefined;
}

function slopeCandidates(evidence: string): number[] {
  const found: number[] = [];
  for (const match of evidence.matchAll(/(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)/g)) {
    const rise = Number(match[1]);
    const run = Number(match[2]);
    if (run > 0 && rise >= 0 && rise / run <= 1) found.push(rise / run);
  }
  for (const match of evidence.matchAll(/(\d+(?:\.\d+)?)\s*(%|percent)\b/gi)) {
    found.push(Number(match[1]) / 100);
  }
  for (const match of evidence.matchAll(/\b(?:slope|grade|incline)\s*(?:of|is|=|:)?\s*(0?\.\d+)\b/gi)) {
    found.push(Number(match[1]));
  }
  return found.filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}

function widthCandidates(evidence: string): number[] {
  const found: number[] = [];
  const pattern = /(\d+(?:\.\d+)?)\s*(inches|inch|centimetres|centimeters|cm|millimetres|millimeters|mm|metres|meters|m|feet|foot|ft)\b/gi;
  for (const match of evidence.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    let meters = amount;
    if (unit === "inch" || unit === "inches") meters = amount * 0.0254;
    else if (unit === "cm" || unit.startsWith("centimet")) meters = amount / 100;
    else if (unit === "mm" || unit.startsWith("millimet")) meters = amount / 1000;
    else if (unit === "ft" || unit === "foot" || unit === "feet") meters = amount * 0.3048;
    if (meters > 0 && meters < 10) found.push(meters);
  }
  return found;
}

function isField(value: string): value is IntakeField {
  return (INTAKE_FIELDS as readonly string[]).includes(value);
}

function functional(field: IntakeField, evidence: string): boolean {
  return FUNCTIONAL[field].test(evidence);
}

function quotedInDocument(evidence: string, documentText: string | undefined): boolean {
  const needle = norm(evidence);
  if (needle.length < 8) return false;
  if (documentText === undefined) return true;
  return norm(documentText).includes(needle);
}

function readValue(field: IntakeField, raw: unknown, evidence: string): boolean | number | string | undefined {
  if (field === "requirements.maxSlope" || field === "requirements.minWidthM") {
    const model = typeof raw === "number" ? raw : Number(raw);
    const candidates = field === "requirements.maxSlope" ? slopeCandidates(evidence) : widthCandidates(evidence);
    return matchMeasure(model, candidates);
  }
  if (field === "presentation.language") {
    if (typeof raw !== "string") return undefined;
    const value = raw.trim();
    if (value.length < 2 || value.length > 32) return undefined;
    if (DIAGNOSIS.test(value)) return undefined;
    if (!norm(evidence).includes(norm(value))) return undefined;
    return value;
  }
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  return undefined;
}

function sameValue(left: boolean | number | string, right: boolean | number | string): boolean {
  if (typeof left === "number" && typeof right === "number") return close(left, right);
  return left === right;
}

export function proposalsFromIntakePayload(payload: unknown, documentText?: string): IntakeProposal[] {
  const trimmed = geminiResponseText(payload).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { proposals?: unknown }).proposals)) {
    throw new Error("gemini intake");
  }
  const drafts: IntakeProposal[] = [];
  for (const item of (parsed as { proposals: unknown[] }).proposals) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.field !== "string" || !isField(record.field)) continue;
    const evidenceText = typeof record.evidenceText === "string"
      ? record.evidenceText
      : typeof (record.evidence as { text?: unknown } | undefined)?.text === "string"
        ? (record.evidence as { text: string }).text
        : "";
    const text = evidenceText.replace(/\s+/g, " ").trim();
    if (!text || DIAGNOSIS.test(text) || !functional(record.field, text) || !quotedInDocument(text, documentText)) {
      continue;
    }
    const confidence = record.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    const value = readValue(record.field, record.value, text);
    if (value === undefined) continue;
    const pageRaw = record.evidencePage ?? (record.evidence as { page?: unknown } | undefined)?.page;
    const page = typeof pageRaw === "number" && Number.isInteger(pageRaw) && pageRaw >= 1 && pageRaw <= 500
      ? pageRaw
      : undefined;
    const evidence: IntakeProposal["evidence"] = page === undefined ? { text } : { text, page };
    drafts.push({
      field: record.field,
      value,
      confidence,
      evidence,
      confirmationRequired: true,
    });
  }
  const grouped = new Map<IntakeField, IntakeProposal[]>();
  for (const draft of drafts) {
    const list = grouped.get(draft.field) ?? [];
    list.push(draft);
    grouped.set(draft.field, list);
  }
  const proposals: IntakeProposal[] = [];
  for (const field of INTAKE_FIELDS) {
    const list = grouped.get(field);
    if (!list || list.length === 0) continue;
    const [first] = list;
    if (!first || list.some((item) => !sameValue(item.value, first.value))) continue;
    const best = list.reduce((current, item) => (item.confidence > current.confidence ? item : current));
    proposals.push({ ...best, confirmationRequired: true });
  }
  return proposals;
}

function requestBody(document: DocumentPart): GeminiRequestBody {
  const generationConfig: GeminiRequestBody["generationConfig"] = {
    temperature: 0,
    maxOutputTokens: 1024,
    responseMimeType: "application/json",
    responseSchema: INTAKE_SCHEMA,
  };
  if (document.text !== undefined) {
    return {
      contents: [{ role: "user", parts: [{ text: `${INTAKE_PROMPT}\n\nDocument:\n${document.text}` }] }],
      generationConfig,
    };
  }
  return {
    contents: [{
      role: "user",
      parts: [
        { text: INTAKE_PROMPT },
        { inline_data: { mime_type: document.mimeType, data: document.data.toString("base64") } },
      ],
    }],
    generationConfig,
  };
}

export async function handleProfileIntake(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  let raw: Buffer;
  try {
    raw = await readLimited(req, MAX_DOCUMENT_BYTES);
  } catch {
    sendJson(res, 400, { error: "document is too large" });
    return;
  }
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") {
    sendJson(res, 400, { error: "document upload must be multipart" });
    return;
  }
  const parsed = parseDocument(contentType, raw);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  const apiKey = geminiApiKey();
  if (!apiKey) {
    sendJson(res, 200, unavailable());
    return;
  }
  try {
    const payload = await geminiGenerateContent(apiKey, requestBody(parsed.document));
    const proposals = proposalsFromIntakePayload(payload, parsed.document.text);
    sendJson(res, 200, { available: true, proposals });
  } catch {
    console.error("profile intake extract failed");
    sendJson(res, 200, unavailable());
  }
}
