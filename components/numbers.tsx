import { formatCompact, formatFull, formatFunding, formatPct, formatPrice, tone } from "@/lib/format";

export function Missing({ title = "dato no disponible" }: { title?: string }) {
  return (
    <span className="missing" title={title}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">dato no disponible</span>
    </span>
  );
}

export function Price({ value, unit = "USDC" }: { value: number | null; unit?: string }) {
  if (value == null) return <Missing />;
  return (
    <span className="num" title={formatFull(value, unit)}>
      {formatPrice(value)}
    </span>
  );
}

export function Qty({ value, unit }: { value: number | null; unit: string }) {
  return <Price value={value} unit={unit} />;
}

export function SignedPct({ value, digits = 2, title }: { value: number | null; digits?: number; title?: string }) {
  if (value == null) return <Missing title={title} />;
  const text = digits >= 6 ? formatFunding(value) : formatPct(value, digits);
  return (
    <span className={`num ${tone(value)}`} title={title ? `${title} · ${text}` : text}>
      {text}
    </span>
  );
}

export function Compact({ value, unit }: { value: number | null; unit: string }) {
  if (value == null) return <Missing />;
  return (
    <span className="num" title={formatFull(value, unit)}>
      {formatCompact(value)}
    </span>
  );
}

export function SignedPrice({ value }: { value: number | null }) {
  if (value == null) return <Missing />;
  const text = `${value > 0 ? "+" : ""}${formatPrice(value)}`;
  return (
    <span className={`num ${tone(value)}`} title={formatFull(value, "USDC")}>
      {text}
    </span>
  );
}
