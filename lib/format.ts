export function priceDigits(value: number): number {
  const abs = Math.abs(value);
  if (abs === 0) return 2;
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 5;
  return 6;
}

export function formatPrice(value: number): string {
  const digits = priceDigits(value);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: true,
  });
}

export function formatPct(value: number, digits = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

export function formatFunding(value: number): string {
  return formatPct(value, 6);
}

export function formatCompact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [divisor, suffix] of units) {
    if (abs >= divisor) {
      const scaled = abs / divisor;
      const digits = scaled >= 10 ? 1 : 2;
      const rendered = scaled.toFixed(digits).replace(/\.0$/, "");
      return `${sign}${rendered}${suffix}`;
    }
  }
  return `${sign}${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function formatFull(value: number, unit?: string): string {
  const rendered = value.toLocaleString("en-US", { maximumFractionDigits: 8 });
  return unit ? `${rendered} ${unit}` : rendered;
}

export function tone(value: number | null): "up" | "down" | "flat" {
  if (value == null || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}
