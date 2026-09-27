/**
 * One sponsor switchboard. Keys and SOLANA_PROOF_ENABLED already turn each
 * provider off. This module only reports that state. It does not read secret
 * values into the log and it does not add a second flag system.
 */

export type SponsorState = "enabled" | "disabled" | "misconfigured";

export type SponsorStatus = {
  gemini: SponsorState;
  grok: SponsorState;
  elevenlabs: SponsorState;
  backboard: SponsorState;
  tiger: SponsorState;
  mongodb: SponsorState;
  solana: SponsorState;
};

const ORDER = [
  "gemini",
  "grok",
  "elevenlabs",
  "backboard",
  "tiger",
  "mongodb",
  "solana",
] as const;

function text(value: string | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Blank is absent. A trimmed value with whitespace or control characters is malformed. */
export function usableSecret(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\s\u0000]/.test(trimmed)) return undefined;
  return trimmed;
}

function token(value: string | undefined): "absent" | "ok" | "malformed" {
  if (typeof value !== "string" || value.trim() === "") return "absent";
  return usableSecret(value) ? "ok" : "malformed";
}

function keyState(env: NodeJS.ProcessEnv, name: string): SponsorState {
  const state = token(text(env[name]));
  if (state === "malformed") return "misconfigured";
  return state === "ok" ? "enabled" : "disabled";
}

function tigerState(env: NodeJS.ProcessEnv): SponsorState {
  const raw = text(env.TIGERDATA_DATABASE_URL)?.trim() ?? "";
  if (!raw) return "disabled";
  try {
    const url = new URL(raw);
    if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
        !url.hostname || !url.username || !url.password) return "misconfigured";
    const sslmode = url.searchParams.get("sslmode")?.toLowerCase();
    return sslmode === undefined || sslmode === "verify-ca" || sslmode === "verify-full"
      ? "enabled"
      : "misconfigured";
  } catch {
    return "misconfigured";
  }
}

function mongoState(env: NodeJS.ProcessEnv): SponsorState {
  const uri = text(env.MONGODB_URI)?.trim() ?? "";
  const user = token(text(env.MONGODB_USERNAME));
  const password = text(env.MONGODB_PASSWORD);
  const pass = password === undefined || password.trim() === ""
    ? "absent"
    : /[\r\n\u0000]/.test(password) ? "malformed" : "ok";
  if (!uri) return user !== "absent" || pass !== "absent" ? "misconfigured" : "disabled";
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) return "misconfigured";
  if (user === "malformed" || pass === "malformed") return "misconfigured";
  if ((user === "ok") !== (pass === "ok")) return "misconfigured";
  return "enabled";
}

function solanaState(env: NodeJS.ProcessEnv): SponsorState {
  const flag = text(env.SOLANA_PROOF_ENABLED)?.trim() ?? "";
  if (flag === "" || flag === "0") return "disabled";
  if (flag !== "1") return "misconfigured";
  const cluster = (text(env.SOLANA_CLUSTER) ?? "devnet").trim();
  const rpc = (text(env.SOLANA_RPC_URL) ?? "https://api.devnet.solana.com").trim();
  let host = "";
  try {
    const endpoint = new URL(rpc);
    if (endpoint.protocol !== "https:") return "misconfigured";
    host = endpoint.hostname;
  } catch {
    host = "";
  }
  const keypair = text(env.SOLANA_KEYPAIR_PATH)?.trim() ?? "";
  if (cluster !== "devnet" || host !== "api.devnet.solana.com" || !keypair) return "misconfigured";
  return "enabled";
}

export function sponsorStatus(env: NodeJS.ProcessEnv = process.env): SponsorStatus {
  return {
    gemini: keyState(env, "GEMINI_API_KEY"),
    grok: keyState(env, "GROK_API_KEY"),
    elevenlabs: keyState(env, "ELEVENLABS_API_KEY"),
    backboard: keyState(env, "BACKBOARD_API_KEY"),
    tiger: tigerState(env),
    mongodb: mongoState(env),
    solana: solanaState(env),
  };
}

export function formatSponsorStatus(status: SponsorStatus = sponsorStatus()): string {
  return `sponsors ${ORDER.map((name) => `${name}=${status[name]}`).join(" ")}`;
}

export function logSponsorStatus(env?: NodeJS.ProcessEnv): void {
  console.error(formatSponsorStatus(sponsorStatus(env)));
}
