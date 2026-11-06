const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Monday 00:00:00.000 UTC through the next Monday 00:00:00.000 UTC, end exclusive. */
export function utcWeek(now: number): { startMs: number; endMs: number } {
  const date = new Date(now);
  const daysFromMonday = (date.getUTCDay() + 6) % 7;
  const startMs = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - daysFromMonday,
    0,
    0,
    0,
    0,
  );
  return { startMs, endMs: startMs + WEEK_MS };
}

export function msToNanos(ms: number): string {
  if (!Number.isSafeInteger(ms)) throw new Error("timestamp fuera de rango");
  return `${ms}000000`;
}

const utcFormat = new Intl.DateTimeFormat("es-CL", {
  timeZone: "UTC",
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function formatUtcInstant(ms: number): string {
  const formatted = utcFormat.format(new Date(ms)).replace(",", "");
  return `${formatted}.000 UTC`;
}

export function formatUtcWeek(startMs: number, endMs: number): string {
  return `Desde ${formatUtcInstant(startMs)} hasta ${formatUtcInstant(endMs)}, sin incluir el instante final.`;
}
