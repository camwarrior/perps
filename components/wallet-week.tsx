"use client";

import { memo, useState, type FormEvent } from "react";

import { Missing } from "@/components/numbers";
import { formatCompact, formatFull } from "@/lib/format";
import { useNowSelect } from "@/lib/now";
import { formatUtcWeek, formatUtcWeekShort, utcWeek } from "@/lib/week";
import { isWalletAddress, type WalletReport, type WalletVenueResult } from "@/lib/wallet-types";

function Figure({ label, value, unit, note }: { label: string; value: number | null; unit: string; note: string }) {
  return (
    <div className="figure">
      <dt>{label}</dt>
      <dd>
        {value == null ? (
          <Missing title={note || "dato no disponible"} />
        ) : (
          <>
            <span className="num" title={formatFull(value, unit)}>
              {formatCompact(value)}
            </span>
            <small>{unit}</small>
          </>
        )}
      </dd>
      {note ? <p className="note">{note}</p> : null}
    </div>
  );
}

function VenueResult({ name, venue, result }: { name: string; venue: "rx" | "tx"; result: WalletVenueResult }) {
  return (
    <article className="wallet-venue" aria-label={name}>
      <h3>
        <span className={`swatch ${venue}`} aria-hidden="true" />
        {name}
      </h3>
      {result.ok ? (
        <dl className="figures">
          <Figure label="Volumen de la semana" value={result.volumeUsdc} unit="USDC" note={result.volumeNote} />
          <Figure label="OI promedio 7 días" value={result.oiAvgUsdc} unit={venue === "rx" ? "USD" : "USDC"} note={result.oiNote} />
        </dl>
      ) : (
        <p className="venue-error" role="alert">
          {result.error ?? "Este venue no respondió para esa wallet."}
        </p>
      )}
    </article>
  );
}

export const WalletWeek = memo(function WalletWeek() {
  const [draft, setDraft] = useState("");
  const [report, setReport] = useState<WalletReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Re-renders only when the UTC week rolls over, not every second.
  const weekStart = useNowSelect((now) => utcWeek(now).startMs);
  const shownStart = report?.startMs ?? weekStart;
  const shownEnd = report?.endMs ?? utcWeek(weekStart).endMs;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const address = draft.trim();
    if (!isWalletAddress(address)) {
      setError("Esa dirección no es válida. Debe empezar con 0x y tener 40 caracteres hexadecimales.");
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
        setError(body.error ?? "No se pudo consultar la wallet. Vuelve a intentarlo en un momento.");
        return;
      }
      setReport(body);
    } catch {
      setReport(null);
      setError("No se pudo consultar la wallet. Vuelve a intentarlo en un momento.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="wallet" aria-label="Wallet en la semana UTC">
      <div className="panel-head">
        <h2>Volumen de una wallet en la semana</h2>
        <p className="panel-meta" title={formatUtcWeek(shownStart, shownEnd)}>
          {formatUtcWeekShort(shownStart, shownEnd)}, de lunes 00:00 a lunes 00:00 UTC
        </p>
      </div>
      <form className="wallet-form" onSubmit={onSubmit} style={{ marginTop: 16 }}>
        <label className="field">
          Dirección EVM
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            placeholder="0x…"
            inputMode="text"
          />
        </label>
        <button type="submit" className="action" disabled={pending}>
          {pending ? "Consultando…" : "Consultar"}
        </button>
      </form>
      {error ? (
        <p className="banner" role="alert">
          {error}
        </p>
      ) : null}
      {report ? (
        <>
          <div className="wallet-results">
            <VenueResult name="RISEx" venue="rx" result={report.venues.risex} />
            <VenueResult name="Txflow" venue="tx" result={report.venues.txflow} />
          </div>
          <p className="wallet-total">
            <span className="label">Volumen total</span>
            {report.totalVolumeUsdc == null ? (
              <Missing title="Sin total: una fuente no tiene notional USDC completo en esta ventana." />
            ) : (
              <span className="num" title={formatFull(report.totalVolumeUsdc, "USDC")}>
                {formatCompact(report.totalVolumeUsdc)} USDC
              </span>
            )}
          </p>
          <p className="foot">
            {report.totalVolumeUsdc == null
              ? "El total aparece solo cuando RISEx y Txflow traen notional USDC completo de la misma semana."
              : "Suma del notional USDC de RISEx y Txflow en la misma semana UTC."}
          </p>
        </>
      ) : (
        <p className="foot">Pega una dirección para ver su volumen de la semana en cada venue. La consulta no se guarda.</p>
      )}
    </section>
  );
});
