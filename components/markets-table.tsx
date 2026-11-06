"use client";

import { useMemo, useState } from "react";

import { Compact, Price, Qty, SignedPct, SignedPrice } from "@/components/numbers";
import { filterMarkets, sortMarkets, type SortDir, type SortKey } from "@/lib/market";
import type { Market, VenueId } from "@/lib/types";

const COLUMNS: Array<{ key: SortKey; label: string; title: string; sticky?: boolean }> = [
  { key: "base", label: "Símbolo", title: "Par cotizado en USDC", sticky: true },
  { key: "last", label: "Último", title: "Último precio, USDC" },
  { key: "mark", label: "Mark", title: "Mark price, USDC" },
  { key: "index", label: "Índice", title: "Índice o oracle, USDC" },
  { key: "changeAbs", label: "Δ 24h", title: "Cambio absoluto 24h, USDC" },
  { key: "changePct", label: "Δ %", title: "Cambio 24h en porcentaje" },
  { key: "high", label: "Máx", title: "Máximo 24h, USDC" },
  { key: "low", label: "Mín", title: "Mínimo 24h, USDC" },
  { key: "volumeUsdc", label: "Vol 24h", title: "Volumen nocional 24h, USDC" },
  { key: "oiBase", label: "OI base", title: "Interés abierto en unidades del activo" },
  { key: "oiUsdc", label: "OI USDC", title: "Interés abierto nocional: base × mark, USDC" },
  { key: "fundingPct", label: "Funding", title: "Tasa del intervalo de funding, en porcentaje" },
  { key: "funding8hPct", label: "8h", title: "Tasa de funding a 8 horas, en porcentaje" },
];

function Cell({ column, market, indexLabel }: { column: SortKey; market: Market; indexLabel: string }) {
  switch (column) {
    case "base":
      return (
        <span className="sym" title={market.symbol}>
          {market.symbol}
        </span>
      );
    case "last":
      return <Price value={market.last} />;
    case "mark":
      return <Price value={market.mark} />;
    case "index":
      return <Price value={market.index} unit={indexLabel === "Oracle" ? "USDC oracle" : "USDC índice"} />;
    case "changeAbs":
      return <SignedPrice value={market.changeAbs} />;
    case "changePct":
      return <SignedPct value={market.changePct} title="Cambio 24h" />;
    case "high":
      return <Price value={market.high} />;
    case "low":
      return <Price value={market.low} />;
    case "volumeUsdc":
      return <Compact value={market.volumeUsdc} unit="USDC" />;
    case "oiBase":
      return <Qty value={market.oiBase} unit={market.base} />;
    case "oiUsdc":
      return <Compact value={market.oiUsdc} unit="USDC" />;
    case "fundingPct":
      return (
        <span className="fund">
          <SignedPct
            value={market.fundingPct}
            digits={6}
            title={
              market.venue === "risex"
                ? "Tasa del intervalo. RISEx entrega una fracción; se muestra × 100, en %."
                : "Tasa del intervalo de liquidación, en %. No es una tasa 8h."
            }
          />
          {market.fundingInterval ? <span className="interval">{market.fundingInterval}</span> : null}
        </span>
      );
    case "funding8hPct":
      return (
        <SignedPct
          value={market.funding8hPct}
          digits={6}
          title={
            market.venue === "txflow"
              ? "Txflow no publica tasa 8h. dato no disponible"
              : "Tasa 8h publicada por RISEx, en %."
          }
        />
      );
    default:
      return null;
  }
}

export function MarketsTable({
  title,
  markets,
  indexLabel,
  limit,
  query,
  venue,
}: {
  title: string;
  markets: Market[];
  indexLabel: string;
  limit: number | null;
  query: string;
  venue: VenueId;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "volumeUsdc", dir: "desc" });
  const rows = useMemo(() => {
    const filtered = filterMarkets(markets, query);
    const sorted = sortMarkets(filtered, sort.key, sort.dir);
    return limit == null ? sorted : sorted.slice(0, limit);
  }, [markets, query, sort, limit]);
  const total = useMemo(() => filterMarkets(markets, query).length, [markets, query]);

  const onSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: key === "base" ? "asc" : "desc" };
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  return (
    <section className="book" aria-label={title}>
      <div className="book-head">
        <h3>{title}</h3>
        <p className="book-meta">
          {rows.length} de {total}
          {limit != null && total > limit ? " · top por el orden actual" : ""}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{query.trim() ? "Sin mercados para ese filtro." : "Sin mercados activos."}</p>
      ) : (
        <div className={limit == null ? "table-scroll is-all" : "table-scroll"}>
          <table className="book-table">
            <caption className="sr-only">
              {title}. Precios y volumen en USDC. OI base en unidades del activo. OI USDC es base por mark.
            </caption>
            <thead>
              <tr>
                {COLUMNS.map((column) => {
                  const label = column.key === "index" ? indexLabel : column.label;
                  const active = sort.key === column.key;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                      className={column.sticky ? "sticky" : undefined}
                    >
                      <button type="button" onClick={() => onSort(column.key)} title={column.title}>
                        <span>{label}</span>
                        {active ? <i className={`sort-ind ${sort.dir}`} aria-hidden="true" /> : null}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((market) => (
                <tr key={`${venue}:${market.id}`}>
                  {COLUMNS.map((column) => (
                    <td key={column.key} className={column.sticky ? "sticky" : column.key === "base" ? undefined : "right"}>
                      <Cell column={column.key} market={market} indexLabel={indexLabel} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
