"use client";

import { memo, useMemo, useState } from "react";

import { Compact, Price, Qty, SignedPct, SignedPrice } from "@/components/numbers";
import { useFrozenOrder } from "@/components/use-frozen-order";
import { filterMarkets, sortMarkets, type SortDir, type SortKey } from "@/lib/market";
import type { Market, VenueId } from "@/lib/types";

type Column = { key: SortKey; label: string; title: string; width: number; sticky?: boolean };

// Fixed widths, shared by both venues, so RISEx and Txflow columns line up on screen.
const COLUMNS: Column[] = [
  { key: "base", label: "Símbolo", title: "Par cotizado en USDC", width: 128, sticky: true },
  { key: "last", label: "Último", title: "Último precio, USDC", width: 112 },
  { key: "mark", label: "Mark", title: "Mark price, USDC", width: 112 },
  { key: "index", label: "Índice", title: "Índice o oracle, USDC", width: 112 },
  { key: "changeAbs", label: "Δ 24h", title: "Cambio absoluto 24h, USDC", width: 112 },
  { key: "changePct", label: "Δ %", title: "Cambio 24h en porcentaje", width: 76 },
  { key: "high", label: "Máx", title: "Máximo 24h, USDC", width: 112 },
  { key: "low", label: "Mín", title: "Mínimo 24h, USDC", width: 112 },
  { key: "volumeUsdc", label: "Vol 24h", title: "Volumen nocional 24h, USDC", width: 84 },
  { key: "oiBase", label: "OI base", title: "Interés abierto en unidades del activo", width: 92 },
  { key: "oiUsdc", label: "OI USDC", title: "Interés abierto nocional: base × mark, USDC", width: 84 },
  { key: "fundingPct", label: "Funding", title: "Tasa del intervalo de funding, en porcentaje", width: 124 },
  { key: "funding8hPct", label: "8h", title: "Tasa de funding a 8 horas, en porcentaje", width: 104 },
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

const keyOfMarket = (market: Market) => `${market.venue}:${market.id}`;

const Row = memo(function Row({ market, columns, indexLabel }: { market: Market; columns: Column[]; indexLabel: string }) {
  return (
    <tr>
      {columns.map((column) => (
        <td key={column.key} className={column.sticky ? "sticky" : "right"}>
          <Cell column={column.key} market={market} indexLabel={indexLabel} />
        </td>
      ))}
    </tr>
  );
});

export const MarketsTable = memo(function MarketsTable({
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
  // Txflow does not publish an 8h rate: the column would be "—" on every row.
  const columns = useMemo(() => (venue === "txflow" ? COLUMNS.filter((column) => column.key !== "funding8hPct") : COLUMNS), [venue]);
  const filtered = useMemo(() => filterMarkets(markets, query), [markets, query]);
  const sorted = useMemo(() => {
    const ordered = sortMarkets(filtered, sort.key, sort.dir);
    return limit == null ? ordered : ordered.slice(0, limit);
  }, [filtered, sort, limit]);
  const { rows, frozen, bind } = useFrozenOrder(sorted, keyOfMarket);
  const total = filtered.length;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);

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
          {frozen ? " · orden en pausa" : ""}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{query.trim() ? "Sin mercados para ese filtro." : "Sin mercados activos."}</p>
      ) : (
        <div className={limit == null ? "table-scroll is-all" : "table-scroll"}>
          <table className="book-table" style={{ width: `${tableWidth}px` }}>
            <caption className="sr-only">
              {title}. Precios y volumen en USDC. OI base en unidades del activo. OI USDC es base por mark.
            </caption>
            <colgroup>
              {columns.map((column) => (
                <col key={column.key} style={{ width: `${column.width}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {columns.map((column) => {
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
            <tbody {...bind}>
              {rows.map((market) => (
                <Row key={keyOfMarket(market)} market={market} columns={columns} indexLabel={indexLabel} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});
