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

const utcDayMonth = new Intl.DateTimeFormat("es-CL", { timeZone: "UTC", day: "numeric", month: "short" });
const utcDay = new Intl.DateTimeFormat("es-CL", { timeZone: "UTC", day: "numeric" });
const utcYear = new Intl.DateTimeFormat("es-CL", { timeZone: "UTC", year: "numeric" });

/** "2–8 nov 2026": the seven UTC days of the window, for the visible label. */
export function formatUtcWeekShort(startMs: number, endMs: number): string {
  const start = new Date(startMs);
  const last = new Date(endMs - 1);
  const sameMonth = start.getUTCMonth() === last.getUTCMonth();
  const from = sameMonth ? utcDay.format(start) : utcDayMonth.format(start);
  return `Semana UTC ${from}–${utcDayMonth.format(last)} ${utcYear.format(last)}`.replace(/\./g, "");
}
