const ZONE = "America/Santiago";

const santiagoClock = new Intl.DateTimeFormat("es-CL", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

export function formatSantiago(ms: number): string {
  const parts = santiagoClock.formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const zoneName = pick("timeZoneName");
  const zone = /GMT|UTC/i.test(zoneName) ? ZONE : zoneName || ZONE;
  return `${pick("hour")}:${pick("minute")}:${pick("second")} ${zone}`;
}

export function formatAgo(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `hace ${hours}h ${minutes % 60}m`;
}
