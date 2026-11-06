"use client";

import { memo, useMemo, useState } from "react";

import { Compact, Missing, Price, SignedPct } from "@/components/numbers";
import { useFrozenOrder } from "@/components/use-frozen-order";
import { formatPct } from "@/lib/format";
import {
  compareRows,
  filterCompare,
  fundingAprPct,
  lastSpreadPct,
  sharePct,
  sortCompare,
  type CompareRow,
  type CompareSortKey,
  type SortDir,
} from "@/lib/market";
import type { Market } from "@/lib/types";

type Venue = "rx" | "tx";
type Column = { key: CompareSortKey | "share"; label: string; venue?: Venue; width: number; sort?: CompareSortKey; title: string };

const COLUMNS: Column[] = [
  { key: "base", label: "Símbolo", width: 104, sort: "base", title: "Activo base" },
  { key: "rxLast", label: "RISEx", venue: "rx", width: 116, sort: "rxLast", title: "Último de RISEx, USDC" },
  { key: "txLast", label: "Txflow", venue: "tx", width: 116, sort: "txLast", title: "Último de Txflow, USDC" },
  { key: "spread", label: "Diferencia", width: 100, sort: "spread", title: "Txflow menos RISEx, en % del último de RISEx" },
  { key: "rxPct", label: "RISEx", venue: "rx", width: 96, sort: "rxPct", title: "Cambio 24 h en RISEx" },
  { key: "txPct", label: "Txflow", venue: "tx", width: 88, sort: "txPct", title: "Cambio 24 h en Txflow" },
  { key: "share", label: "Reparto", width: 300, sort: "volume", title: "Volumen 24 h de cada venue y su parte del total del símbolo" },
  { key: "rxFund", label: "RISEx", venue: "rx", width: 96, sort: "rxFund", title: "Funding de RISEx llevado a un año" },
  { key: "txFund", label: "Txflow", venue: "tx", width: 88, sort: "txFund", title: "Funding de Txflow llevado a un año" },
];

const GROUPS: Array<{ label: string; span: number; center?: boolean }> = [
  { label: "", span: 1 },
  { label: "Último precio", span: 3 },
  { label: "Cambio 24 h", span: 2 },
  { label: "Volumen 24 h", span: 1, center: true },
  { label: "Funding, APR", span: 2 },
];

const TABLE_WIDTH = COLUMNS.reduce((sum, column) => sum + column.width, 0);

function Apr({ market }: { market: Market | null }) {
  if (!market) return <Missing title="No listado en este venue" />;
  const apr = fundingAprPct(market.fundingPct, market.fundingInterval);
  if (apr == null) return <Missing title="Sin funding o sin intervalo" />;
  return <span className={`num ${apr > 0 ? "up" : apr < 0 ? "down" : "flat"}`}>{formatPct(apr, 1)}</span>;
}

function Share({ row }: { row: CompareRow }) {
  const left = row.risex?.volumeUsdc ?? null;
  const right = row.txflow?.volumeUsdc ?? null;
  const share = sharePct(left, right);
  return (
    <span className="share">
      <Compact value={left} unit="USDC" />
      {share == null ? (
        <span className="share-bar empty" aria-hidden="true" />
      ) : (
        <span className="share-bar" role="img" aria-label={`RISEx ${share.toFixed(0)} %, Txflow ${(100 - share).toFixed(0)} %`}>
          <span className="rx" style={{ width: `${share}%` }} />
          <span className="tx" />
        </span>
      )}
      <Compact value={right} unit="USDC" />
    </span>
  );
}

const Row = memo(
  function Row({ row }: { row: CompareRow }) {
    const spread = lastSpreadPct(row.risex?.last ?? null, row.txflow?.last ?? null);
    return (
      <tr>
        <td className="sticky left">
          <span className="sym">{row.base}</span>
        </td>
        <td>{row.risex ? <Price value={row.risex.last} /> : <Missing />}</td>
        <td>{row.txflow ? <Price value={row.txflow.last} /> : <Missing />}</td>
        <td className="muted">
          {spread == null ? <Missing /> : <span className="num" title="Txflow menos RISEx">{formatPct(spread, 3)}</span>}
        </td>
        <td>
          <SignedPct value={row.risex?.changePct ?? null} />
        </td>
        <td>
          <SignedPct value={row.txflow?.changePct ?? null} />
        </td>
        <td>
          <Share row={row} />
        </td>
        <td>
          <Apr market={row.risex} />
        </td>
        <td>
          <Apr market={row.txflow} />
        </td>
      </tr>
    );
  },
  (prev, next) => prev.row.risex === next.row.risex && prev.row.txflow === next.row.txflow,
);

const keyOfRow = (row: CompareRow) => row.base;

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
    const ordered = sortCompare(filtered, sort.key, sort.dir);
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
    <section aria-label="Mismo símbolo en los dos venues">
      <div className="panel-head">
        <h2>Mismo símbolo en los dos venues</h2>
        <p className="panel-meta">
          {rows.length} de {total} símbolos
          {frozen ? ", orden en pausa mientras el mouse está encima" : ""}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{query.trim() ? "Ningún símbolo coincide con esa búsqueda." : "No hay símbolos listados en ambos venues."}</p>
      ) : (
        <div className={limit == null ? "table-scroll is-all" : "table-scroll"}>
          <table className="book-table" style={{ width: "100%", minWidth: `${TABLE_WIDTH}px` }}>
            <caption className="sr-only">
              RISEx contra Txflow. Volumen en USDC. Diferencia es Txflow menos RISEx, en porcentaje.
            </caption>
            <colgroup>
              {COLUMNS.map((column) => (
                <col key={column.key} style={{ width: `${column.width}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr className="groups">
                {GROUPS.map((group, index) => (
                  <th
                    key={index}
                    scope={group.label ? "colgroup" : undefined}
                    colSpan={group.span}
                    className={index === 0 ? "sticky" : group.center ? "center" : undefined}
                  >
                    <span>{group.label}</span>
                  </th>
                ))}
              </tr>
              <tr>
                {COLUMNS.map((column) => {
                  const active = column.sort === sort.key;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                      className={column.key === "base" ? "sticky" : column.key === "share" ? "center" : undefined}
                      title={column.title}
                    >
                      <button type="button" onClick={() => onSort(column.sort as CompareSortKey)}>
                        {column.venue ? <span className={`swatch sm ${column.venue}`} aria-hidden="true" /> : null}
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
