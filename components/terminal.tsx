"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { CompareTable } from "@/components/compare-table";
import { MarketsTable } from "@/components/markets-table";
import { prefetchCharts, VenueCharts } from "@/components/venue-charts";
import { Versus } from "@/components/versus";
import { WalletWeek } from "@/components/wallet-week";
import { useQuoteStream, useTickerBackfill } from "@/components/use-live";
import { NowProvider, useNow } from "@/lib/now";
import {
  carryDailyFields,
  compareRows,
  decorateBook,
  filterCompare,
  filterMarkets,
  sortCompare,
  sortMarkets,
  type DecorateCache,
} from "@/lib/market";
import { formatAgo, formatSantiagoClock } from "@/lib/time";
import type { Snapshot, VenueId } from "@/lib/types";

const TOP = 15;

type View = "book" | "compare" | "series" | "wallet";

const VIEWS: Array<{ id: View; label: string }> = [
  { id: "book", label: "Libro" },
  { id: "compare", label: "Comparar" },
  { id: "series", label: "Series" },
  { id: "wallet", label: "Wallet" },
];

/** The only part of the header that changes every second. */
function Clock({ generatedAt, live, paused }: { generatedAt: number; live: boolean; paused: boolean }) {
  const now = useNow();
  return (
    <p className="top-meta">
      <time dateTime={new Date(now).toISOString()}>{formatSantiagoClock(now)}</time>
      <span>Santiago</span>
      <span className={live ? "dot" : "dot off"} aria-hidden="true" />
      <span>{paused ? "En pausa" : `Libro de ${formatAgo(generatedAt, now)}`}</span>
    </p>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </svg>
  );
}

export function Terminal({ initial }: { initial: Snapshot }) {
  return (
    <NowProvider initial={initial.generatedAt}>
      <Book initial={initial} />
    </NowProvider>
  );
}

