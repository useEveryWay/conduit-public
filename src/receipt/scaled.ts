/**
 * Display-only fixed-point deltas.
 * Same 9-digit conversion the router uses internally, copied here so this
 * module can print exact differences. It never accepts or rejects an edge.
 */
const SCALE_DIGITS = 9;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

export function toScaled(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new Error("route metric must be a finite number");
  }
  const negative = value < 0;
  const [whole, frac = ""] = Math.abs(value).toFixed(SCALE_DIGITS).split(".");
  const scaled = BigInt(whole) * SCALE + BigInt(frac);
  return negative ? -scaled : scaled;
}

export function formatScaled(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE)
    .toString()
    .padStart(SCALE_DIGITS, "0")
    .replace(/0+$/, "");
  const text = fraction.length === 0 ? `${whole}` : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

export function formatDelta(nextScaled: bigint, previousScaled: bigint): string {
  const delta = nextScaled - previousScaled;
  if (delta === 0n) return "+0";
  return delta > 0n ? `+${formatScaled(delta)}` : `-${formatScaled(-delta)}`;
}
