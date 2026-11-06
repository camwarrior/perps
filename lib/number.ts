export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Oracle channel prices are integer wei strings (18 decimals), often past MAX_SAFE_INTEGER. */
export function weiToNumber(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    const raw = BigInt(value);
    const scale = BigInt(10) ** BigInt(18);
    const whole = raw / scale;
    const fraction = (raw % scale).toString().padStart(18, "0").slice(0, 8);
    const parsed = Number(`${whole.toString()}.${fraction}`);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function baseFromSymbol(symbol: string): string {
  const head = symbol.split("[")[0]?.trim().toUpperCase() ?? "";
  if (!head) return "";
  if (head.endsWith("/USDC")) return head.slice(0, -5);
  if (head.endsWith("-USDC")) return head.slice(0, -5);
  const slash = head.indexOf("/");
  if (slash > 0) return head.slice(0, slash);
  return head;
}

export function hoursLabel(hours: number): string | null {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const known: Array<[number, string]> = [
    [1, "1h"],
    [4, "4h"],
    [8, "8h"],
  ];
  for (const [target, label] of known) {
    if (Math.abs(hours - target) < 0.05) return label;
  }
  if (hours >= 1) {
    const rounded = Math.round(hours * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded.toFixed(0)}h` : `${rounded.toFixed(1)}h`;
  }
  const minutes = Math.round(hours * 60);
  return minutes > 0 ? `${minutes}m` : null;
}

/** RISEx durations are nanoseconds. */
export function intervalLabelFromNanos(value: unknown): string | null {
  const ns = parseNumber(value);
  if (ns == null || ns <= 0) return null;
  return hoursLabel(ns / 1e9 / 3600);
}

export function intervalLabelFromMs(value: unknown): string | null {
  const ms = parseNumber(value);
  if (ms == null || ms <= 0) return null;
  return hoursLabel(ms / 3_600_000);
}

export function publicError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "error de red";
  const clean = raw.replace(/\s+/g, " ").trim().slice(0, 160);
  return clean || "error de red";
}
