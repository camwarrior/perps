function VsRow({ name }: { name: string }) {
  return (
    <div className="vs-row">
      <p className="vs-value missing">—</p>
      <div className="vs-mid">
        <p className="vs-labels">
          <span>&nbsp;</span>
          <span className="metric-name">{name}</span>
          <span>&nbsp;</span>
        </p>
        <div className="vs-bar empty" />
      </div>
      <p className="vs-value right missing">—</p>
    </div>
  );
}

/** Mirrors the final layout box by box, so nothing jumps when the book streams in. */
export function TerminalSkeleton() {
  return (
    <div className="shell" aria-busy="true">
      <header className="top">
        <div className="brand">
          <h1 className="wordmark">Perps</h1>
          <p className="brand-sub">RISEx y Txflow en mainnet, solo lectura</p>
        </div>
        <p className="top-meta">
          <span className="dot off" aria-hidden="true" />
          <span>Leyendo mainnet…</span>
        </p>
      </header>
      <section className="versus" aria-hidden="true">
        <div className="versus-head">
          <div className="venue-id">
            <h2 className="venue-name">
              <span className="swatch rx" />
              RISEx
            </h2>
            <p className="venue-meta">conectando</p>
          </div>
          <div className="venue-id right">
            <h2 className="venue-name">
              Txflow
              <span className="swatch tx" />
            </h2>
            <p className="venue-meta">conectando</p>
          </div>
        </div>
        <VsRow name="Volumen 24 h, USDC" />
        <VsRow name="Interés abierto, USDC" />
      </section>
      <div className="tabbar" aria-hidden="true">
        <div className="tabs">
          <span className="tab" style={{ color: "var(--ink)", fontWeight: 600, boxShadow: "inset 0 -2px 0 var(--ink)" }}>
            Libro
          </span>
          <span className="tab">Comparar</span>
          <span className="tab">Series</span>
          <span className="tab">Wallet</span>
        </div>
      </div>
      <div style={{ marginTop: 68 }} aria-hidden="true">
        {Array.from({ length: 15 }, (_, index) => (
          <span className="skeleton-line" key={index} />
        ))}
      </div>
    </div>
  );
}