function Book({ initial }: { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [appliedAt, setAppliedAt] = useState(initial.generatedAt);
  const [paused, setPaused] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [view, setView] = useState<View>("book");
  const [venue, setVenue] = useState<VenueId>("risex");
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const streams = useQuoteStream(!paused);
  const [risexCache] = useState<DecorateCache>(() => new Map());
  const [txflowCache] = useState<DecorateCache>(() => new Map());
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
    // Txflow quotes are only needed when its book is the one on screen.
    if (view !== "book" || venue !== "txflow") return [];
    const rows = sortMarkets(filterMarkets(snapshot.venues.txflow.markets, query), "volumeUsdc", "desc");
    const shown = limit == null ? rows : rows.slice(0, limit);
    return shown.filter((market) => market.mark == null && market.index == null && market.oiBase == null).map((market) => market.id);
  }, [paused, streams.txflow, snapshot, view, venue, showAll, query]);

  const gaps = useTickerBackfill(backfillIds, backfillIds.length > 0);
  const risex = useMemo(
    () => decorateBook(snapshot.venues.risex, streams.overrides, gaps, appliedAt, risexCache),
    [snapshot, streams.overrides, gaps, appliedAt, risexCache],
  );
  const txflow = useMemo(
    () => decorateBook(snapshot.venues.txflow, streams.overrides, gaps, appliedAt, txflowCache),
    [snapshot, streams.overrides, gaps, appliedAt, txflowCache],
  );
  const limit = showAll ? null : TOP;
  const live = !paused && (risex.ok || txflow.ok);
  const shownBook = venue === "risex" ? risex : txflow;

  const newest = useRef(initial.generatedAt);
  useEffect(() => {
    let timer: number | null = null;
    let cancel = false;
    // Each arm() starts a new polling loop and retires the previous one. Without it, leaving the app
    // in the middle of a refresh and coming back could leave two loops running, doubling the requests.
    let generation = 0;

    const pull = async () => {
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as Snapshot;
        if (cancel) return;
        if (!data?.venues?.risex || !data?.venues?.txflow) throw new Error("payload");
        // A slow answer that arrives after a newer one is dropped instead of rolling the book back.
        if (data.generatedAt < newest.current) return;
        newest.current = data.generatedAt;
        setSnapshot((previous) => ({
          ...data,
          venues: {
            risex: carryDailyFields(data.venues.risex, previous.venues.risex),
            txflow: carryDailyFields(data.venues.txflow, previous.venues.txflow),
          },
        }));
        setAppliedAt(Date.now());
        setPollError(null);
      } catch {
        if (!cancel) setPollError("El último refresco falló. Se reintenta en 10 s; mientras tanto ves el libro anterior.");
      }
    };

    const stop = () => {
      generation += 1;
      if (timer) window.clearTimeout(timer);
      timer = null;
    };

    const arm = () => {
      stop();
      const mine = generation;
      timer = window.setTimeout(async () => {
        timer = null;
        if (!document.hidden) await pull();
        if (!cancel && !document.hidden && mine === generation) arm();
      }, 10_000);
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
        setPaused(true);
        return;
      }
      setPaused(false);
      void pull();
      arm();
    };

    // Opened in a background tab: wait for it to be shown instead of polling unseen.
    if (document.hidden) onVisibility();
    else arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancel = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Warm the Series tab once the book is on screen and the browser is idle.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => prefetchCharts(), { timeout: 4000 });
    return () => cancel(id);
  }, []);

  // Arrow keys move between tabs, as in any tab list.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const current = VIEWS.findIndex((item) => item.id === view);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? VIEWS.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + VIEWS.length) % VIEWS.length;
    setView(VIEWS[next].id);
    tabRefs.current[next]?.focus();
  };

  const showsMarkets = view === "book" || view === "compare";

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <h1 className="wordmark">Perps</h1>
          <p className="brand-sub">RISEx y Txflow en mainnet, solo lectura</p>
        </div>
        <Clock generatedAt={snapshot.generatedAt} live={live} paused={paused} />
      </header>

      <Versus risex={risex} txflow={txflow} risexStream={streams.risex} txflowStream={streams.txflow} paused={paused} />

      <div className="tabbar">
        <div className="tabs" role="tablist" aria-label="Vistas" onKeyDown={onTabKey}>
          {VIEWS.map((item, index) => (
            <button
              key={item.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={view === item.id}
              aria-controls={`panel-${item.id}`}
              tabIndex={view === item.id ? 0 : -1}
              className="tab"
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {showsMarkets ? (
          <div className="controls">
            {view === "book" ? (
              <div className="seg" role="group" aria-label="Venue">
                <button type="button" aria-pressed={venue === "risex"} onClick={() => setVenue("risex")}>
                  <span className="swatch sm rx" aria-hidden="true" />
                  RISEx
                </button>
                <button type="button" aria-pressed={venue === "txflow"} onClick={() => setVenue("txflow")}>
                  <span className="swatch sm tx" aria-hidden="true" />
                  Txflow
                </button>
              </div>
            ) : null}
            <div className="seg" role="group" aria-label="Cantidad de mercados">
              <button type="button" aria-pressed={!showAll} onClick={() => setShowAll(false)}>
                Top 15
              </button>
              <button type="button" aria-pressed={showAll} onClick={() => setShowAll(true)}>
                Todos
              </button>
            </div>
            <label className="search">
              <SearchIcon />
              <span className="sr-only">Filtrar símbolo</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar símbolo"
                spellCheck={false}
                autoCapitalize="characters"
                autoComplete="off"
              />
            </label>
          </div>
        ) : null}
      </div>

      {pollError ? (
        <p className="banner" role="status">
          {pollError}
        </p>
      ) : null}

      <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`}>
        {view === "book" ? (
          <>
            {shownBook.ok ? (
              <MarketsTable
                title={shownBook.label}
                venue={venue}
                markets={shownBook.markets}
                indexLabel={venue === "risex" ? "Índice" : "Oracle"}
                limit={limit}
                query={query}
              />
            ) : (
              <p className="empty">
                {shownBook.label} no respondió: {shownBook.error ?? "sin libro"}. El otro venue sigue disponible.
              </p>
            )}
            {shownBook.notes.map((note) => (
              <p className="foot" key={note}>
                {note}
              </p>
            ))}
            <p className="foot">
              Precios y volumen en USDC. OI USDC es OI base por mark; sin mark no se calcula. APR es el funding del intervalo llevado a un año, sin
              capitalizar. Pasa el mouse sobre un valor para verlo completo.
            </p>
          </>
        ) : null}
        {view === "compare" ? (
          <>
            {risex.ok && txflow.ok ? (
              <CompareTable risex={risex.markets} txflow={txflow.markets} limit={limit} query={query} />
            ) : (
              <p className="empty">La comparación vuelve cuando los dos venues respondan.</p>
            )}
            <p className="foot">
              Diferencia es el último de Txflow menos el de RISEx, en porcentaje del de RISEx. Reparto es la parte de cada venue en
              el volumen 24 h del símbolo.
            </p>
          </>
        ) : null}
        {view === "series" ? <VenueCharts /> : null}
        {view === "wallet" ? <WalletWeek /> : null}
      </div>
    </div>
  );
}
