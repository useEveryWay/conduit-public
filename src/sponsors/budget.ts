import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Ledger = { day: string; calls: number; providers: Record<string, number>; recent: number[] };
type BudgetOptions = { path: string; maxCallsPerDay?: number; maxCallsPerMinute?: number; clock?: () => number };

export class SponsorBudget {
  private readonly options: Required<BudgetOptions>;

  constructor(options: BudgetOptions) {
    this.options = {
      ...options,
      maxCallsPerDay: limit(options.maxCallsPerDay, 60),
      maxCallsPerMinute: limit(options.maxCallsPerMinute, 8),
      clock: options.clock ?? Date.now,
    };
  }

  private ledger(): Ledger {
    const day = new Date(this.options.clock()).toISOString().slice(0, 10);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.options.path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { day, calls: 0, providers: {}, recent: [] };
      throw new Error("Sponsor budget cannot be read");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("Sponsor budget is invalid");
    const value = parsed as Ledger;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.day) || !Number.isSafeInteger(value.calls) || value.calls < 0 ||
        !value.providers || typeof value.providers !== "object" || Array.isArray(value.providers) ||
        Object.values(value.providers).some(count => !Number.isSafeInteger(count) || count < 0)) {
      throw new Error("Sponsor budget is invalid");
    }
    value.recent ??= [];
    if (!Array.isArray(value.recent) || value.recent.some(at => !Number.isSafeInteger(at) || at < 0)) throw new Error("Sponsor budget is invalid");
    return value.day === day ? value : { day, calls: 0, providers: {}, recent: [] };
  }

  reserve(provider: string): boolean {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider)) return false;
    let lock: number | undefined;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      const lockPath = `${this.options.path}.lock`;
      try { lock = openSync(lockPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = Number(readFileSync(lockPath, "utf8"));
        if (!Number.isSafeInteger(owner) || owner <= 0) return false;
        try { process.kill(owner, 0); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
        unlinkSync(lockPath);
        lock = openSync(lockPath, "wx", 0o600);
      }
      writeFileSync(lock, String(process.pid));
      const now = this.options.clock();
      const ledger = this.ledger();
      ledger.recent = ledger.recent.filter(at => at > now - 60_000);
      if (ledger.calls >= this.options.maxCallsPerDay || ledger.recent.length >= this.options.maxCallsPerMinute) return false;
      ledger.calls += 1;
      ledger.providers[provider] = (ledger.providers[provider] ?? 0) + 1;
      ledger.recent.push(now);
      writeFileSync(`${this.options.path}.tmp`, JSON.stringify(ledger) + "\n", { mode: 0o600 });
      renameSync(`${this.options.path}.tmp`, this.options.path);
      return true;
    } catch {
      return false;
    } finally {
      if (lock !== undefined) {
        closeSync(lock);
        try { unlinkSync(`${this.options.path}.lock`); } catch {}
      }
    }
  }

  status() {
    try {
      const ledger = this.ledger();
      return { configured: true, available: true, ...ledger, remaining: Math.max(0, this.options.maxCallsPerDay - ledger.calls),
        maxCallsPerDay: this.options.maxCallsPerDay, maxCallsPerMinute: this.options.maxCallsPerMinute };
    } catch {
      return { configured: true, available: false, remaining: 0 };
    }
  }
}

function limit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : fallback;
}

let active: SponsorBudget | null = null;

export function configureSponsorBudget(options: BudgetOptions | null): void {
  active = options ? new SponsorBudget(options) : null;
}

export function reserveSponsorCall(provider: string): boolean {
  return active?.reserve(provider) ?? true;
}

export function sponsorBudgetStatus() {
  return active?.status() ?? { configured: false, available: true };
}
