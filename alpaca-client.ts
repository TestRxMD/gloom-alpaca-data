/**
 * The Alpaca REST endpoints the provider reads, through the host's `httpFetch`
 * so the same code runs in the terminal, the desktop view and the web app.
 */
import { httpFetch } from "gloomberb/utils";
import type { AlpacaCredentials, CredentialStore } from "./credentials";
import type { AlpacaOptionContract, AlpacaOptionSnapshot } from "./options";
import type { AlpacaBar, AlpacaSnapshot } from "./quotes";
import type { AlpacaClock } from "./session";

export const DATA_BASE_URL = "https://data.alpaca.markets";
export const PAPER_TRADING_BASE_URL = "https://paper-api.alpaca.markets";
export const LIVE_TRADING_BASE_URL = "https://api.alpaca.markets";
export const STREAM_URL = "wss://stream.data.alpaca.markets/v2/iex";

/** Free accounts read the IEX feed in real time; SIP is 15 minutes behind there. */
export const STOCK_FEED = "iex";
export const OPTIONS_FEED = "indicative";

const REQUEST_TIMEOUT_MS = 20_000;
const BARS_PAGE_LIMIT = 10_000;
const OPTION_CONTRACTS_PAGE_LIMIT = 10_000;
const OPTION_SNAPSHOTS_PAGE_LIMIT = 1_000;

export interface AlpacaAsset {
  id: string;
  class: string;
  exchange: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  attributes?: string[];
}

export class AlpacaApiError extends Error {
  constructor(message: string, readonly status: number, readonly url: string) {
    super(message);
    this.name = "AlpacaApiError";
  }
}

export class MissingCredentialsError extends Error {
  constructor() {
    super("Alpaca Market Data needs an API key pair: set it up in the Plugins pane.");
    this.name = "MissingCredentialsError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type Params = Record<string, string | number | boolean | undefined | null>;

function query(params: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function requestSignal(signal?: AbortSignal): AbortSignal | undefined {
  const timeout = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
  if (signal && timeout && "any" in AbortSignal) return AbortSignal.any([signal, timeout]);
  return signal ?? timeout;
}

export function tradingBaseUrl(credentials: AlpacaCredentials): string {
  return credentials.keyType === "live" ? LIVE_TRADING_BASE_URL : PAPER_TRADING_BASE_URL;
}

export class AlpacaClient {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly fetchImpl: FetchLike = httpFetch,
  ) {}

  async requireCredentials(): Promise<AlpacaCredentials> {
    const credentials = await this.credentials.resolve();
    if (!credentials) throw new MissingCredentialsError();
    return credentials;
  }

  private async request<T>(url: string, credentials: AlpacaCredentials, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "APCA-API-KEY-ID": credentials.keyId,
        "APCA-API-SECRET-KEY": credentials.secretKey,
      },
      signal: requestSignal(signal),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json() as { message?: string };
        detail = typeof body?.message === "string" ? body.message : "";
      } catch {
        // No JSON body; the status is the message.
      }
      const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
      const reason = response.status === 401 || response.status === 403
        ? "Alpaca rejected the API key pair"
        : response.status === 429
          ? "Alpaca rate limit reached"
          : `Alpaca answered ${response.status}`;
      throw new AlpacaApiError(`${reason} for ${path}${detail ? `: ${detail}` : ""}`, response.status, url);
    }
    return await response.json() as T;
  }

  private async data<T>(path: string, params: Params, signal?: AbortSignal): Promise<T> {
    const credentials = await this.requireCredentials();
    return this.request<T>(`${DATA_BASE_URL}${path}${query(params)}`, credentials, signal);
  }

  private async trading<T>(path: string, params: Params, signal?: AbortSignal): Promise<T> {
    const credentials = await this.requireCredentials();
    return this.request<T>(`${tradingBaseUrl(credentials)}${path}${query(params)}`, credentials, signal);
  }

  /** Latest trade, quote, minute bar and the two latest daily bars per symbol. Unknown symbols are left out. */
  async snapshots(symbols: readonly string[], signal?: AbortSignal): Promise<Record<string, AlpacaSnapshot>> {
    if (symbols.length === 0) return {};
    return this.data<Record<string, AlpacaSnapshot>>("/v2/stocks/snapshots", {
      symbols: symbols.join(","),
      feed: STOCK_FEED,
    }, signal);
  }

  /** Split-adjusted bars from `start` to `end` (now when absent), oldest first, every page. */
  async bars(symbol: string, timeframe: string, start: Date, end?: Date, signal?: AbortSignal): Promise<AlpacaBar[]> {
    const bars: AlpacaBar[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.data<{ bars: AlpacaBar[] | null; next_page_token: string | null }>(
        `/v2/stocks/${encodeURIComponent(symbol)}/bars`,
        {
          timeframe,
          start: start.toISOString(),
          end: end?.toISOString(),
          limit: BARS_PAGE_LIMIT,
          adjustment: "split",
          feed: STOCK_FEED,
          sort: "asc",
          page_token: pageToken,
        },
        signal,
      );
      if (page.bars) bars.push(...page.bars);
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return bars;
  }

  /** The asset record behind a symbol, or null when Alpaca lists none. */
  async asset(symbol: string, signal?: AbortSignal): Promise<AlpacaAsset | null> {
    try {
      return await this.trading<AlpacaAsset>(`/v2/assets/${encodeURIComponent(symbol)}`, {}, signal);
    } catch (error) {
      if (error instanceof AlpacaApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** Every active US equity Alpaca lists; several megabytes, so callers cache it. */
  async assets(signal?: AbortSignal): Promise<AlpacaAsset[]> {
    return this.trading<AlpacaAsset[]>("/v2/assets", { status: "active", asset_class: "us_equity" }, signal);
  }

  async clock(signal?: AbortSignal): Promise<AlpacaClock> {
    return this.trading<AlpacaClock>("/v2/clock", {}, signal);
  }

  /** Active contracts on an underlying, every page; optionally one expiry, or every expiry from a date on. */
  async optionContracts(
    underlying: string,
    options: { expirationDate?: string; expirationFrom?: string } = {},
    signal?: AbortSignal,
  ): Promise<AlpacaOptionContract[]> {
    const contracts: AlpacaOptionContract[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.trading<{ option_contracts: AlpacaOptionContract[] | null; next_page_token: string | null }>(
        "/v2/options/contracts",
        {
          underlying_symbols: underlying,
          status: "active",
          expiration_date: options.expirationDate,
          expiration_date_gte: options.expirationDate ? undefined : options.expirationFrom,
          limit: OPTION_CONTRACTS_PAGE_LIMIT,
          page_token: pageToken,
        },
        signal,
      );
      if (page.option_contracts) contracts.push(...page.option_contracts);
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return contracts;
  }

  /** Snapshots for every contract of one expiry, keyed by OCC symbol. */
  async optionSnapshots(underlying: string, expirationDate: string, signal?: AbortSignal): Promise<Record<string, AlpacaOptionSnapshot>> {
    const snapshots: Record<string, AlpacaOptionSnapshot> = {};
    let pageToken: string | undefined;
    do {
      const page = await this.data<{ snapshots: Record<string, AlpacaOptionSnapshot> | null; next_page_token: string | null }>(
        `/v1beta1/options/snapshots/${encodeURIComponent(underlying)}`,
        {
          feed: OPTIONS_FEED,
          expiration_date: expirationDate,
          limit: OPTION_SNAPSHOTS_PAGE_LIMIT,
          page_token: pageToken,
        },
        signal,
      );
      Object.assign(snapshots, page.snapshots ?? {});
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return snapshots;
  }
}
