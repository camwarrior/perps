"use client";

import { useState, type FormEvent } from "react";

import { Compact, Missing } from "@/components/numbers";
import { formatUtcWeek, utcWeek } from "@/lib/week";
import { isWalletAddress, type WalletReport, type WalletVenueResult } from "@/lib/wallet-types";

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: number | null;
  note: string;
}) {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>
        <Compact value={value} unit="USDC" />
        <small>USDC</small>
      </dd>
      {note ? <p className="note">{note}</p> : null}
    </div>
  );
}

function VenueResult({ name, result }: { name: string; result: WalletVenueResult }) {
  return (
    <article className="venue" data-state={result.ok ? "ok" : "error"} aria-label={name}>
      <header className="venue-head">
        <h3>{name}</h3>
      </header>
      {result.ok ? (
        <dl className="metrics wallet-metrics">
          <Metric label="Volumen" value={result.volumeUsdc} note={result.volumeNote} />
          <Metric label="OI promedio" value={result.oiAvgUsdc} note={result.oiNote} />
        </dl>
      ) : (
        <p className="venue-error" role="alert">
          {result.error ?? "Sin datos."}
        </p>
      )}
    </article>
  );
}

export function WalletWeek({ now }: { now: number }) {
  const [draft, setDraft] = useState("");
  const [report, setReport] = useState<WalletReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const preview = utcWeek(now);
  const shownStart = report?.startMs ?? preview.startMs;
  const shownEnd = report?.endMs ?? preview.endMs;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const address = draft.trim();
    if (!isWalletAddress(address)) {
      setError("Wallet inválida. Usa 0x y 40 caracteres hex.");
      setReport(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/wallet?address=${encodeURIComponent(address)}`, { cache: "no-store" });
      const body = (await response.json()) as WalletReport & { error?: string };
      if (!response.ok) {
        setReport(null);
        setError(body.error ?? "No se pudo consultar la wallet.");
        return;
      }
      setReport(body);
    } catch {
      setReport(null);
      setError("No se pudo consultar la wallet.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="wallet" aria-label="Wallet en la semana UTC">
      <header className="wallet-head">
        <h2>Wallet</h2>
        <p className="src">{formatUtcWeek(shownStart, shownEnd)}</p>
      </header>
      <form className="wallet-form" onSubmit={onSubmit}>
        <label className="wallet-field">
          <span className="src-label">Dirección</span>
          <input
            className="filter wallet-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="0x…"
            aria-label="Wallet EVM"
            inputMode="text"
          />
        </label>
        <button type="submit" className="retry" disabled={pending}>
          {pending ? "Consultando" : "Consultar"}
        </button>
      </form>
      {error ? (
        <p className="banner" role="alert">
          {error}
        </p>
      ) : null}
      {report ? (
        <>
          <div className="wallet-grid">
            <VenueResult name="RISEx" result={report.venues.risex} />
            <VenueResult name="Txflow" result={report.venues.txflow} />
          </div>
          <p className="wallet-total">
            <span className="src-label">Total volumen</span>
            {report.totalVolumeUsdc == null ? (
              <Missing title="Sin total: una fuente no tiene notional USDC completo en esta ventana." />
            ) : (
              <>
                <Compact value={report.totalVolumeUsdc} unit="USDC" />
                <small>USDC</small>
              </>
            )}
          </p>
          <p className="note">
            {report.totalVolumeUsdc == null
              ? "Sin total. Solo se suma cuando RISEx y Txflow traen notional USDC completo de la misma ventana."
              : "Suma de notional USDC de RISEx y Txflow en la misma semana UTC."}
          </p>
        </>
      ) : (
        <p className="note">Pega una wallet 0x. La consulta no se guarda.</p>
      )}
    </section>
  );
}
