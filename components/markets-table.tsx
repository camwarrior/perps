"use client";

import { memo, useMemo, useState } from "react";

import { LiveCell } from "@/components/live-cell";
import { Compact, Missing, Price, Qty, SignedPct } from "@/components/numbers";
import { useFrozenOrder } from "@/components/use-frozen-order";
import { formatFull, formatPct, formatPrice } from "@/lib/format";
import { filterMarkets, fundingAprPct, sortMarkets, type SortDir, type SortKey } from "@/lib/market";
import type { Market, VenueId } from "@/lib/types";

type ColumnKey = "base" | "last" | "mark" | "changePct" | "range" | "volumeUsdc" | "oiUsdc" | "oiBase" | "fundingPct" | "apr";

type Column = {
  key: ColumnKey;
  label: string;
  title: string;
  width: number;
  /** Sort key; columns without one are not sortable. */
  sort?: SortKey;
  align?: "left" | "right";
};

// Fixed widths shared by both venues, so switching venue keeps every column in place.
const COLUMNS: Column[] = [
  { key: "base", label: "Símbolo", title: "Par cotizado en USDC", width: 136, sort: "base", align: "left" },
  { key: "last", label: "Último", title: "Último precio, USDC", width: 116, sort: "last" },
  { key: "mark", label: "Mark", title: "Mark price, USDC. El índice u oracle aparece al pasar el mouse.", width: 116, sort: "mark" },
  { key: "changePct", label: "24 h", title: "Cambio en 24 horas", width: 84, sort: "changePct" },
  { key: "range", label: "Rango 24 h", title: "Mínimo, precio actual y máximo de 24 horas", width: 264, align: "left" },
  { key: "volumeUsdc", label: "Volumen", title: "Volumen nocional 24 h, USDC", width: 96, sort: "volumeUsdc" },
  { key: "oiUsdc", label: "OI USDC", title: "Interés abierto nocional: base × mark", width: 96, sort: "oiUsdc" },
  { key: "oiBase", label: "OI base", title: "Interés abierto en unidades del activo", width: 96, sort: "oiBase" },
  { key: "fundingPct", label: "Funding", title: "Tasa del intervalo de funding, en %", width: 128 },
  { key: "apr", label: "APR", title: "Funding del intervalo llevado a un año, simple", width: 88, sort: "fundingPct" },
];

const TABLE_WIDTH = COLUMNS.reduce((sum, column) => sum + column.width, 0);

function Range({ market }: { market: Market }) {
  const { low, high } = market;
  const now = market.last ?? market.mark;
  if (low == null || high == null || now == null || high <= low) return <Missing />;
  const position = Math.min(100, Math.max(0, ((now - low) / (high - low)) * 100));
  return (
    <span className="range" title={`Mín ${formatFull(low, "USDC")}, máx ${formatFull(high, "USDC")}`}>
      <span className="lo">{formatPrice(low)}</span>
      <span className="range-track" aria-hidden="true">
        <span className="range-mark" style={{ left: `${position}%` }} />
      </span>
      <span className="hi">{formatPrice(high)}</span>
    </span>
  );
}

const Row = memo(function Row({ market, indexLabel }: { market: Market; indexLabel: string }) {
  const apr = fundingAprPct(market.fundingPct, market.fundingInterval);
  const indexTitle = market.index == null ? `${indexLabel}: dato no disponible` : `${indexLabel}: ${formatFull(market.index, "USDC")}`;
  return (
    <tr>
      <td className="sticky left c-base">
        <span className="sym">{market.base}</span>
        <span className="quote">{market.symbol.slice(market.base.length)}</span>
      </td>
      <LiveCell value={market.last} className="c-last">
        <Price value={market.last} />
      </LiveCell>
      <LiveCell value={market.mark} className="muted c-extra">
        <span title={indexTitle}>
          <Price value={market.mark} />
        </span>
      </LiveCell>
      <td className="c-pct">
        <SignedPct value={market.changePct} title="Cambio 24 h" />
      </td>
      <td className="left c-extra">
        <Range market={market} />
      </td>
      <td className="c-vol" data-label="Vol">
        <Compact value={market.volumeUsdc} unit="USDC" />
      </td>
      <td className="c-oi" data-label="OI">
        <Compact value={market.oiUsdc} unit="USDC" />
      </td>
      <td className="muted c-extra">
        <Qty value={market.oiBase} unit={market.base} />
      </td>
      <td className="muted c-extra">
        <span className="fund">
          <SignedPct
            value={market.fundingPct}
            digits={6}
            title={
              market.venue === "risex"
                ? "Tasa del intervalo. RISEx entrega una fracción; se muestra × 100, en %."
                : "Tasa del intervalo de liquidación, en %."
            }
          />
          {market.fundingInterval ? <span className="interval">{market.fundingInterval}</span> : null}
        </span>
      </td>
      <td className="c-extra">
        {apr == null ? (
          <Missing title="Sin intervalo de funding: no se anualiza." />
        ) : (
          <span className={`num ${apr > 0 ? "up" : apr < 0 ? "down" : "flat"}`} title={market.funding8hPct != null ? `8 h publicada: ${formatPct(market.funding8hPct, 6)}` : undefined}>
            {formatPct(apr, 1)}
          </span>
        )}
      </td>
    </tr>
  );
});

const keyOfMarket = (market: Market) => `${market.venue}:${market.id}`;

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
  const filtered = useMemo(() => filterMarkets(markets, query), [markets, query]);
  const sorted = useMemo(() => {
    const ordered = sortMarkets(filtered, sort.key, sort.dir);
    return limit == null ? ordered : ordered.slice(0, limit);
  }, [filtered, sort, limit]);
  const { rows, frozen, bind } = useFrozenOrder(sorted, keyOfMarket);
  const total = filtered.length;

  const onSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: key === "base" ? "asc" : "desc" };
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  return (
    <section aria-label={title}>
      <div className="panel-head">
        <h2>
          <span className={`swatch sm ${venue === "risex" ? "rx" : "tx"}`} aria-hidden="true" /> {title}
        </h2>
        <p className="panel-meta">
          {rows.length} de {total} mercados
          {frozen ? ", orden en pausa mientras el mouse está encima" : ""}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{query.trim() ? "Ningún mercado coincide con ese símbolo." : "Este venue no tiene mercados activos."}</p>
      ) : (
        <div className={limit == null ? "table-scroll as-list is-all" : "table-scroll as-list"}>
          <table className="book-table" style={{ width: "100%", minWidth: `${TABLE_WIDTH}px` }}>
            <caption className="sr-only">
              {title}. Precios y volumen en USDC. OI base en unidades del activo. OI USDC es base por mark.
            </caption>
            <colgroup>
              {COLUMNS.map((column) => (
                <col key={column.key} style={{ width: `${column.width}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map((column) => {
                  const active = column.sort != null && sort.key === column.sort && column.key !== "fundingPct";
                  const className = [column.key === "base" ? "sticky" : "", column.align === "left" ? "left" : ""].filter(Boolean).join(" ");
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                      className={className || undefined}
                      title={column.title}
                    >
                      {column.sort ? (
                        <button type="button" onClick={() => onSort(column.sort as SortKey)}>
                          <span>{column.label}</span>
                          {active ? <i className={`sort-ind ${sort.dir}`} aria-hidden="true" /> : null}
                        </button>
                      ) : (
                        <span>{column.label}</span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody {...bind}>
              {rows.map((market) => (
                <Row key={keyOfMarket(market)} market={market} indexLabel={indexLabel} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});
