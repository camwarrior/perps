import "server-only";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FetchInit = RequestInit & { timeoutMs?: number; retries?: number };

/**
 * JSON fetch with a timeout. With `retries`, a 429 or 5xx is retried after Retry-After,
 * or after 0.8 s, 1.6 s, 3.2 s… with jitter, so a burst does not keep hitting the limit.
 */
export async function fetchJson(url: string, init: FetchInit = {}): Promise<unknown> {
  const { retries = 0, ...rest } = init;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchOnce(url, rest);
    } catch (error) {
      const retryable = error instanceof HttpError && (error.status === 429 || error.status >= 500);
      if (!retryable || attempt >= retries) throw error;
      const wait = error.retryAfterMs ?? 800 * 2 ** attempt * (0.75 + Math.random() * 0.5);
      await sleep(Math.min(wait, 8_000));
    }
  }
}

async function fetchOnce(url: string, init: RequestInit & { timeoutMs?: number }): Promise<unknown> {
  const { timeoutMs = 8_000, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: {
        accept: "application/json",
        "user-agent": "perps-dashboard/1.0",
        ...(rest.headers ?? {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("timeout");
    }
    throw new Error("sin respuesta");
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text.slice(0, 180);
    }
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `HTTP ${response.status}`;
    throw new HttpError(message, response.status, retryAfter(response.headers.get("retry-after")));
  }
  return body;
}
