export function TerminalSkeleton() {
  return (
    <div className="terminal" aria-busy="true">
      <header className="top">
        <div className="brand">
          <h1 className="brand-mark">PERPS</h1>
          <p className="brand-sub">RISEx / Txflow</p>
        </div>
        <p className="top-meta">
          <span className="mono">—</span>
        </p>
      </header>
      <p className="loading-note">Leyendo mainnet…</p>
      <section className="venues">
        <article className="venue">
          <h2>RISEx</h2>
          <p className="src">esperando /v1/markets</p>
        </article>
        <article className="venue">
          <h2>Txflow</h2>
          <p className="src">esperando /info</p>
        </article>
      </section>
    </div>
  );
}
