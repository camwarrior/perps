"use client";

import { useEffect, useMemo, useState } from "react";

import { CompareTable } from "@/components/compare-table";
import { MarketsTable } from "@/components/markets-table";
import { VenuePanel } from "@/components/venue-panel";
import { VenueCharts } from "@/components/venue-charts";
import { WalletWeek } from "@/components/wallet-week";
import { useQuoteStream, useTickerBackfill } from "@/components/use-live";
import { compareRows, decorateBook, filterCompare, filterMarkets, sortCompare, sortMarkets } from "@/lib/market";
import { formatAgo, formatSantiago } from "@/lib/time";
import type { Snapshot } from "@/lib/types";

const TOP = 15;

export function Terminal({ initial }: { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [appliedAt, setAppliedAt] = useState(initial.generatedAt);
  const [now, setNow] = useState(initial.generatedAt);
  const [paused, setPaused] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [view, setView] = useState<"book" | "compare">("book");
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const streams = useQuoteStream(!paused);

  const backfillIds = useMemo(() => {
    if (paused || streams.txflow === "live" || !snapshot.venues.txflow.ok) return [];
    const limit = showAll ? null : TOP;
    if (view === "compare") {
      if (!snapshot.venues.risex.ok) return [];
      const rows = sortCompare(
        filterCompare(compareRows(snapshot.venues.risex.markets, snapshot.venues.txflow.markets), query),
        "volume",
        "desc",
      );
      const shown = limit == null ? rows : rows.slice(0, limit);
      return shown
        .filter((row) => row.txflow && row.txflow.mark == null && row.txflow.index == null && row.txflow.oiBase == null)
        .map((row) => row.txflow?.id)
        .filter((id): id is string => Boolean(id));
    }
    const rows = sortMarkets(filterMarkets(snapshot.venues.txflow.markets, query), "volumeUsdc", "desc");
    const shown = limit == null ? rows : rows.slice(0, limit);
    return shown.filter((market) => market.mark == null && market.index == null && market.oiBase == null).map((market) => market.id);
  }, [paused, streams.txflow, snapshot, view, showAll, query]);

  const gaps = useTickerBackfill(backfillIds, backfillIds.length > 0);
  const risex = useMemo(
    () => decorateBook(snapshot.venues.risex, streams.overrides, gaps, appliedAt),
    [snapshot, streams.overrides, gaps, appliedAt],
  );
  const txflow = useMemo(
    () => decorateBook(snapshot.venues.txflow, streams.overrides, gaps, appliedAt),
    [snapshot, streams.overrides, gaps, appliedAt],
  );
  const limit = showAll ? null : TOP;
  const live = !paused && (risex.ok || txflow.ok);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    let cancel = false;

    const pull = async () => {
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as Snapshot;
        if (cancel) return;
        if (!data?.venues?.risex || !data?.venues?.txflow) throw new Error("payload");
        setSnapshot(data);
        setAppliedAt(Date.now());
        setPollError(null);
      } catch {
        if (!cancel) setPollError("Refresco falló. Se reintenta. El último libro sigue en pantalla.");
      }
    };

    const arm = () => {
      timer = window.setTimeout(async () => {
        if (!document.hidden) await pull();
        if (!cancel && !document.hidden) arm();
      }, 10_000);
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (timer) window.clearTimeout(timer);
        timer = null;
        setPaused(true);
        return;
      }
      setPaused(false);
      void pull();
      arm();
    };

    arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancel = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className="terminal">
      <header className="top">
        <div className="brand">
          <h1 className="brand-mark">PERPS</h1>
          <p className="brand-sub">RISEx / Txflow</p>
        </div>
        <p className="top-meta">
          <time dateTime={new Date(now).toISOString()}>{formatSantiago(now)}</time>
          <span className={live ? "pulse" : "pulse off"} aria-hidden="true" />
          <span>libro {formatAgo(snapshot.generatedAt, now)}</span>
          {paused ? <span className="pause">pausa</span> : null}
        </p>
      </header>

      <section className="venues">
        <VenuePanel book={risex} stream={streams.risex} now={now} paused={paused} />
        <VenuePanel book={txflow} stream={streams.txflow} now={now} paused={paused} />
      </section>

      <VenueCharts />

      <WalletWeek now={now} />

      {pollError ? (
        <p className="banner" role="status">
          {pollError}
        </p>
      ) : null}

      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Vista">
          <button type="button" role="tab" aria-selected={view === "book"} onClick={() => setView("book")}>
            Libro
          </button>
          <button type="button" role="tab" aria-selected={view === "compare"} onClick={() => setView("compare")}>
            Comparar
          </button>
        </div>
        <div className="toolbar-right">
          <div className="segment" role="group" aria-label="Cantidad de mercados">
            <button type="button" aria-pressed={!showAll} onClick={() => setShowAll(false)}>
              15
            </button>
            <button type="button" aria-pressed={showAll} onClick={() => setShowAll(true)}>
              Todos
            </button>
          </div>
          <input
            className="filter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filtrar símbolo"
            placeholder="símbolo"
            spellCheck={false}
            autoCapitalize="characters"
          />
        </div>
      </div>
      <p className="units">
        Precios y volumen en USDC. OI base en unidades del activo. OI USDC = base × mark. Funding en % del intervalo.
      </p>

      {view === "book" ? (
        <>
          {risex.ok ? (
            <MarketsTable title="RISEx" venue="risex" markets={risex.markets} indexLabel="Índice" limit={limit} query={query} />
          ) : (
            <p className="empty">Sin libro de RISEx.</p>
          )}
          {txflow.ok ? (
            <MarketsTable title="Txflow" venue="txflow" markets={txflow.markets} indexLabel="Oracle" limit={limit} query={query} />
          ) : (
            <p className="empty">Sin libro de Txflow.</p>
          )}
        </>
      ) : risex.ok && txflow.ok ? (
        <CompareTable risex={risex.markets} txflow={txflow.markets} limit={limit} query={query} />
      ) : (
        <p className="empty">Comparación no disponible mientras un venue esté caído.</p>
      )}

      <p className="statusline">Mainnet · solo lectura · sin índice</p>
    </div>
  );
}
