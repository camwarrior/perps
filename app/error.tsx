"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="terminal">
      <h1 className="brand-mark">PERPS</h1>
      <p className="venue-error" role="alert">
        No se pudo armar el libro.
      </p>
      <button type="button" className="retry" onClick={reset}>
        Reintentar
      </button>
    </main>
  );
}
