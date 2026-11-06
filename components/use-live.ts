"use client";

import { useEffect, useRef, useState } from "react";

import { intervalLabelFromMs, weiToNumber } from "@/lib/number";
import type { QuoteOverride, TickerQuote } from "@/lib/types";

export type StreamStatus = "connecting" | "live" | "down" | "paused";

function defined(value: number | null | undefined): number | undefined {
  return value == null ? undefined : value;
}

function parseLiveNumber(value: string | undefined): number | undefined {
  if (value == null || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function overrideFromTicker(quote: TickerQuote, at: number): QuoteOverride {
  const override: QuoteOverride = { at };
  const last = defined(quote.last);
  const mark = defined(quote.mark);
  const index = defined(quote.index);
  const oiBase = defined(quote.oiBase);
  const fundingPct = defined(quote.fundingPct);
  const prevDayPx = defined(quote.prevDayPx);
  const volumeUsdc = defined(quote.volumeUsdc);
  if (last !== undefined) override.last = last;
  if (mark !== undefined) override.mark = mark;
  if (index !== undefined) override.index = index;
  if (oiBase !== undefined) override.oiBase = oiBase;
  if (fundingPct !== undefined) override.fundingPct = fundingPct;
  if (quote.fundingInterval) override.fundingInterval = quote.fundingInterval;
  if (prevDayPx !== undefined) override.prevDayPx = prevDayPx;
  if (volumeUsdc !== undefined) override.volumeUsdc = volumeUsdc;
  return override;
}

export function useQuoteStream(active: boolean): {
  overrides: Record<string, QuoteOverride>;
  risex: StreamStatus;
  txflow: StreamStatus;
} {
  const [overrides, setOverrides] = useState<Record<string, QuoteOverride>>({});
  const [risex, setRisex] = useState<StreamStatus>("connecting");
  const [txflow, setTxflow] = useState<StreamStatus>("connecting");
  const [trackedActive, setTrackedActive] = useState(active);
  if (active !== trackedActive) {
    setTrackedActive(active);
    if (active) {
      setRisex("connecting");
      setTxflow("connecting");
    }
  }
  const risexStatus: StreamStatus = active ? risex : "paused";
  const txflowStatus: StreamStatus = active ? txflow : "paused";

  useEffect(() => {
    if (!active) return;

    let stopped = false;
    const pending = new Map<string, QuoteOverride>();
    let flushTimer: number | null = null;
    let riseRetry = 1_500;
    let txRetry = 1_500;

    const flush = () => {
      flushTimer = null;
      if (pending.size === 0) return;
      const batch = new Map(pending);
      pending.clear();
      setOverrides((prev) => {
        const next = { ...prev };
        for (const [key, value] of batch) next[key] = value;
        return next;
      });
    };
    const schedule = () => {
      if (flushTimer != null) return;
      flushTimer = window.setTimeout(flush, 400);
    };

    let riseSocket: WebSocket | null = null;
    let txSocket: WebSocket | null = null;
    let riseWatch: number | null = null;
    let txWatch: number | null = null;
    let riseTimer: number | null = null;
    let txTimer: number | null = null;

    const connectRisex = () => {
      if (stopped) return;
      // After a failure, keep showing the polling state while retrying, so the tag does not flicker.
      setRisex((prev) => (prev === "down" ? prev : "connecting"));
      const ws = new WebSocket("wss://ws.rise.trade/ws");
      riseSocket = ws;
      const connectTimer = window.setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) ws.close();
      }, 6_000);
      const beat = () => {
        if (riseWatch) window.clearTimeout(riseWatch);
        riseWatch = window.setTimeout(() => ws.close(), 20_000);
      };
      ws.onopen = () => {
        window.clearTimeout(connectTimer);
        riseRetry = 1_500;
        beat();
        ws.send(JSON.stringify({ method: "subscribe", params: { channel: "oracle" } }));
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        beat();
        let message: {
          channel?: string;
          type?: string;
          data?: { prices?: Record<string, { mark_price?: string; index_price?: string }> };
        };
        try {
          message = JSON.parse(event.data) as typeof message;
        } catch {
          return;
        }
        const prices = message.channel === "oracle" && message.type === "update" ? message.data?.prices : null;
        if (!prices) return;
        setRisex("live");
        const at = Date.now();
        for (const [id, price] of Object.entries(prices)) {
          const mark = weiToNumber(price.mark_price);
          const index = weiToNumber(price.index_price);
          const override: QuoteOverride = { at };
          if (mark != null) override.mark = mark;
          if (index != null) override.index = index;
          pending.set(`risex:${id}`, override);
        }
        schedule();
      };
      ws.onclose = () => {
        if (stopped) return;
        setRisex("down");
        riseTimer = window.setTimeout(connectRisex, riseRetry);
        riseRetry = Math.min(riseRetry * 2, 20_000);
      };
    };

    const connectTx = () => {
      if (stopped) return;
      setTxflow((prev) => (prev === "down" ? prev : "connecting"));
      const ws = new WebSocket("wss://rpc.txflow.com/ws");
      txSocket = ws;
      const connectTimer = window.setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) ws.close();
      }, 6_000);
      const beat = () => {
        if (txWatch) window.clearTimeout(txWatch);
        txWatch = window.setTimeout(() => ws.close(), 20_000);
      };
      ws.onopen = () => {
        window.clearTimeout(connectTimer);
        txRetry = 1_500;
        beat();
        ws.send(
          JSON.stringify({
            method: "subscribe",
            type: "allAssetCtxs",
            subscription: { type: "allAssetCtxs" },
          }),
        );
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        beat();
        let message: {
          channel?: string;
          data?: {
            ctxs?: Array<{
              coin?: string;
              ctx?: {
                markPx?: string;
                oraclePx?: string;
                lastPrice?: string;
                openInterest?: string;
                funding?: string;
                nextFundingTime?: number;
                prevFundingTime?: number;
              };
            }>;
          };
        };
        try {
          message = JSON.parse(event.data) as typeof message;
        } catch {
          return;
        }
        if (message.channel !== "allAssetCtxs" || !Array.isArray(message.data?.ctxs)) return;
        setTxflow("live");
        const at = Date.now();
        for (const row of message.data.ctxs) {
          if (!row.coin || !/^\d+$/.test(row.coin) || !row.ctx) continue;
          const mark = parseLiveNumber(row.ctx.markPx);
          const index = parseLiveNumber(row.ctx.oraclePx);
          const last = parseLiveNumber(row.ctx.lastPrice);
          const oiBase = parseLiveNumber(row.ctx.openInterest);
          const fundingPct = parseLiveNumber(row.ctx.funding);
          const interval = intervalLabelFromMs(
            row.ctx.nextFundingTime != null && row.ctx.prevFundingTime != null
              ? row.ctx.nextFundingTime - row.ctx.prevFundingTime
              : null,
          );
          const override: QuoteOverride = { at };
          if (mark !== undefined && Number.isFinite(mark)) override.mark = mark;
          if (index !== undefined && Number.isFinite(index)) override.index = index;
          if (last !== undefined && Number.isFinite(last)) override.last = last;
          if (oiBase !== undefined && Number.isFinite(oiBase)) override.oiBase = oiBase;
          if (fundingPct !== undefined && Number.isFinite(fundingPct)) override.fundingPct = fundingPct;
          if (interval) override.fundingInterval = interval;
          pending.set(`txflow:${row.coin}`, override);
        }
        schedule();
      };
      ws.onclose = () => {
        if (stopped) return;
        setTxflow("down");
        txTimer = window.setTimeout(connectTx, txRetry);
        txRetry = Math.min(txRetry * 2, 20_000);
      };
    };

    connectRisex();
    connectTx();

    return () => {
      stopped = true;
      if (flushTimer) window.clearTimeout(flushTimer);
      if (riseWatch) window.clearTimeout(riseWatch);
      if (txWatch) window.clearTimeout(txWatch);
      if (riseTimer) window.clearTimeout(riseTimer);
      if (txTimer) window.clearTimeout(txTimer);
      riseSocket?.close();
      txSocket?.close();
    };
  }, [active]);

  return { overrides, risex: risexStatus, txflow: txflowStatus };
}

