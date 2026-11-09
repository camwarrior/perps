# PERPS

Libro de métricas en vivo para perpetuos de RISEx (rise.trade) y Txflow. Solo lectura: no opera, no conecta wallet y no usa secretos.

La interfaz está en español (Chile). Los números van en formato de mesa (agrupación con coma, decimales con punto) y la hora en `America/Santiago`.

## Diseño

Fondo pizarra, una sola familia (Archivo, autoalojada con su eje de ancho), y dos colores de identidad que solo marcan venue: ámbar para RISEx y azul para Txflow, validados como par para daltonismo. Arriba, RISEx contra Txflow con una barra dividida por métrica. Debajo, cuatro pestañas: Libro (un venue a la vez), Comparar (mismo símbolo en ambos), Series y Wallet. En el teléfono el libro es una lista de dos líneas por mercado y la página no tiene scroll lateral.

## Correr en local

```bash
npm i
npm run dev
```

Abrir http://localhost:3000.

`npm test` corre los parsers. `npm run build` deja el sitio listo para producción.

## Cómo se actualizan los datos

El navegador no llama a los exchanges. Todo pasa por rutas `/api/*` del mismo origen, para evitar CORS. Las APIs son públicas y no piden llave.

- Al cargar, el servidor arma un snapshot y lo manda en el HTML.
- El cliente vuelve a pedir `GET /api/snapshot` cada 10 segundos.
- Si la pestaña queda oculta, el refresco se pausa. Al volver, pide un snapshot de inmediato.
- Hay una caché en memoria de unos 8 segundos para no repetir el mismo upstream en ráfaga.
- Con la pestaña visible, el cliente abre los websocket públicos y actualiza mark (y en Txflow también último, oracle, OI y funding) entre sondeos. Si el socket no abre, el libro sigue con el sondeo de 10 segundos.

RISEx: `GET https://api.rise.trade/v1/markets`. El volumen 24h del venue es la suma de `quote_volume_24h`. No se usa `/v1/stats/volume`. El cambio porcentual se calcula como `change_24h / (last_price - change_24h)`. El websocket `wss://ws.rise.trade/ws` (canal público `oracle`) refresca mark e índice; esos precios vienen en wei y se dividen por 10^18.

Txflow, solo mainnet (`https://rpc.txflow.com/info`, header `x-api-version: 2026-08-16`):

- `perpMeta` resuelve el universo de perpetuos (`BTC-USDC`, etc.).
- `webData2` trae último, máximo, mínimo, precio previo y volumen 24h. OI, mark y oracle vienen vacíos en ese payload: se muestran como "—" y no se inventan.
- Un websocket corto a `wss://rpc.txflow.com/ws` (`allAssetCtxs`) llena mark, oracle, interés abierto y funding de todo el libro.
- Si ese socket falla, `marketTicker` cubre los 20 mercados de mayor volumen. El resto del libro, al pedir "Todos" o la comparación, se completa de a 20 con `GET /api/txflow/tickers`.

No se usa testnet.

## Series de venue

La pestaña Series muestra dos gráficos: volumen diario y OI al cierre diario, con RISEx (ámbar) y Txflow (azul) en el mismo eje. Las temporalidades son `1S`, `1M`, `3M`, `1A` y `ALL`. Hasta 45 días se dibujan columnas pareadas por día; con más días, dos líneas. Al pasar el mouse o tocar, un tooltip muestra el día y el valor de cada venue, y "Ver datos" abre la tabla completa.

Todas las temporalidades usan días UTC. El volumen cerrado hasta el 2026-11-08 es el notional diario de DefiLlama (`data/defillama-volume-history.json`), sin volver a calcularlo y sin multiplicarlo por 2. Cada día UTC que ya cerró y no está en esa semilla se calcula una vez con todos los mercados (RISEx: `trading-view-data`, volumen base × cierre; Txflow: `candleSnapshot` de cada perp, sin tope) y queda guardado. El día en curso se calcula igual, en vivo, y no se guarda como cierre. El OI no cambia. Al pasar el mouse, cada barra muestra su marca de tiempo y su valor.

El OI histórico no lo publica el venue. Los gráficos usan el diario de DefiLlama (`overview/open-interest`) multiplicado por 2, en USD, para la convención de dos lados (largo + corto) que publican el tablero y Dune. DefiLlama guarda la mitad. Es un cierre diario UTC, no el OI en vivo. Si una ventana no tiene puntos, el recuadro queda vacío con la razón.

## Wallet en la semana UTC

En la pestaña Wallet hay un campo para pegar una dirección `0x`. La consulta corre al pedirla y no se guarda.

La ventana es el lunes 00:00:00.000 UTC hasta el lunes siguiente 00:00:00.000 UTC, sin incluir ese instante. No es la hora de Chile ni un rodado de 7 días.

- RISEx: `GET /v1/stats/user-volume` con `start_time` y `end_time` en nanosegundos. El volumen es `total_volume`, notional USDC de trades y liquidaciones.
- Txflow: suma de `|precio × tamaño|` de `userFills` de perpetuos en esa ventana. Si hay más de 4.000 fills, el volumen queda en "—" para no presentar una suma incompleta.
- El OI que se muestra es el promedio de 7 días, no el de la semana UTC. En RISEx es `d7.market_exposure` de `GET /v1/portfolio/header`: promedio ponderado en el tiempo, notional USD. No se usan 24h, 30d ni all-time. Txflow no publica un OI promedio de 7 días (`userOverview` 7D trae PnL, volumen y equity; el nocional abierto es un snapshot), así que esa celda queda en "—". El total de volumen aparece solo cuando ambas fuentes traen notional USDC completo.

## Campos que no están

- Txflow no publica una tasa de funding a 8 horas. Esa columna queda en "—". La tasa que sí viene es la del intervalo de liquidación (hoy 1 hora) y se etiqueta `1h`. En la API ya está en porcentaje (`0.00125` = 0.00125%).
- RISEx `current_funding_rate` es una fracción por intervalo (1h, `funding_interval` en nanosegundos). Se muestra × 100, en porcentaje. `funding_rate_8h` es la tasa a 8 horas, también pasada a porcentaje.
- El interés abierto en USDC es `open interest en base × mark`. Si falta el mark, el nocional queda en "—" aunque exista el OI en base.
- Un venue caído muestra su error y el otro sigue en pantalla.

## Indexación

El sitio no debe indexarse.

- `app/robots.ts` responde `User-agent: *` / `Disallow: /`. No hay sitemap.
- Meta robots: `noindex, nofollow, noarchive, nosnippet`.
- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` en `next.config.ts` y `vercel.json`.

No hay Open Graph.

## Vercel

1. Importar este repositorio de GitHub.
2. Framework Preset: Next.js. El comando de build es `npm run build`.
3. No hace falta variable de entorno ni secreto.
4. Deploy.

Node 20.9 o superior. El runtime es Node.js (Fluid Compute); no hace falta un servidor de websocket propio.
