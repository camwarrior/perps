// One-off check: DefiLlama daily perp volume against each venue's own candles, per closed UTC day.
const DAY = 86_400_000;
const DAYS = 15;
const today = Math.floor(Date.now() / DAY) * DAY;
const from = today - DAYS * DAY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => (v == null ? "—" : (v / 1e6).toFixed(2) + "M");
const day = (t) => new Date(t).toISOString().slice(0, 10);

async function get(url, init = {}, tries = 6) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { ...init, headers: { accept: "application/json", "user-agent": "perps-verify/1.0", ...(init.headers || {}) } });
    if ((res.status === 429 || res.status >= 500) && i < tries) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800 * 2 ** i);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${url} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// DefiLlama
async function llama(slug) {
  for (const path of [`summary/derivatives/${slug}`, `summary/perps/${slug}`]) {
    try {
      const j = await get(`https://api.llama.fi/${path}?excludeTotalDataChartBreakdown=true`);
      const chart = j.totalDataChart || [];
      console.log(`DefiLlama ${path}: name=${j.name} total24h=${fmt(j.total24h)} points=${chart.length} last=${chart.length ? day(chart.at(-1)[0] * 1000) : "—"}`);
      return new Map(chart.map(([s, v]) => [s * 1000, Number(v)]));
    } catch (e) { console.log(`DefiLlama ${path}: ${e.message.slice(0, 160)}`); }
  }
  return new Map();
}

// RISEx candles, every active market
async function risex() {
  const m = await get("https://api.rise.trade/v1/markets");
  const markets = (m.data?.markets || []).filter((x) => x.active === true);
  console.log(`RISEx active markets: ${markets.length}; sum quote_volume_24h=${fmt(markets.reduce((s, x) => s + Number(x.quote_volume_24h || 0), 0))}`);
  const sums = new Map(); let failed = 0; let shown = false;
  await pool(markets, 4, async (mk) => {
    try {
      const j = await get(`https://api.rise.trade/v1/markets/id/${mk.market_id}/trading-view-data?interval=86400000000000&from=${from}000000&to=${Date.now()}000000`);
      const rows = Array.isArray(j.data) ? j.data : j.data?.data || [];
      if (!shown && rows[0]) { shown = true; console.log("RISEx candle keys:", Object.keys(rows[0]).join(",")); }
      for (const r of rows) {
        const t = Number(String(r.time).length > 13 ? Number(r.time) / 1e6 : r.time);
        const v = Number(r.volume) * Number(r.close);
        if (Number.isFinite(t) && Number.isFinite(v)) sums.set(t, (sums.get(t) || 0) + v);
      }
    } catch { failed++; }
  });
  console.log(`RISEx candle fetch failures: ${failed}`);
  try { const s = await get("https://api.rise.trade/v1/stats/volume"); console.log("RISEx /v1/stats/volume:", JSON.stringify(s).slice(0, 600)); } catch (e) { console.log("RISEx /v1/stats/volume:", e.message.slice(0, 160)); }
  return sums;
}

// Txflow candles, every listed perp
async function txflow() {
  const H = { method: "POST", headers: { "content-type": "application/json", "x-api-version": "2026-08-16" } };
  const meta = await get("https://rpc.txflow.com/info", { ...H, body: JSON.stringify({ type: "perpMeta", includeDelisted: false }) });
  const uni = (meta.data?.universe || []).filter((u) => !u.delisted && !u.haltTrading);
  let web24 = null;
  try {
    const w = await get("https://rpc.txflow.com/info", { ...H, body: JSON.stringify({ type: "webData2", user: "0x0000000000000000000000000000000000000000" }) });
    const rows = w.data?.assetCtxs || [];
    web24 = rows.reduce((s, r) => s + Number(r.dayNtlVlm || 0), 0);
    const vols = rows.map((r) => Number(r.dayNtlVlm || 0)).filter((v) => v > 0).sort((a, b) => b - a);
    const tot = vols.reduce((a, b) => a + b, 0); let acc = 0; const need = {};
    vols.forEach((v, i) => { acc += v; for (const p of [0.9, 0.95, 0.99, 0.995, 0.999]) if (!need[p] && acc / tot >= p) need[p] = i + 1; });
    console.log(`Txflow webData2: ${rows.length} rows, ${vols.length} with volume, sum dayNtlVlm=${fmt(web24)}; perps needed for 90/95/99/99.5/99.9 %: ${[0.9, 0.95, 0.99, 0.995, 0.999].map((p) => need[p]).join("/")}`);
  } catch (e) { console.log("Txflow webData2:", e.message.slice(0, 160)); }
  console.log(`Txflow listed perps: ${uni.length}`);
  const sums = new Map(); let failed = 0; let shown = false;
  await pool(uni, 2, async (u) => {
    try {
      const j = await get("https://rpc.txflow.com/info", { ...H, body: JSON.stringify({ type: "candleSnapshot", req: { coin: u.baseCurrency, interval: "1d", startTime: from, endTime: Date.now() } }) });
      const rows = j.data || [];
      if (!shown && rows[0]) { shown = true; console.log("Txflow candle keys:", Object.keys(rows[0]).join(",")); }
      for (const r of rows) { const t = Number(r.t); const v = Number(r.v) * Number(r.c); if (Number.isFinite(t) && Number.isFinite(v)) sums.set(t, (sums.get(t) || 0) + v); }
      await sleep(150);
    } catch { failed++; }
  });
  console.log(`Txflow candle fetch failures: ${failed}`);
  return sums;
}

function compare(name, ll, candles) {
  console.log(`\n${name}: closed UTC day | DefiLlama | venue candles (vol × close) | DefiLlama ÷ candles`);
  const ratios = [];
  for (let t = from; t < today; t += DAY) {
    const a = ll.get(t), b = candles.get(t);
    const r = a != null && b ? a / b : null; if (r) ratios.push(r);
    console.log(`  ${day(t)} | ${fmt(a)} | ${fmt(b)} | ${r ? r.toFixed(3) : "—"}`);
  }
  if (ratios.length) {
    const s = ratios.toSorted((x, y) => x - y);
    console.log(`  ${name} ratio median ${s[Math.floor(s.length / 2)].toFixed(3)}, min ${s[0].toFixed(3)}, max ${s.at(-1).toFixed(3)}`);
  }
}

const [llR, llT] = [await llama("risex"), await llama("txflow-perps")];
const rx = await risex();
compare("RISEx", llR, rx);
const tx = await txflow();
compare("Txflow", llT, tx);
