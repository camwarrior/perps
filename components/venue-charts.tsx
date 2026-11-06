"use client";

import { useEffect, useState, type MouseEvent } from "react";

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

function formatCandle(ms: number): string {
  return `${utcDay.format(new Date(ms)).replace(",", "")} UTC`;
}

function formatAxis(ms: number): string {
  return formatCandle(ms).replace(/\s+\d{2}:\d{2} UTC$/, " UTC");
}

function ChartFrame({ title, series }: { title: string; series: ChartSeries | null }) {
  return (
    <article className="chart-card">
      <header className="chart-head">
        <h3>{title}</h3>
        <p className="src">{series ? `${series.unit || "—"} · ${series.source}` : "leyendo"}</p>
      </header>
      {series == null ? (
        <p className="chart-empty">Leyendo serie…</p>
      ) : series.points.length === 0 ? (
        <p className="chart-empty">{series.note || series.error || "Sin serie."}</p>
      ) : (
        <>
          <Spark points={series.points} unit={series.unit} />
          <p className="note">{series.note}</p>
        </>
      )}
    </article>
  );
}

function Spark({ points, unit }: { points: ChartPoint[]; unit: string }) {
  const width = 320;
  const height = 92;
  const padY = 6;
  const gap = 0.12;
  const [active, setActive] = useState<{ index: number; x: number; y: number } | null>(null);
  const max = Math.max(...points.map((point) => point.v), 0);
  const min = Math.min(...points.map((point) => point.v), 0);
  const span = max - min || 1;
  const slot = width / points.length;
  const yOf = (value: number) => padY + (1 - (value - min) / span) * (height - padY * 2);
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

  const pick = (event: MouseEvent<SVGSVGElement>) => {
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
    const half = 128;
    const x = Math.min(window.innerWidth - half - 8, Math.max(half + 8, screen.x));
    setActive({ index, x, y: screen.y });
  };

  return (
    <figure className="spark" onMouseLeave={() => setActive(null)}>
      <div className="spark-plot">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={last ? `${formatCandle(last.t)} · ${formatFull(last.v, unit)}` : "sin puntos"}
          onMouseMove={pick}
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
            <span className="num">{formatFull(tip.point.v, unit)}</span>
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

export function VenueCharts() {
  const [range, setRange] = useState<ChartRange>("1S");
  const [data, setData] = useState<ChartsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    const run = async () => {
      try {
        const response = await fetch(`/api/charts?range=${range}`, { cache: "no-store" });
        if (!response.ok) throw new Error("HTTP");
        const body = (await response.json()) as ChartsPayload;
        if (cancel || body.range !== range) return;
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

  const current = data?.range === range ? data : null;

  return (
    <section className="charts" aria-label="Series de venue">
      <header className="chart-toolbar">
        <h2>Series</h2>
        <div className="segment" role="group" aria-label="Temporalidad">
          {CHART_RANGES.map((item) => (
            <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>
              {item}
            </button>
          ))}
        </div>
      </header>
      {error && !current ? <p className="banner">{error}</p> : null}
      <div className="chart-grid">
        <ChartFrame title="RISEx · volumen" series={current?.venues.risex.volume ?? null} />
        <ChartFrame title="Txflow · volumen" series={current?.venues.txflow.volume ?? null} />
        <ChartFrame title="RISEx · OI" series={current?.venues.risex.oi ?? null} />
        <ChartFrame title="Txflow · OI" series={current?.venues.txflow.oi ?? null} />
      </div>
    </section>
  );
}
