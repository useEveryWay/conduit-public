import type { IncomingMessage, ServerResponse } from "node:http";
import { usableSecret } from "./status.ts";
import { reserveSponsorCall } from "./budget.ts";

/**
 * Optional floor-plan notes. Off unless GEMINI_API_KEY is set.
 * This path is not part of the frozen public API and must not write
 * graph, node ids, edge ids, obstruction state, or routes.
 */
export const GEMINI_FLOOR_PLAN_PATH = "/v1/sponsors/gemini/floor-plan";

export function geminiModel(): string {
  return configuredGeminiModel() ?? "gemini-flash-lite-latest";
}

const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const STOP_STATUS = new Set([401, 403, 402, 429]);
const MAX_BODY_BYTES = 3_000_000;
const MAX_IMAGE_CHARS = 2_000_000;
const MAX_NOTES = 5;
const MAX_NOTE_LENGTH = 240;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const FLOOR_PLAN_PROMPT = [
  "Look at this floor-plan image and reply with JSON only: {\"notes\":[\"...\"]}.",
  "Write at most 5 short notes about what the drawing appears to show, such as rooms, ramps, stairs, narrow passages, or unclear markings.",
  "The notes are advisory suggestions for a human operator.",
  "Do not propose a route, path, node list, or edge list.",
  "Do not say that any passage is clear or blocked.",
  "Do not invent identifiers.",
  "If the image is not a floor plan, use one note that says so.",
].join(" ");

export type FloorPlanHintBody = {
  sponsor: "gemini";
  advisory: true;
  enabled: boolean;
  unavailable?: boolean;
  notes: string[];
};

type SendJson = (res: ServerResponse, status: number, body: unknown) => void;
type FloorImage = { mimeType: string; imageBase64: string };

const runtime: { fetch: typeof fetch } = { fetch: globalThis.fetch };

export function setGeminiTransport(next?: typeof fetch): void {
  runtime.fetch = next ?? globalThis.fetch;
}

export function geminiApiKey(io?: { apiKey?: string; env?: NodeJS.ProcessEnv }): string | undefined {
  const raw = io && "apiKey" in io ? io.apiKey : (io?.env ?? process.env).GEMINI_API_KEY;
  return usableSecret(raw);
}

export const getGeminiApiKey = geminiApiKey;

export type GeminiRequestBody = {
  contents: Array<{
    role: "user";
    parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>;
  }>;
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
    responseMimeType: "application/json";
    responseSchema: Record<string, unknown>;
  };
};

let cachedModel: string | undefined;
const retiredModels = new Set<string>();

export function resetGeminiModelCache(): void {
  cachedModel = undefined;
  retiredModels.clear();
}

