const CHARTS = ["RISEx · volumen", "Txflow · volumen", "RISEx · OI", "Txflow · OI"];

function VenueSkeleton({ label, source }: { label: string; source: string }) {
  return (
    <article className="venue">
      <header className="venue-head">
        <h2>{label}</h2>
        <span className="tag">Conectando</span>
      </header>
      <dl className="metrics">
        {["Vol 24h", "OI", "Mercados"].map((name) => (
          <div className="metric" key={name}>
            <dt>{name}</dt>
            <dd>
              <span className="num missing">—</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="src">
        <span className="src-label">Fuente</span> {source}
      </p>
    </article>
  );
}

/** Mirrors the final layout box by box, so nothing jumps when the book streams in. */
export function TerminalSkeleton() {
  return (
    <div className="terminal" aria-busy="true">
      <header className="top">
        <div className="brand">
          <h1 className="brand-mark">PERPS</h1>
          <p className="brand-sub">RISEx / Txflow</p>
        </div>
        <p className="top-meta">
          <span className="mono">Leyendo mainnet…</span>
        </p>
      </header>
      <section className="venues">
        <VenueSkeleton label="RISEx" source="api.rise.trade" />
        <VenueSkeleton label="Txflow" source="rpc.txflow.com" />
      </section>
      <section className="charts" aria-hidden="true">
        <header className="chart-toolbar">
          <h2>Series</h2>
        </header>
        <div className="chart-grid">
          {CHARTS.map((title) => (
            <article className="chart-card" key={title}>
              <header className="chart-head">
                <h3>{title}</h3>
              </header>
              <figure className="spark">
                <div className="spark-plot">
                  <svg viewBox="0 0 320 92" preserveAspectRatio="none" />
                </div>
                <figcaption className="spark-scale">
                  <span>&nbsp;</span>
                </figcaption>
              </figure>
              <p className="note">&nbsp;</p>
            </article>
          ))}
        </div>
      </section>
      <section className="wallet" aria-hidden="true">
        <header className="wallet-head">
          <h2>Wallet</h2>
          <p className="src">&nbsp;</p>
        </header>
        <div className="wallet-form">
          <span className="filter wallet-input skeleton-input" />
        </div>
        <p className="note">&nbsp;</p>
      </section>
      <section className="book" aria-hidden="true">
        <div className="table-scroll skeleton-rows">
          {Array.from({ length: 15 }, (_, index) => (
            <div className="skeleton-row" key={index} />
          ))}
        </div>
      </section>
    </div>
  );
}
