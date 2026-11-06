"use client";

import { memo, useMemo, useState } from "react";

import { Compact, Missing, Price, SignedPct } from "@/components/numbers";
import { useFrozenOrder } from "@/components/use-frozen-order";
import {
  compareRows,
  filterCompare,
  lastSpreadPct,
  sortCompare,
  type CompareRow,
  type CompareSortKey,
  type SortDir,
} from "@/lib/market";
import type { Market } from "@/lib/types";

const COLUMNS: Array<{ key: CompareSortKey; label: string; group: string; width: number }> = [
  { key: "base", label: "Símbolo", group: "", width: 104 },
  { key: "rxLast", label: "Último", group: "RISEx", width: 112 },
  { key: "rxPct", label: "Δ %", group: "RISEx", width: 76 },
  { key: "rxVol", label: "Vol", group: "RISEx", width: 84 },
  { key: "rxOi", label: "OI", group: "RISEx", width: 84 },
  { key: "rxFund", label: "Fund.", group: "RISEx", width: 124 },
  { key: "txLast", label: "Último", group: "Txflow", width: 112 },
  { key: "txPct", label: "Δ %", group: "Txflow", width: 76 },
  { key: "txVol", label: "Vol", group: "Txflow", width: 84 },
  { key: "txOi", label: "OI", group: "Txflow", width: 84 },
  { key: "txFund", label: "Fund.", group: "Txflow", width: 124 },
  { key: "spread", label: "Δ último", group: "", width: 104 },
];

function Side({
  market,
  field,
}: {
  market: Market | null;
  field: "last" | "pct" | "vol" | "oi" | "fund";
}) {
  if (!market) return <Missing />;
  if (field === "last") return <Price value={market.last} />;
  if (field === "pct") return <SignedPct value={market.changePct} />;
  if (field === "vol") return <Compact value={market.volumeUsdc} unit="USDC" />;
  if (field === "oi") return <Compact value={market.oiUsdc} unit="USDC" />;
  return (
    <span className="fund">
      <SignedPct value={market.fundingPct} digits={6} title="Funding del intervalo, en %" />
      {market.fundingInterval ? <span className="interval">{market.fundingInterval}</span> : null}
    </span>
  );
}

function cell(row: CompareRow, key: CompareSortKey) {
  switch (key) {
    case "base":
      return <span className="sym">{row.base}</span>;
    case "rxLast":
      return <Side market={row.risex} field="last" />;
    case "rxPct":
      return <Side market={row.risex} field="pct" />;
    case "rxVol":
      return <Side market={row.risex} field="vol" />;
    case "rxOi":
      return <Side market={row.risex} field="oi" />;
    case "rxFund":
      return <Side market={row.risex} field="fund" />;
    case "txLast":
      return <Side market={row.txflow} field="last" />;
    case "txPct":
      return <Side market={row.txflow} field="pct" />;
    case "txVol":
      return <Side market={row.txflow} field="vol" />;
    case "txOi":
      return <Side market={row.txflow} field="oi" />;
    case "txFund":
      return <Side market={row.txflow} field="fund" />;
    case "spread": {
      const spread = lastSpreadPct(row.risex?.last ?? null, row.txflow?.last ?? null);
      return <SignedPct value={spread} digits={4} title="Txflow menos RISEx, en % sobre el último de RISEx" />;
    }
    default:
      return null;
  }
}

const keyOfRow = (row: CompareRow) => row.base;
const TABLE_WIDTH = COLUMNS.reduce((sum, column) => sum + column.width, 0);

const Row = memo(function Row({ row }: { row: CompareRow }) {
  return (
    <tr>
      {COLUMNS.map((column) => (
        <td key={column.key} className={column.key === "base" ? "sticky" : "right"}>
          {cell(row, column.key)}
        </td>
      ))}
    </tr>
  );
}, (prev, next) => prev.row.risex === next.row.risex && prev.row.txflow === next.row.txflow);

export const CompareTable = memo(function CompareTable({
  risex,
  txflow,
  limit,
  query,
}: {
  risex: Market[];
  txflow: Market[];
  limit: number | null;
  query: string;
}) {
  const [sort, setSort] = useState<{ key: CompareSortKey; dir: SortDir }>({ key: "volume", dir: "desc" });
  const filtered = useMemo(() => filterCompare(compareRows(risex, txflow), query), [risex, txflow, query]);
  const sorted = useMemo(() => {
    const ordered = sortCompare(filtered, sort.key === "volume" ? "volume" : sort.key, sort.dir);
    return limit == null ? ordered : ordered.slice(0, limit);
  }, [filtered, sort, limit]);
  const { rows, frozen, bind } = useFrozenOrder(sorted, keyOfRow);
  const total = filtered.length;

  const onSort = (key: CompareSortKey) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: key === "base" ? "asc" : "desc" };
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  return (
    <section className="book" aria-label="Comparación">
      <div className="book-head">
        <h3>Mismo símbolo</h3>
        <p className="book-meta">
          {rows.length} de {total}
          {frozen ? " · orden en pausa" : ""}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{query.trim() ? "Sin símbolos para ese filtro." : "Ningún símbolo en común."}</p>
      ) : (
        <div className={limit == null ? "table-scroll is-all" : "table-scroll"}>
          <table className="book-table" style={{ width: `${TABLE_WIDTH}px` }}>
            <caption className="sr-only">
              Comparación RISEx contra Txflow. Vol y OI en USDC. Δ último es Txflow menos RISEx, en porcentaje.
            </caption>
            <colgroup>
              {COLUMNS.map((column) => (
                <col key={column.key} style={{ width: `${column.width}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map((column) => {
                  const active = sort.key === column.key;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                      className={column.key === "base" ? "sticky" : undefined}
                    >
                      <button type="button" onClick={() => onSort(column.key)} title={column.group ? `${column.group} ${column.label}` : column.label}>
                        {column.group ? <span className="col-group">{column.group}</span> : null}
                        <span>{column.label}</span>
                        {active ? <i className={`sort-ind ${sort.dir}`} aria-hidden="true" /> : null}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody {...bind}>
              {rows.map((row) => (
                <Row key={row.base} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});
