"use client";

import { memo, useEffect, useState, type PointerEvent } from "react";

import { CHART_RANGES, type ChartPoint, type ChartRange, type ChartSeries, type ChartsPayload } from "@/lib/chart-series";
import { formatCompact, formatFull } from "@/lib/format";

const utcDay = new Intl.DateTimeFormat("es-CL", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const WIDTH = 320;
const HEIGHT = 92;

function formatCandle(ms: number): string {
  return `${utcDay.format(new Date(ms)).replace(",", "")} UTC`;
}

function formatAxis(ms: number): string {
  return formatCandle(ms).replace(/\s+\d{2}:\d{2} UTC$/, " UTC");
}

/** Same box as a drawn chart, so the page does not move when the series arrive. */
function SparkPlaceholder({ text }: { text: string }) {
  return (
    <>
      <figure className="spark" aria-hidden="true">
        <div className="spark-plot">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" />
          <p className="spark-overlay">{text}</p>
        </div>
        <figcaption className="spark-scale">
          <span>&nbsp;</span>
        </figcaption>
      </figure>
      <p className="note">&nbsp;</p>
    </>
  );
}

function ChartFrame({ title, series }: { title: string; series: ChartSeries | null }) {
  return (
    <article className="chart-card">
      <header className="chart-head">
        <h3>{title}</h3>
        <p className="src">{series ? `${series.unit || "—"} · ${series.source}` : " "}</p>
      </header>
      {series == null ? (
        <SparkPlaceholder text="Leyendo serie…" />
      ) : series.points.length === 0 ? (
        <SparkPlaceholder text={series.note || series.error || "Sin serie."} />
      ) : (
        <>
          <Spark points={series.points} unit={series.unit} />
          <p className="note">{series.note || " "}</p>
        </>
      )}
    </article>
  );
}

function Spark({ points, unit }: { points: ChartPoint[]; unit: string }) {
  const padY = 6;
  const gap = 0.12;
  const [active, setActive] = useState<{ index: number; x: number; y: number } | null>(null);
  const max = Math.max(...points.map((point) => point.v), 0);
  const min = Math.min(...points.map((point) => point.v), 0);
  const span = max - min || 1;
  const slot = WIDTH / points.length;
  const yOf = (value: number) => padY + (1 - (value - min) / span) * (HEIGHT - padY * 2);
  const bars = points.map((point, index) => {
    const w = slot * (1 - gap);
    const x = index * slot + (slot - w) / 2;
    const y = yOf(point.v);
    const base = yOf(0);
    const top = Math.min(y, base);
    const h = Math.max(1.5, Math.abs(base - y));
    return { x, top, h, w, point };
  });
  const last = points[points.length - 1];
  const first = points[0];
  const tip = active == null ? null : bars[active.index];

  // Pointer events cover mouse, pen and touch, so the tooltip also works on a phone.
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const cursor = svg.createSVGPoint();
    cursor.x = event.clientX;
    cursor.y = event.clientY;
    const local = cursor.matrixTransform(matrix.inverse());
    const index = Math.min(bars.length - 1, Math.max(0, Math.floor(local.x / slot)));
    const bar = bars[index];
    if (!bar) return;
    const anchor = svg.createSVGPoint();
    anchor.x = bar.x + bar.w / 2;
    anchor.y = bar.top;
    const screen = anchor.matrixTransform(matrix);
    const half = 80;
    const x = Math.min(window.innerWidth - half - 8, Math.max(half + 8, screen.x));
    setActive((prev) => (prev && prev.index === index && prev.x === x && prev.y === screen.y ? prev : { index, x, y: screen.y }));
  };

  return (
    <figure className="spark" onPointerLeave={() => setActive(null)}>
      <div className="spark-plot">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={last ? `${formatCandle(last.t)} · ${formatFull(last.v, unit)}` : "sin puntos"}
          onPointerMove={pick}
          onPointerDown={pick}
        >
          {bars.map((bar, index) => (
            <rect
              key={bar.point.t}
              x={bar.x}
              y={bar.top}
              width={bar.w}
              height={bar.h}
              className={index === active?.index ? "spark-bar is-active" : "spark-bar"}
            />
          ))}
        </svg>
        {tip && active ? (
          <div className="chart-tip" role="tooltip" style={{ left: `${active.x}px`, top: `${active.y}px` }}>
            <span>{formatCandle(tip.point.t)}</span>
            <span className="num" title={formatFull(tip.point.v, unit)}>
              {formatCompact(tip.point.v)} {unit}
            </span>
          </div>
        ) : null}
      </div>
      <figcaption className="spark-scale">
        <span>{first ? formatAxis(first.t) : ""}</span>
        <span className="num">{last ? `últ. ${formatCompact(last.v)}` : "—"}</span>
        <span>{last ? formatAxis(last.t) : ""}</span>
      </figcaption>
    </figure>
  );
}

// Series are daily UTC candles: a range fetched once in this visit is reused for a minute.
const clientCache = new Map<ChartRange, { at: number; data: ChartsPayload }>();
const CLIENT_TTL_MS = 60_000;

function freshCache(range: ChartRange): ChartsPayload | null {
  const hit = clientCache.get(range);
  return hit && Date.now() - hit.at < CLIENT_TTL_MS ? hit.data : null;
}

export const VenueCharts = memo(function VenueCharts() {
  const [range, setRange] = useState<ChartRange>("1S");
  const [data, setData] = useState<ChartsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (freshCache(range)) return;
    let cancel = false;
    const run = async () => {
      try {
        const response = await fetch(`/api/charts?range=${range}`, { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP");
        const body = (await response.json()) as ChartsPayload;
        if (cancel || body.range !== range) return;
        clientCache.set(range, { at: Date.now(), data: body });
        setData(body);
        setError(null);
      } catch {
        if (!cancel) setError("No se pudieron leer las series.");
      }
    };
    void run();
    return () => {
      cancel = true;
    };
  }, [range]);

  const select = (next: ChartRange) => {
    const hit = freshCache(next);
    if (hit) {
      setData(hit);
      setError(null);
    }
    setRange(next);
  };

  // While a new range loads, the previous one stays on screen, dimmed, instead of emptying the cards.
  const loading = data != null && data.range !== range && error == null;

  return (
    <section className="charts" aria-label="Series de venue" aria-busy={loading || data == null}>
      <header className="chart-toolbar">
        <h2>Series</h2>
        <div className="segment" role="group" aria-label="Temporalidad">
          {CHART_RANGES.map((item) => (
            <button key={item} type="button" aria-pressed={range === item} onClick={() => select(item)}>
              {item}
            </button>
          ))}
        </div>
      </header>
      {error ? (
        <p className="banner">
          {data && data.range !== range ? `${error} Se muestra ${data.range}.` : error}
        </p>
      ) : null}
      <div className={loading ? "chart-grid is-loading" : "chart-grid"}>
        <ChartFrame title="RISEx · volumen" series={data?.venues.risex.volume ?? null} />
        <ChartFrame title="Txflow · volumen" series={data?.venues.txflow.volume ?? null} />
        <ChartFrame title="RISEx · OI" series={data?.venues.risex.oi ?? null} />
        <ChartFrame title="Txflow · OI" series={data?.venues.txflow.oi ?? null} />
      </div>
    </section>
  );
});
