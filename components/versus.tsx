"use client";

import { memo } from "react";

import { Missing } from "@/components/numbers";
import { formatCompact, formatFull } from "@/lib/format";
import { useNow } from "@/lib/now";
import { coverage, sharePct } from "@/lib/market";
import { formatAgo, formatSantiago } from "@/lib/time";
import type { VenueBook } from "@/lib/types";

export type StreamStatus = "connecting" | "live" | "down" | "paused";

const STREAM_LABEL: Record<StreamStatus, string> = {
  live: "en vivo",
  connecting: "conectando",
  down: "cada 10 s",
  paused: "en pausa",
};

const STREAM_TITLE: Record<StreamStatus, string> = {
  live: "Websocket abierto: el mark se actualiza entre sondeos.",
  connecting: "Abriendo el websocket. Mientras tanto, sondeo cada 10 segundos.",
  down: "Websocket no disponible. El libro se actualiza por sondeo cada 10 segundos.",
  paused: "Pestaña oculta. El refresco vuelve al regresar.",
};

function Ago({ from }: { from: number }) {
  const now = useNow();
  return <>{formatAgo(from, now)}</>;
}

function VenueId({ book, status, side }: { book: VenueBook; status: StreamStatus; side: "left" | "right" }) {
  const covered = coverage(book.markets);
  const stamp = book.fetchedAt == null ? null : formatSantiago(book.fetchedAt);
  const cache = book.exchangeTime == null ? null : formatSantiago(book.exchangeTime);
  const source = [book.source, stamp, cache ? `cache ${cache}` : null].filter(Boolean).join(", ");
  const swatch = <span className={`swatch ${book.id === "risex" ? "rx" : "tx"}`} aria-hidden="true" />;
  const partialOi = book.ok && covered.oi < book.markets.length;

  return (
    <div className={side === "right" ? "venue-id right" : "venue-id"}>
      <h2 className="venue-name">
        {side === "left" ? swatch : null}
        {book.label}
        {side === "right" ? swatch : null}
      </h2>
      {book.ok ? (
        <p className="venue-meta" title={`${STREAM_TITLE[status]} Fuente: ${source}.`}>
          {book.totals.activeMarkets ?? "—"} mercados, {STREAM_LABEL[status]}
          {partialOi ? `, OI en ${covered.oi} de ${book.markets.length}` : null}
          {book.fetchedAt != null ? (
            <>
              , <Ago from={book.fetchedAt} />
            </>
          ) : null}
        </p>
      ) : (
        <p className="venue-error" role="alert">
          {book.error ?? "Sin respuesta del venue."}
        </p>
      )}
    </div>
  );
}

function Value({ value, side, unit }: { value: number | null; side: "left" | "right"; unit: string }) {
  return (
    <p className={side === "right" ? "vs-value right" : "vs-value"}>
      {value == null ? <Missing /> : <span title={formatFull(value, unit)}>{formatCompact(value)}</span>}
    </p>
  );
}

function pctLabel(value: number | null): string {
  return value == null ? "" : `${value.toFixed(1).replace(".", ",")} %`;
}

function Row({ name, left, right, unit }: { name: string; left: number | null; right: number | null; unit: string }) {
  const share = sharePct(left, right);
  return (
    <div className="vs-row">
      <Value value={left} side="left" unit={unit} />
      <div className="vs-mid">
        <p className="vs-labels">
          <span>{pctLabel(share)}</span>
          <span className="metric-name">{name}</span>
          <span>{share == null ? "" : pctLabel(100 - share)}</span>
        </p>
        {share == null ? (
          <div className="vs-bar empty" aria-hidden="true" />
        ) : (
          <div
            className="vs-bar"
            role="img"
            aria-label={`${name}: RISEx ${pctLabel(share)}, Txflow ${pctLabel(100 - share)}`}
          >
            <div className="rx" style={{ width: `${share}%` }} />
            <div className="tx" />
          </div>
        )}
      </div>
      <Value value={right} side="right" unit={unit} />
    </div>
  );
}

/** RISEx against Txflow: one split bar per metric. The page's single loud element. */
export const Versus = memo(function Versus({
  risex,
  txflow,
  risexStream,
  txflowStream,
  paused,
}: {
  risex: VenueBook;
  txflow: VenueBook;
  risexStream: StreamStatus;
  txflowStream: StreamStatus;
  paused: boolean;
}) {
  return (
    <section className="versus" aria-label="RISEx contra Txflow">
      <div className="versus-head">
        <VenueId book={risex} status={paused ? "paused" : risexStream} side="left" />
        <VenueId book={txflow} status={paused ? "paused" : txflowStream} side="right" />
      </div>
      <Row
        name="Volumen 24 h, USDC"
        left={risex.ok ? risex.totals.volume24hUsdc : null}
        right={txflow.ok ? txflow.totals.volume24hUsdc : null}
        unit="USDC"
      />
      <Row
        name="Interés abierto, USDC"
        left={risex.ok ? risex.totals.openInterestUsdc : null}
        right={txflow.ok ? txflow.totals.openInterestUsdc : null}
        unit="USDC"
      />
    </section>
  );
});
