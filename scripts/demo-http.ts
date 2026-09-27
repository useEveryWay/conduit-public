export const VENUE_ID = "seaside-market";

export function conduitBase(): string {
  return (process.env.CONDUIT_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
}

export async function getJson(path: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${conduitBase()}${path}`, {
    headers: { accept: "application/json" },
  });
  const json = await response.json();
  return { status: response.status, json };
}

export async function postJson(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${conduitBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}
