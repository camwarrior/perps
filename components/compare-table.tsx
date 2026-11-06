"use client";

import { useMemo, useState } from "react";

import { Compact, Missing, Price, SignedPct } from "@/components/numbers";
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

const COLUMNS: Array<{ key: CompareSortKey; label: string; group: string }> = [
  { key: "base", label: "Símbolo", group: "" },
  { key: "rxLast", label: "Último", group: "RISEx" },
  { key: "rxPct", label: "Δ %", group: "RISEx" },
  { key: "rxVol", label: "Vol", group: "RISEx" },
  { key: "rxOi", label: "OI", group: "RISEx" },
  { key: "rxFund", label: "Fund.", group: "RISEx" },
  { key: "txLast", label: "Último", group: "Txflow" },
  { key: "txPct", label: "Δ %", group: "Txflow" },
  { key: "txVol", label: "Vol", group: "Txflow" },
  { key: "txOi", label: "OI", group: "Txflow" },
  { key: "txFund", label: "Fund.", group: "Txflow" },
  { key: "spread", label: "Δ último", group: "" },
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

export function CompareTable({
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
  const rows = useMemo(() => {
    const filtered = filterCompare(compareRows(risex, txflow), query);
    const sorted = sortCompare(filtered, sort.key === "volume" ? "volume" : sort.key, sort.dir);
    return limit == null ? sorted : sorted.slice(0, limit);
  }, [risex, txflow, query, sort, limit]);
  const total = useMemo(() => filterCompare(compareRows(risex, txflow), query).length, [risex, txflow, query]);

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
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{query.trim() ? "Sin símbolos para ese filtro." : "Ningún símbolo en común."}</p>
      ) : (
        <div className={limit == null ? "table-scroll is-all" : "table-scroll"}>
          <table className="book-table">
            <caption className="sr-only">
              Comparación RISEx contra Txflow. Vol y OI en USDC. Δ último es Txflow menos RISEx, en porcentaje.
            </caption>
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
            <tbody>
              {rows.map((row) => (
                <tr key={row.base}>
                  {COLUMNS.map((column) => (
                    <td key={column.key} className={column.key === "base" ? "sticky" : "right"}>
                      {cell(row, column.key)}
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
