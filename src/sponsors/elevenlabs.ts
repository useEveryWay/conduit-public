import type { IncomingMessage, ServerResponse } from "node:http";
import { usableSecret } from "./status.ts";
import { reserveSponsorCall } from "./budget.ts";

/**
 * Speaks the explanation string Enigma already put on the route response.
 * This sponsor call is not part of routing. It stays off unless ELEVENLABS_API_KEY is set,
 * and a missing key, timeout, or upstream error only affects this response.
 */

export const ELEVENLABS_SPEAK_PATH = "/v1/sponsors/elevenlabs/speak";

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = "hpp4J3VqNfWAUOO0d1Us";
const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_EXPLANATION_CHARS = 1_000;
const VOICE_ID = /^[A-Za-z0-9]{8,64}$/;
const MODEL_ID = /^[A-Za-z0-9._-]{1,64}$/;

export type SpeakDisabledReason =
  | "missing_api_key"
  | "budget_exhausted"
  | "invalid_explanation"
  | "timeout"
  | "upstream_error";

export type SpeakSuccess = {
  enabled: true;
  audio: Uint8Array;
  contentType: string;
};

export type SpeakDisabled = {
  enabled: false;
  reason: SpeakDisabledReason;
};

export type SpeakResult = SpeakSuccess | SpeakDisabled;

export type SpeakEnv = {
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ELEVENLABS_MODEL_ID?: string;
  ELEVENLABS_TIMEOUT_MS?: string;
};

export type ElevenLabsFetch = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: ElevenLabsFetch = (url, init) => globalThis.fetch(url, init);

let fetchImpl: ElevenLabsFetch = defaultFetch;

export function setElevenLabsFetch(next: ElevenLabsFetch | null): void {
  fetchImpl = next ?? defaultFetch;
}

export function isElevenLabsSpeak(req: IncomingMessage): boolean {
  if (req.method !== "POST") return false;
  const path = (req.url ?? "").split("?")[0];
  return path === ELEVENLABS_SPEAK_PATH;
}

function disabled(reason: SpeakDisabledReason): SpeakDisabled {
  return { enabled: false, reason };
}

export function readElevenLabsKey(env: SpeakEnv = process.env): string | null {
  return usableSecret(env.ELEVENLABS_API_KEY) ?? null;
}

function voiceId(env: SpeakEnv): string {
  const configured = env.ELEVENLABS_VOICE_ID?.trim() ?? "";
  return VOICE_ID.test(configured) ? configured : DEFAULT_VOICE_ID;
}

function modelId(env: SpeakEnv): string {
  const configured = env.ELEVENLABS_MODEL_ID?.trim() ?? "";
  return MODEL_ID.test(configured) ? configured : DEFAULT_MODEL_ID;
}

function timeoutMs(env: SpeakEnv, override?: number): number {
  if (override !== undefined) return override;
  const parsed = Number(env.ELEVENLABS_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 30_000) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function startTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("timeout", "TimeoutError"));
  }, ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

export async function speakExplanation(
  explanation: string,
  options?: { env?: SpeakEnv; fetchImpl?: ElevenLabsFetch; timeoutMs?: number },
): Promise<SpeakResult> {
  if (typeof explanation !== "string" || explanation.trim().length === 0 || explanation.length > MAX_EXPLANATION_CHARS) {
    return disabled("invalid_explanation");
  }
  const env = options?.env ?? process.env;
  const apiKey = readElevenLabsKey(env);
  if (!apiKey) return disabled("missing_api_key");
  if (!reserveSponsorCall("elevenlabs")) return disabled("budget_exhausted");

  const call = options?.fetchImpl ?? fetchImpl;
  const timeout = startTimeout(timeoutMs(env, options?.timeoutMs));
  try {
    const response = await call(`${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId(env))}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        accept: "audio/mpeg",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: explanation,
        model_id: modelId(env),
      }),
      redirect: "error",
      signal: timeout.signal,
    });
    if (!response.ok) return disabled("upstream_error");
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("audio/")) return disabled("upstream_error");
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) return disabled("upstream_error");
    return { enabled: true, audio, contentType };
  } catch (error) {
    if (isTimeout(error)) return disabled("timeout");
    return disabled("upstream_error");
  } finally {
    timeout.cancel();
  }
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "accept, content-type",
};

function statusFor(reason: SpeakDisabledReason): number {
  if (reason === "missing_api_key") return 200;
  if (reason === "budget_exhausted") return 429;
  if (reason === "invalid_explanation") return 400;
  if (reason === "timeout") return 504;
  return 502;
}

function writeJson(res: ServerResponse, status: number, body: SpeakDisabled): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeAudio(res: ServerResponse, audio: Uint8Array, contentType: string): void {
  res.writeHead(200, {
    ...CORS_HEADERS,
    "cache-control": "no-store",
    "content-type": contentType,
    "content-length": audio.byteLength,
  });
  res.end(Buffer.from(audio));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) {
      throw new Error("body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function handleElevenLabsSpeak(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const explanation =
      body && typeof body === "object" && "explanation" in body
        ? (body as { explanation: unknown }).explanation
        : undefined;
    if (typeof explanation !== "string") {
      writeJson(res, 400, disabled("invalid_explanation"));
      return;
    }
    const result = await speakExplanation(explanation);
    if (result.enabled === false) {
      writeJson(res, statusFor(result.reason), result);
      return;
    }
    writeAudio(res, result.audio, result.contentType);
  } catch {
    if (!res.headersSent && !res.writableEnded) {
      writeJson(res, 400, disabled("invalid_explanation"));
    }
  }
}
