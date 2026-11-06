import { memo } from "react";

import { Compact } from "@/components/numbers";
import { useNow } from "@/lib/now";
import { coverage } from "@/lib/market";
import { formatAgo, formatSantiago } from "@/lib/time";
import type { VenueBook } from "@/lib/types";

type StreamStatus = "connecting" | "live" | "down" | "paused";

const STREAM_LABEL: Record<StreamStatus, string> = {
  live: "En vivo",
  connecting: "Conectando",
  down: "Cada 10 s",
  paused: "En pausa",
};

const STREAM_TITLE: Record<StreamStatus, string> = {
  live: "Websocket abierto: el mark se actualiza entre sondeos.",
  connecting: "Abriendo el websocket. Mientras tanto, sondeo cada 10 segundos.",
  down: "Websocket no disponible. El libro se actualiza por sondeo cada 10 segundos.",
  paused: "Pestaña oculta. El refresco vuelve al regresar.",
};

/** Seconds since the venue answered. Lives apart so the panel does not re-render each second. */
function Ago({ from }: { from: number }) {
  const now = useNow();
  return <>{formatAgo(from, now)}</>;
}

export const VenuePanel = memo(function VenuePanel({
  book,
  stream,
  paused,
}: {
  book: VenueBook;
  stream: StreamStatus;
  paused: boolean;
}) {
  const stamp = book.fetchedAt == null ? null : formatSantiago(book.fetchedAt);
  const cache = book.exchangeTime == null ? null : formatSantiago(book.exchangeTime);
  const covered = coverage(book.markets);
  const status: StreamStatus = paused ? "paused" : stream;
  const sourceTitle = [book.source, stamp, cache ? `cache ${cache}` : null].filter(Boolean).join(" · ");
  const host = book.source.split(/\s+/)[0];

  return (
    <article className="venue" data-state={book.ok ? "ok" : "error"} aria-label={book.label}>
      <header className="venue-head">
        <h2>{book.label}</h2>
        <span className={`tag ${book.ok ? (status === "live" ? "ok" : "") : "bad"}`} title={book.ok ? STREAM_TITLE[status] : undefined}>
          {book.ok ? STREAM_LABEL[status] : "Error"}
        </span>
      </header>
      {book.ok ? (
        <dl className="metrics">
          <div className="metric">
            <dt>Vol 24h</dt>
            <dd>
              <Compact value={book.totals.volume24hUsdc} unit="USDC" />
              <small>USDC</small>
            </dd>
          </div>
          <div className="metric">
            <dt title="Interés abierto nocional: base × mark">OI</dt>
            <dd>
              <Compact value={book.totals.openInterestUsdc} unit="USDC" />
              <small>USDC</small>
            </dd>
          </div>
          <div className="metric">
            <dt>Mercados</dt>
            <dd>
              <span className="num" title="Mercados activos en el libro">
                {book.totals.activeMarkets ?? "—"}
              </span>
            </dd>
          </div>
        </dl>
      ) : (
        <p className="venue-error" role="alert">
          {book.error}
        </p>
      )}
      <p className="src" title={sourceTitle}>
        <span className="src-label">Fuente</span> {host}
        {book.fetchedAt != null ? (
          <span>
            {" · "}
            <Ago from={book.fetchedAt} />
          </span>
        ) : null}
      </p>
      {book.notes.map((note) => (
        <p className="note" key={note}>
          {note}
        </p>
      ))}
      {book.ok && covered.oi < book.markets.length ? (
        <p className="note">
          OI USDC en {covered.oi} de {book.markets.length}. Sin mark no se calcula.
        </p>
      ) : null}
    </article>
  );
});
