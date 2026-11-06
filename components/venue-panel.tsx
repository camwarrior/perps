import { Compact } from "@/components/numbers";
import { coverage } from "@/lib/market";
import { formatAgo, formatSantiago } from "@/lib/time";
import type { VenueBook } from "@/lib/types";

type StreamStatus = "connecting" | "live" | "down" | "paused";

export function VenuePanel({
  book,
  stream,
  now,
  paused,
}: {
  book: VenueBook;
  stream: StreamStatus;
  now: number;
  paused: boolean;
}) {
  const age = book.fetchedAt == null ? null : formatAgo(book.fetchedAt, now);
  const stamp = book.fetchedAt == null ? null : formatSantiago(book.fetchedAt);
  const cache = book.exchangeTime == null ? null : formatSantiago(book.exchangeTime);
  const covered = coverage(book.markets);
  const streamLabel =
    stream === "live" ? "mark vivo" : stream === "connecting" ? "ws…" : stream === "paused" || paused ? "pausa" : "REST";

  return (
    <article className="venue" data-state={book.ok ? "ok" : "error"} aria-label={book.label}>
      <header className="venue-head">
        <h2>{book.label}</h2>
        <span className={`tag ${book.ok ? "ok" : "bad"}`}>{book.ok ? streamLabel : "error"}</span>
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
      <p className="src">
        <span className="src-label">Fuente</span> {book.source}
        {stamp ? <span> · {stamp}</span> : null}
        {age ? <span> · {age}</span> : null}
        {cache ? <span title="cached_at publicado por RISEx"> · cache {cache}</span> : null}
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
}