/** Optional override. An empty value leaves selection to the live model list. */
export function configuredGeminiModel(): string | undefined {
  const raw = process.env.GEMINI_MODEL?.trim() ?? "";
  if (!raw) return undefined;
  const id = raw.replace(/^models\//, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(id)) return undefined;
  return id;
}

export function geminiGenerateUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

/** Newest stable `gemini-<version>-flash` that can call generateContent. */
export function selectGeminiModel(ids: readonly string[]): string | undefined {
  let best: { id: string; score: number } | undefined;
  for (const raw of ids) {
    const id = raw.replace(/^models\//, "");
    const match = /^gemini-(\d+)(?:\.(\d+))?-flash$/.exec(id);
    if (!match) continue;
    const score = Number(match[1]) * 1000 + Number(match[2] ?? 0);
    if (!best || score > best.score) best = { id, score };
  }
  return best?.id;
}

function suggestedReplacement(body: string): string | undefined {
  const match = /use models\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/i.exec(body);
  const id = match?.[1];
  if (!id || retiredModels.has(id)) return undefined;
  return id;
}

async function listGenerateModels(apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = "";
  for (let page = 0; page < 4; page += 1) {
    const url = new URL(MODELS_URL);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    if (!reserveSponsorCall("gemini")) throw new Error("sponsor budget exhausted");
    const response = await runtime.fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json", "x-goog-api-key": apiKey },
    });
    if (!response.ok) throw new Error("gemini models failed");
    const payload = await response.json() as {
      models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>;
      nextPageToken?: unknown;
    };
    for (const model of payload.models ?? []) {
      const methods = model.supportedGenerationMethods;
      if (!Array.isArray(methods) || !methods.includes("generateContent")) continue;
      if (typeof model.name !== "string") continue;
      ids.push(model.name.replace(/^models\//, ""));
    }
    if (typeof payload.nextPageToken !== "string" || payload.nextPageToken === "") break;
    pageToken = payload.nextPageToken;
  }
  return ids;
}

export async function resolveGeminiModel(apiKey: string): Promise<string> {
  const configured = configuredGeminiModel();
  if (configured && !retiredModels.has(configured)) return configured;
  if (cachedModel && !retiredModels.has(cachedModel)) return cachedModel;
  const selected = selectGeminiModel((await listGenerateModels(apiKey)).filter((id) => !retiredModels.has(id)));
  if (!selected) throw new Error("gemini model unavailable");
  cachedModel = selected;
  return selected;
}

async function postGenerate(apiKey: string, model: string, body: GeminiRequestBody): Promise<Response> {
  if (!reserveSponsorCall("gemini")) throw new Error("sponsor budget exhausted");
  return runtime.fetch(geminiGenerateUrl(model), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
}

async function replacementModel(apiKey: string, failed: string, errorBody: string): Promise<string | undefined> {
  const hinted = suggestedReplacement(errorBody);
  if (hinted && hinted !== failed) return hinted;
  try {
    return selectGeminiModel((await listGenerateModels(apiKey)).filter((id) => id !== failed && !retiredModels.has(id)));
  } catch {
    return undefined;
  }
}

/** One shared generateContent client for floor-plan hints and profile intake. */
export async function geminiGenerateContent(apiKey: string, body: GeminiRequestBody): Promise<unknown> {
  const model = await resolveGeminiModel(apiKey);
  const first = await postGenerate(apiKey, model, body);
  if (STOP_STATUS.has(first.status)) throw new Error("gemini request failed");
  if (first.status === 404) {
    const next = await replacementModel(apiKey, model, await first.text());
    if (!next || next === model) throw new Error("gemini request failed");
    retiredModels.add(model);
    cachedModel = next;
    const second = await postGenerate(apiKey, next, body);
    if (!second.ok) throw new Error("gemini request failed");
    return second.json();
  }
  if (!first.ok) throw new Error("gemini request failed");
  return first.json();
}

export function isGeminiFloorPlanPath(pathname: string): boolean {
  return pathname === GEMINI_FLOOR_PLAN_PATH || pathname === `${GEMINI_FLOOR_PLAN_PATH}/`;
}

function hintBody(input: { enabled: boolean; notes: string[]; unavailable?: boolean }): FloorPlanHintBody {
  const body: FloorPlanHintBody = {
    sponsor: "gemini",
    advisory: true,
    enabled: input.enabled,
    notes: input.notes,
  };
  if (input.unavailable) body.unavailable = true;
  return body;
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseFloorImage(body: unknown): FloorImage | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.mimeType !== "string" || !ALLOWED_MIME.has(record.mimeType)) return null;
  if (typeof record.imageBase64 !== "string") return null;
  const imageBase64 = record.imageBase64.replace(/\s/g, "");
  if (imageBase64.length === 0 || imageBase64.length > MAX_IMAGE_CHARS) return null;
  if (imageBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) return null;
  return { mimeType: record.mimeType, imageBase64 };
}

function cleanNote(note: string): string | null {
  const text = note.replace(/[\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/"nodeIds"|"edgeIds"|"obstructionState"/.test(text)) return null;
  if (/^(?:node|edge)-[a-z0-9-]+(?:,\s*(?:node|edge)-[a-z0-9-]+)*$/.test(text)) return null;
  return text.slice(0, MAX_NOTE_LENGTH);
}

export function geminiResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("gemini payload");
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || !candidates[0] || typeof candidates[0] !== "object") {
    throw new Error("gemini candidates");
  }
  const parts = (candidates[0] as { content?: { parts?: unknown } }).content?.parts;
  if (!Array.isArray(parts)) throw new Error("gemini parts");
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = (part as { text?: unknown }).text;
      return typeof value === "string" ? value : "";
    })
    .join("");
}

export function notesFromGeminiPayload(payload: unknown): string[] {
  const trimmed = geminiResponseText(payload).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { notes?: unknown }).notes)) {
    throw new Error("gemini notes");
  }
  const notes: string[] = [];
  for (const item of (parsed as { notes: unknown[] }).notes) {
    if (typeof item !== "string") continue;
    const note = cleanNote(item);
    if (!note) continue;
    notes.push(note);
    if (notes.length === MAX_NOTES) break;
  }
  return notes;
}

async function suggestNotes(apiKey: string, image: FloorImage): Promise<string[]> {
  const payload = await geminiGenerateContent(apiKey, {
    contents: [
      {
        role: "user",
        parts: [
          { text: FLOOR_PLAN_PROMPT },
          { inline_data: { mime_type: image.mimeType, data: image.imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 512,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          notes: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["notes"],
      },
    },
  });
  return notesFromGeminiPayload(payload);
}

export async function handleGeminiFloorPlan(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
): Promise<void> {
  if (req.method === "GET") {
    sendJson(res, 200, hintBody({ enabled: geminiApiKey() !== undefined, notes: [] }));
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  let raw = "";
  try {
    raw = await readRaw(req);
  } catch {
    sendJson(res, 400, { error: "floor image is too large" });
    return;
  }

  const apiKey = geminiApiKey();
  if (!apiKey) {
    sendJson(res, 200, hintBody({ enabled: false, notes: [] }));
    return;
  }

  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? undefined : JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "body is not json" });
    return;
  }
  const image = parseFloorImage(parsed);
  if (!image) {
    sendJson(res, 400, { error: "floor image required" });
    return;
  }

  try {
    const notes = await suggestNotes(apiKey, image);
    sendJson(res, 200, hintBody({ enabled: true, notes }));
  } catch {
    console.error("gemini floor-plan hint failed");
    sendJson(res, 200, hintBody({ enabled: true, unavailable: true, notes: [] }));
  }
}
