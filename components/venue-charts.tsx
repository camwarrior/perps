"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { CHART_RANGES, isChartRange, type ChartRange, type ChartSeries, type ChartsPayload } from "@/lib/chart-series";
import { formatCompact, formatFull } from "@/lib/format";
import { useNowSelect } from "@/lib/now";

const dayLabel = new Intl.DateTimeFormat("es-CL", { timeZone: "UTC", day: "numeric", month: "short" });
const dayLong = new Intl.DateTimeFormat("es-CL", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });

const RANGE_LABEL: Record<ChartRange, string> = { "1S": "1 semana", "1M": "1 mes", "3M": "3 meses", "1A": "1 año", ALL: "Todo" };
const DAY_MS = 24 * 60 * 60 * 1000;
const MARGIN = { top: 10, right: 8, bottom: 26, left: 56 };
/** Up to this many days the two venues are paired columns; beyond it, two lines. */
const MAX_BARS = 45;

function formatDay(ms: number): string {
  return dayLabel.format(new Date(ms)).replace(".", "");
}

/** Clean axis steps: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return nice * power;
}

function useSize<T extends Element>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // display:none reports 0. Keeping the last real size lets the chart stay drawn when the tab is shown again.
      if (width === 0 || height === 0) return;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Column with a 4 px rounded data end, square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

type Day = { t: number; rx: number | null; tx: number | null };

function mergeDays(rx: ChartSeries | null, tx: ChartSeries | null): Day[] {
  const days = new Map<number, Day>();
  for (const point of rx?.points ?? []) days.set(point.t, { t: point.t, rx: point.v, tx: days.get(point.t)?.tx ?? null });
  for (const point of tx?.points ?? []) days.set(point.t, { t: point.t, rx: days.get(point.t)?.rx ?? null, tx: point.v });
  return [...days.values()].toSorted((a, b) => a.t - b.t);
}

function Chart({
  title,
  unit,
  rx,
  tx,
  loading,
}: {
  title: string;
  unit: string;
  rx: ChartSeries | null;
  tx: ChartSeries | null;
  loading: boolean;
}) {
  const [ref, size] = useSize<SVGSVGElement>();
  const [hover, setHover] = useState<number | null>(null);
  // A tap pins the tooltip until another tap on the same day, or a tap outside the chart.
  const [pinned, setPinned] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => mergeDays(rx, tx), [rx, tx]);
  const pending = rx == null && tx == null;
  const asBars = days.length <= MAX_BARS;
  // Today's UTC day has not closed: its bar is a running value (volume so far, OI's latest snapshot).
  const todayStart = useNowSelect((now) => Math.floor(now / DAY_MS) * DAY_MS);
  const isOpen = (day: Day) => day.t >= todayStart;
  const hasOpenDay = days.some(isOpen);

  const plotW = Math.max(0, size.width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(0, size.height - MARGIN.top - MARGIN.bottom);
  const max = Math.max(0, ...days.flatMap((day) => [day.rx ?? 0, day.tx ?? 0]));
  const step = niceStep(max / 3);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);
  const yOf = (value: number) => MARGIN.top + plotH - (value / top) * plotH;
  const band = days.length ? plotW / days.length : 0;
  const xMid = (index: number) => MARGIN.left + band * index + band / 2;

  const barW = Math.max(1, Math.min(24, (band * 0.78 - 2) / 2));
  const linePath = (key: "rx" | "tx") => {
    let d = "";
    let open = false;
    days.forEach((day, index) => {
      const value = day[key];
      if (value == null) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${xMid(index).toFixed(1)},${yOf(value).toFixed(1)}`;
      open = true;
    });
    return d;
  };

  const indexAt = (event: PointerEvent<SVGSVGElement>): number | null => {
    if (!days.length || band === 0) return null;
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientX - box.left - MARGIN.left) / band);
    return Math.min(days.length - 1, Math.max(0, index));
  };

  // Mouse: the tooltip follows the pointer and leaves with it.
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== "mouse" || pinned) return;
    const index = indexAt(event);
    setHover((prev) => (prev === index ? prev : index));
  };

  const onLeave = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "mouse" && !pinned) setHover(null);
  };

  // Finger or pen: a tap pins that day, a tap on another day moves it, a tap on the same day closes it.
  // A swipe to scroll ends in pointercancel, not pointerup, so scrolling never opens it.
  const onUp = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "mouse") return;
    const index = indexAt(event);
    if (index == null) return;
    if (pinned && hover === index) {
      setPinned(false);
      setHover(null);
      return;
    }
    setPinned(true);
    setHover(index);
  };

  useEffect(() => {
    if (!pinned) return;
    const close = (event: Event) => {
      if (bodyRef.current?.contains(event.target as Node)) return;
      setPinned(false);
      setHover(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [pinned]);

  const active = hover == null ? null : days[hover];
  const tipLeft = hover == null ? 0 : Math.min(Math.max(xMid(hover) - 90, 0), Math.max(0, size.width - 190));
  const notes =
    rx?.note && tx?.note && rx.note === tx.note
      ? rx.note
      : [rx?.note && `RISEx: ${rx.note}`, tx?.note && `Txflow: ${tx.note}`].filter(Boolean).join(" ");
  const sources = [rx?.source && `RISEx ${rx.source}`, tx?.source && `Txflow ${tx.source}`].filter(Boolean).join(", ");
  const emptyText = pending ? "Leyendo series…" : days.length === 0 ? rx?.error || tx?.error || "Ningún venue publica puntos en esta ventana." : null;
  const legendNote = (series: ChartSeries | null) => (series && series.points.length === 0 ? " (sin puntos en esta ventana)" : "");
  // Date labels about every 90 px, always the last day, never two labels crowding the end.
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotW / 90))));
  const axisDays = days.length
    ? [
        ...days.map((_, index) => index).filter((index) => index % labelEvery === 0 && days.length - 1 - index >= labelEvery * 0.6),
        days.length - 1,
      ]
    : [];

  return (
    <article>
      <header className="chart-head">
        <h3>{title}</h3>
        <ul className="legend">
          <li>
            <span className="swatch rx" aria-hidden="true" />
            RISEx{legendNote(rx)}
          </li>
          <li>
            <span className="swatch tx" aria-hidden="true" />
            Txflow{legendNote(tx)}
          </li>
        </ul>
      </header>
      <div ref={bodyRef} className={loading ? "chart-body is-loading" : "chart-body"}>
        <svg
          ref={ref}
          role="img"
          aria-label={`${title}. ${days.length} días. Detalle en la tabla de datos.`}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
          onPointerUp={onUp}
        >
          {size.width > 0 ? (
            <>
              {ticks.map((tick) => (
                <g key={tick}>
                  <line className="grid-line" x1={MARGIN.left} x2={size.width - MARGIN.right} y1={yOf(tick)} y2={yOf(tick)} />
                  <text className="axis-text" x={MARGIN.left - 10} y={yOf(tick)} dy="0.32em" textAnchor="end">
                    {tick === 0 ? "0" : formatCompact(tick)}
                  </text>
                </g>
              ))}
              {axisDays.map((index) => (
                <text
                  key={days[index].t}
                  className="axis-text"
                  x={xMid(index)}
                  y={size.height - 6}
                  textAnchor={asBars ? "middle" : index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}
                >
                  {formatDay(days[index].t)}
                </text>
              ))}
              {asBars ? (
                days.map((day, index) => {
                  const dim = [hover != null && hover !== index ? "dim" : "", isOpen(day) ? "open-day" : ""].filter(Boolean).join(" ") || undefined;
                  const left = xMid(index) - barW - 1;
                  return (
                    <g key={day.t} className={dim}>
                      {day.rx != null && day.rx > 0 ? (
                        <path className="bar-rx" d={columnPath(left, yOf(day.rx), barW, yOf(0) - yOf(day.rx))} />
                      ) : null}
                      {day.tx != null && day.tx > 0 ? (
                        <path className="bar-tx" d={columnPath(left + barW + 2, yOf(day.tx), barW, yOf(0) - yOf(day.tx))} />
                      ) : null}
                    </g>
                  );
                })
              ) : (
                <>
                  <path className="line-rx" d={linePath("rx")} />
                  <path className="line-tx" d={linePath("tx")} />
                  {hover != null ? (
                    <line className="crosshair" x1={xMid(hover)} x2={xMid(hover)} y1={MARGIN.top} y2={MARGIN.top + plotH} />
                  ) : null}
                </>
              )}
            </>
          ) : null}
        </svg>
        {emptyText ? <p className="chart-empty">{emptyText}</p> : null}
        {active ? (
          <div className="chart-tip" role="tooltip" style={{ left: `${tipLeft}px`, top: "0px" }}>
            <p className="when">
              {dayLong.format(new Date(active.t))} UTC{isOpen(active) ? ", en curso" : ""}
            </p>
            <ul>
              <li>
                <span className="swatch sm rx" aria-hidden="true" />
                RISEx
                <span className="num" title={active.rx == null ? undefined : formatFull(active.rx, unit)}>
                  {active.rx == null ? "—" : `${formatCompact(active.rx)} ${unit}`}
                </span>
              </li>
              <li>
                <span className="swatch sm tx" aria-hidden="true" />
                Txflow
                <span className="num" title={active.tx == null ? undefined : formatFull(active.tx, unit)}>
                  {active.tx == null ? "—" : `${formatCompact(active.tx)} ${unit}`}
                </span>
              </li>
            </ul>
          </div>
        ) : null}
      </div>
      {notes || sources ? (
        <p className="chart-note">
          {hasOpenDay ? "La barra de hoy es provisional: el día UTC aún no cierra. " : null}
          {notes} {sources ? `Fuente: ${sources}.` : null}
        </p>
      ) : null}
      {days.length > 0 ? (
        <details className="chart-note">
          <summary>Ver datos</summary>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Día UTC</th>
                <th scope="col">RISEx</th>
                <th scope="col">Txflow</th>
              </tr>
            </thead>
            <tbody>
              {days.toReversed().map((day) => (
                <tr key={day.t}>
                  <td>{formatDay(day.t)}</td>
                  <td>{day.rx == null ? "—" : formatFull(Math.round(day.rx), unit)}</td>
                  <td>{day.tx == null ? "—" : formatFull(Math.round(day.tx), unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </article>
  );
}

// Last good payload per range. Fresh for a minute; still shown for a day while a refresh runs.
const clientCache = new Map<ChartRange, { at: number; data: ChartsPayload }>();
const clientJobs = new Map<ChartRange, Promise<ChartsPayload>>();
const CLIENT_TTL_MS = 60_000;
const PERSIST_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "perps.series.v1";

let rememberedRange: ChartRange = "1S";
let storeLoaded = false;

function isPayload(value: unknown): value is ChartsPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as ChartsPayload;
  const volume = payload.venues?.risex?.volume;
  const tx = payload.venues?.txflow?.volume;
  return isChartRange(payload.range) && Array.isArray(volume?.points) && Array.isArray(tx?.points) && Array.isArray(payload.venues?.risex?.oi?.points);
}

function loadStore(): void {
  if (storeLoaded || typeof window === "undefined") return;
  storeLoaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { range?: unknown; entries?: Record<string, { at?: unknown; data?: unknown }> };
    if (typeof parsed.range === "string" && isChartRange(parsed.range)) rememberedRange = parsed.range;
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
      if (!isChartRange(key) || !entry || typeof entry.at !== "number") continue;
      if (now - entry.at > PERSIST_MS || !isPayload(entry.data) || entry.data.range !== key) continue;
      clientCache.set(key, { at: entry.at, data: entry.data });
    }
  } catch {
    /* a corrupt or private-mode store just means the first paint waits on the network */
  }
}

