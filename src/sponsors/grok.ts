import type { IncomingMessage, ServerResponse } from "node:http";
import { ContractRejection } from "../errors.ts";
import { usableSecret } from "./status.ts";
import { reserveSponsorCall } from "./budget.ts";

/** Optional sponsor paraphrase. Not part of the frozen public API. */
export const GROK_EXPLAIN_PATH = "/v1/sponsors/grok/explain";

const GROK_CHAT_URL = "https://api.x.ai/v1/chat/completions";
const GROK_MODEL = "grok-4.6";
const MAX_EXPLANATION_CHARS = 2000;

const PARAPHRASE_INSTRUCTION = [
  "Paraphrase the existing route explanation for a facility operator.",
  "Keep the same facts, status, and path.",
  "Do not choose a route, add or remove edges, or change distance, time, or world state.",
  "Return only the paraphrase.",
].join(" ");

export type GrokExplainResult = {
  enabled: boolean;
  note: string | null;
};

export type GrokFetch = (url: string, init: RequestInit) => Promise<Response>;

export type GrokExplainOptions = {
  apiKey?: string | null;
  fetchImpl?: GrokFetch;
};

type SponsorIo = {
  readBody: (req: IncomingMessage) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

export function grokApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return usableSecret(env.GROK_API_KEY) ?? null;
}

export function explanationFromBody(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ContractRejection("explanation is required");
  }
  const explanation = (body as { explanation?: unknown }).explanation;
  if (typeof explanation !== "string" || explanation.trim().length === 0) {
    throw new ContractRejection("explanation is required");
  }
  if (explanation.length > MAX_EXPLANATION_CHARS) {
    throw new ContractRejection("explanation is too long");
  }
  return explanation;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(content)) return null;
  const joined = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("")
    .trim();
  return joined.length > 0 ? joined : null;
}

function noteFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
  return textOf(message?.content);
}

export async function paraphraseRouteExplanation(
  explanation: string,
  options: GrokExplainOptions = {},
): Promise<GrokExplainResult> {
  const supplied = options.apiKey === undefined ? grokApiKey() : options.apiKey;
  const apiKey = typeof supplied === "string" ? usableSecret(supplied) : undefined;
  if (!apiKey) return { enabled: false, note: null };
  if (!reserveSponsorCall("grok")) return { enabled: true, note: null };

  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const response = await fetchImpl(GROK_CHAT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        max_tokens: 192,
        stream: false,
        messages: [
          { role: "system", content: PARAPHRASE_INSTRUCTION },
          { role: "user", content: explanation },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { enabled: true, note: null };
    return { enabled: true, note: noteFromPayload(await response.json()) };
  } catch {
    return { enabled: true, note: null };
  }
}

export async function explainForSponsor(body: unknown, options?: GrokExplainOptions): Promise<GrokExplainResult> {
  return paraphraseRouteExplanation(explanationFromBody(body), options);
}

export function startSponsorGrok(req: IncomingMessage, res: ServerResponse, io: SponsorIo): void {
  io.readBody(req)
    .then((body) => explainForSponsor(body))
    .then((result) => {
      if (!res.headersSent && !res.writableEnded) io.sendJson(res, 200, result);
    })
    .catch((error: unknown) => {
      if (res.headersSent || res.writableEnded) return;
      if (error instanceof ContractRejection) {
        io.sendJson(res, error.statusCode, { error: error.message });
        return;
      }
      io.sendJson(res, 200, { enabled: grokApiKey() !== null, note: null });
    });
}
