"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="shell">
      <h1 className="wordmark">Perps</h1>
      <p className="venue-error" role="alert" style={{ marginTop: 24 }}>
        No se pudo armar el libro: ningún venue respondió a tiempo.
      </p>
      <button type="button" className="action quiet" style={{ marginTop: 16 }} onClick={reset}>
        Reintentar
      </button>
    </main>
  );
}