export function useTickerBackfill(ids: string[], enabled: boolean): Record<string, QuoteOverride> {
  const [map, setMap] = useState<Record<string, QuoteOverride>>({});
  const tried = useRef(new Map<string, number>());
  const fails = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const key = enabled ? [...ids].sort().join(",") : "";

  useEffect(() => {
    if (!key) return;
    const pending = key.split(",").filter((id) => Date.now() - (tried.current.get(id) ?? 0) > 30_000);
    if (pending.length === 0) return;
    let cancel = false;

    const run = async () => {
      for (let index = 0; index < pending.length; index += 20) {
        if (cancel) return;
        const chunk = pending.slice(index, index + 20);
        const stamp = Date.now();
        for (const id of chunk) tried.current.set(id, stamp);
        try {
          const response = await fetch(`/api/txflow/tickers?ids=${chunk.join(",")}`, { cache: "no-store" });
          if (cancel) return;
          if (!response.ok) throw new Error("tickers");
          const body = (await response.json()) as { quotes?: TickerQuote[] };
          if (!Array.isArray(body.quotes)) return;
          const at = Date.now();
          fails.current = 0;
          setMap((prev) => {
            const next = { ...prev };
            for (const quote of body.quotes ?? []) next[`txflow:${quote.id}`] = overrideFromTicker(quote, at);
            return next;
          });
        } catch {
          for (const id of chunk) tried.current.delete(id);
          fails.current += 1;
          if (!cancel && fails.current < 3) {
            window.setTimeout(() => setAttempt((value) => value + 1), 5_000);
          }
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    };

    void run();
    return () => {
      cancel = true;
    };
  }, [key, attempt]);

  return map;
}
