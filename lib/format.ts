// Intl formatters are expensive to build and the book formats hundreds of cells per refresh.
// Each distinct option set is built once and reused.
const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(minDigits: number, maxDigits: number): Intl.NumberFormat {
  const key = `${minDigits}:${maxDigits}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: minDigits,
      maximumFractionDigits: maxDigits,
      useGrouping: true,
    });
    numberFormats.set(key, format);
  }
  return format;
}

/** Decimals that keep about four significant digits for sub-cent prices (PEPE and the like). */
export function priceDigits(value: number): number {
  const abs = Math.abs(value);
  if (abs === 0) return 2;
  if (abs >= 1000) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 5;
  const leadingZeros = Math.ceil(-Math.log10(abs));
  return Math.min(12, leadingZeros + 3);
}

export function formatPrice(value: number): string {
  const digits = priceDigits(value);
  return numberFormat(digits, digits).format(value);
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
  return `${sign}${numberFormat(0, 0).format(abs)}`;
}

/** Quantities in base units: compact from ten thousand up (PEPE OI would be 12 digits). */
export function formatQty(value: number): string {
  return Math.abs(value) >= 1e4 ? formatCompact(value) : formatPrice(value);
}

/** Signed price change. Sub-cent changes keep two significant digits so the cell stays short. */
export function formatDelta(value: number): string {
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 0.01 ? Math.min(12, Math.ceil(-Math.log10(abs)) + 1) : priceDigits(value);
  const sign = value > 0 ? "+" : "";
  return `${sign}${numberFormat(digits, digits).format(value)}`;
}

/** Exact value for tooltips. Large figures drop the float tail that adds no information. */
export function formatFull(value: number, unit?: string): string {
  const abs = Math.abs(value);
  const max = abs >= 1000 ? 2 : abs >= 1 ? 6 : 10;
  const rendered = numberFormat(0, max).format(value);
  return unit ? `${rendered} ${unit}` : rendered;
}

export function tone(value: number | null): "up" | "down" | "flat" {
  if (value == null || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}