function persistStore(): void {
  if (typeof window === "undefined") return;
  try {
    const entries: Record<string, { at: number; data: ChartsPayload }> = {};
    const now = Date.now();
    for (const [range, entry] of clientCache) {
      if (now - entry.at <= PERSIST_MS) entries[range] = entry;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ range: rememberedRange, entries }));
  } catch {
    /* the in-memory copy still covers this visit */
  }
}

function rememberRange(next: ChartRange): void {
  rememberedRange = next;
  persistStore();
}

function cachedEntry(range: ChartRange): { at: number; data: ChartsPayload } | null {
  loadStore();
  const hit = clientCache.get(range);
  if (!hit || Date.now() - hit.at > PERSIST_MS) return null;
  return hit;
}

function isFresh(entry: { at: number } | null): boolean {
  return entry != null && Date.now() - entry.at < CLIENT_TTL_MS;
}

/** One request per range at a time, shared by the prefetch and the tab. */
function loadCharts(range: ChartRange): Promise<ChartsPayload> {
  const running = clientJobs.get(range);
  if (running) return running;
  const job = fetch(`/api/charts?range=${range}`)
    .then(async (response) => {
      if (!response.ok) throw new Error("HTTP");
      const body = (await response.json()) as ChartsPayload;
      if (!isPayload(body) || body.range !== range) throw new Error("range");
      clientCache.set(range, { at: Date.now(), data: body });
      persistStore();
      return body;
    })
    .finally(() => clientJobs.delete(range));
  clientJobs.set(range, job);
  return job;
}

/** Start 1S as soon as this module runs in the browser, before idle and before the tab is opened. */
export function prefetchCharts(): void {
  loadStore();
  if (isFresh(cachedEntry("1S"))) return;
  void loadCharts("1S").catch(() => {
    /* the tab retries when opened */
  });
}

if (typeof window !== "undefined") prefetchCharts();

export const VenueCharts = memo(function VenueCharts({ active }: { active: boolean }) {
  const [range, setRange] = useState<ChartRange>(() => {
    loadStore();
    return rememberedRange;
  });
  const [data, setData] = useState<ChartsPayload | null>(() => cachedEntry(rememberedRange)?.data ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    if (isFresh(cachedEntry(range))) return;
    let cancel = false;
    loadCharts(range)
      .then((body) => {
        if (cancel) return;
        setData(body);
        setError(null);
      })
      .catch(() => {
        if (!cancel && !cachedEntry(range)) setError("No se pudieron leer las series. Prueba otra temporalidad o vuelve en un momento.");
      });
    return () => {
      cancel = true;
    };
  }, [active, range]);

  const select = (next: ChartRange) => {
    rememberRange(next);
    const hit = cachedEntry(next);
    if (hit) {
      setData(hit.data);
      setError(null);
    }
    setRange(next);
  };

  // While a new range loads, the previous one stays on screen, dimmed, instead of emptying the charts.
  const loading = data != null && data.range !== range && error == null;

  return (
    <section aria-label="Series diarias" aria-busy={loading || data == null}>
      <div className="panel-head">
        <h2>Historia diaria, RISEx contra Txflow</h2>
        <div className="seg" role="group" aria-label="Temporalidad">
          {CHART_RANGES.map((item) => (
            <button key={item} type="button" aria-pressed={range === item} onClick={() => select(item)} title={RANGE_LABEL[item]}>
              {item}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <p className="banner" role="status">
          {data && data.range !== range ? `${error} Se muestra ${RANGE_LABEL[data.range].toLowerCase()}.` : error}
        </p>
      ) : null}
      <div className="series">
        <Chart
          title="Volumen diario, USDC"
          unit="USDC"
          rx={data?.venues.risex.volume ?? null}
          tx={data?.venues.txflow.volume ?? null}
          loading={loading}
        />
        <Chart
          title="Interés abierto al cierre diario, USD"
          unit="USD"
          rx={data?.venues.risex.oi ?? null}
          tx={data?.venues.txflow.oi ?? null}
          loading={loading}
        />
      </div>
    </section>
  );
});
