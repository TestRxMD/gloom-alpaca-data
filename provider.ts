/**
 * The `asset-data` provider: Alpaca Market Data as Gloomberb sees it.
 *
 * Priority 5 puts it ahead of Gloom Cloud for every ticker it says it can
 * provide, which is a US-listed equity or ETF Alpaca knows. The router sorts a
 * source by the lowest priority among its capabilities, and Gloom Cloud's news
 * capability is registered at 10 (its market provider alone says 100), so a
 * market provider has to sit below 10 to be asked first. Everything this one
 * declines, and everything it has no method for (fundamentals, filings, news,
 * FX), the router takes from the next provider.
 */
import type {
  AssetDataProvider,
  MarketDataRequestContext,
  QuoteBatchOptions,
  QuoteBatchResult,
  QuoteSubscriptionTarget,
  SearchRequestContext,
} from "gloomberb/types/data-provider";
import type { OptionsChain, PricePoint, Quote, TickerFinancials } from "gloomberb/types/financials";
import type { InstrumentSearchResult } from "gloomberb/types/instrument";
import type { ChartResolutionSupport, ManualChartResolution, TimeRange } from "gloomberb/time-series";

/** The host does not export its price-history module; the type is the method's own return type. */
type PriceHistoryResult = Awaited<ReturnType<NonNullable<AssetDataProvider["getPriceHistoryWithMetadata"]>>>;
import { AlpacaClient, type AlpacaAsset } from "./alpaca-client";
import {
  barsToPricePoints,
  CHART_RESOLUTION_SUPPORT,
  isIntraday,
  rangeStart,
  RESOLUTION_BY_RANGE,
  resolutionForBarSize,
  TIMEFRAME_BY_RESOLUTION,
} from "./bars";
import type { CredentialStore } from "./credentials";
import { buildOptionsChain, chooseExpiry, expiryIsoDate, listedExpiries } from "./options";
import { ALPACA_PROVIDER_ID, applyStreamQuote, applyStreamTrade, snapshotToQuote, type StreamQuote, type StreamTrade } from "./quotes";
import { marketStateAt, newYorkDate, type AlpacaClock } from "./session";
import { AlpacaIexStream, hasWebSocket, type StreamLogger } from "./stream";
import { gloomExchangeFor, looksLikeUsEquity, parseTicker, type ParsedTicker } from "./symbols";

const ASSET_CACHE_TTL_MS = 6 * 60 * 60_000;
const ASSET_MISS_TTL_MS = 10 * 60_000;
const ASSET_LIST_TTL_MS = 60 * 60_000;
const CLOCK_TTL_MS = 60_000;
/** Snapshot symbols per request; keeps the URL short of any proxy's limit. */
const SNAPSHOT_BATCH_SIZE = 100;
/** How often streamed quotes are re-seeded from a snapshot, which also moves them across session boundaries. */
const STREAM_RESEED_MS = 60_000;
const POLL_FALLBACK_MS = 10_000;
/**
 * A stream this much quieter than the snapshots is dead. Alpaca sends no
 * heartbeat, so a socket left half-open by a network change looks exactly like
 * a quiet market; the snapshot's latest trade tells the two apart.
 */
const STALE_STREAM_MS = 45_000;
const DEFAULT_SEARCH_LIMIT = 10;

interface CacheEntry<T> {
  at: number;
  value: T;
}

interface SymbolSubscription {
  listeners: Set<(quote: Quote) => void>;
  release: () => void;
}

export interface ProviderOptions {
  /** How often streamed symbols are re-seeded from a snapshot. */
  reseedMs?: number;
  /** How far the snapshot's latest trade may run ahead of the stream's last message before the stream is reopened. */
  staleStreamMs?: number;
}

/** A miss the router keeps quiet about: its message matches the host's expected-miss pattern. */
function notProvided(ticker: string): Error {
  return new Error(`No data found for ${ticker} on Alpaca Market Data`);
}

export class AlpacaProvider implements AssetDataProvider {
  readonly id = ALPACA_PROVIDER_ID;
  readonly name = "Alpaca Market Data";
  readonly priority = 5;

  private readonly client: AlpacaClient;
  private readonly assetCache = new Map<string, CacheEntry<AlpacaAsset | null>>();
  private assetListCache: CacheEntry<AlpacaAsset[]> | null = null;
  private assetListPending: Promise<AlpacaAsset[]> | null = null;
  private clockCache: CacheEntry<AlpacaClock | null> | null = null;
  private log: StreamLogger | null = null;

  private stream: AlpacaIexStream | null = null;
  private readonly subscriptions = new Map<string, SymbolSubscription>();
  private readonly lastQuotes = new Map<string, Quote>();
  private reseedTimer: ReturnType<typeof setInterval> | null = null;
  private readonly reseedMs: number;
  private readonly staleStreamMs: number;

  constructor(private readonly credentials: CredentialStore, client?: AlpacaClient, options?: ProviderOptions) {
    this.client = client ?? new AlpacaClient(credentials);
    this.reseedMs = options?.reseedMs ?? STREAM_RESEED_MS;
    this.staleStreamMs = options?.staleStreamMs ?? STALE_STREAM_MS;
  }

  setLogger(log: StreamLogger | null): void {
    this.log = log;
  }

  /** The keys changed: forget what was learned with the old pair. */
  credentialsChanged(): void {
    this.assetCache.clear();
    this.assetListCache = null;
    this.clockCache = null;
    this.stream?.resetAuthFailure();
  }

  // ---- Listing -----------------------------------------------------------

  private async asset(parsed: ParsedTicker): Promise<AlpacaAsset | null> {
    const cached = this.assetCache.get(parsed.symbol);
    const now = Date.now();
    if (cached && now - cached.at < (cached.value ? ASSET_CACHE_TTL_MS : ASSET_MISS_TTL_MS)) return cached.value;
    const asset = await this.client.asset(parsed.symbol);
    this.assetCache.set(parsed.symbol, { at: now, value: asset });
    return asset;
  }

  private isServed(asset: AlpacaAsset | null, parsed: ParsedTicker): asset is AlpacaAsset {
    if (!asset || asset.status !== "active" || asset.class !== "us_equity") return false;
    const venue = asset.exchange?.toUpperCase();
    if (venue === "OTC") return false;
    if (parsed.exchange && venue !== parsed.exchange) return false;
    return true;
  }

  /** The asset when Alpaca serves this ticker, null otherwise. Never throws for a ticker it cannot know. */
  private async served(ticker: string, exchange?: string): Promise<{ parsed: ParsedTicker; asset: AlpacaAsset } | null> {
    const parsed = parseTicker(ticker, exchange);
    if (!looksLikeUsEquity(parsed)) return null;
    if (!(await this.credentials.resolve())) return null;
    const asset = await this.asset(parsed);
    return this.isServed(asset, parsed) ? { parsed, asset } : null;
  }

  async canProvide(ticker: string, exchange?: string, _context?: MarketDataRequestContext): Promise<boolean> {
    try {
      return (await this.served(ticker, exchange)) != null;
    } catch (error) {
      this.log?.warn(`Alpaca: could not look up ${ticker}: ${String(error)}`);
      return false;
    }
  }

  private async clock(): Promise<AlpacaClock | null> {
    const now = Date.now();
    if (this.clockCache && now - this.clockCache.at < CLOCK_TTL_MS) return this.clockCache.value;
    let value: AlpacaClock | null = null;
    try {
      value = await this.client.clock();
    } catch {
      value = null;
    }
    this.clockCache = { at: now, value };
    return value;
  }

  // ---- Quotes ------------------------------------------------------------

  async getQuote(ticker: string, exchange?: string, _context?: MarketDataRequestContext): Promise<Quote> {
    const served = await this.served(ticker, exchange);
    if (!served) throw notProvided(ticker);
    const [snapshots, clock] = await Promise.all([this.client.snapshots([served.parsed.symbol]), this.clock()]);
    const snapshot = snapshots[served.parsed.symbol];
    const now = Date.now();
    const quote = snapshot ? snapshotToQuote({
      symbol: served.parsed.requested,
      snapshot,
      now,
      marketState: marketStateAt(now, clock),
      listing: { name: served.asset.name, listingExchange: gloomExchangeFor(served.asset.exchange) },
    }) : null;
    if (!quote) throw notProvided(ticker);
    return quote;
  }

  async getQuotesBatch(targets: QuoteSubscriptionTarget[], options?: QuoteBatchOptions): Promise<QuoteBatchResult[]> {
    if (options?.cacheOnly) return targets.map((target) => ({ target, quote: null }));
    const resolved = await Promise.all(targets.map(async (target) => ({
      target,
      served: await this.served(target.symbol, target.exchange).catch(() => null),
    })));
    const symbols = [...new Set(resolved.flatMap((entry) => entry.served ? [entry.served.parsed.symbol] : []))];
    if (symbols.length === 0) return resolved.map(({ target }) => ({ target, quote: null }));
    const [snapshots, clock] = await Promise.all([this.snapshotsInBatches(symbols, options?.signal), this.clock()]);
    const now = Date.now();
    const marketState = marketStateAt(now, clock);
    return resolved.map(({ target, served }) => {
      if (!served) return { target, quote: null };
      const snapshot = snapshots[served.parsed.symbol];
      const quote = snapshot ? snapshotToQuote({
        symbol: served.parsed.requested,
        snapshot,
        now,
        marketState,
        listing: { name: served.asset.name, listingExchange: gloomExchangeFor(served.asset.exchange) },
      }) : null;
      return { target, quote };
    });
  }

  private async snapshotsInBatches(symbols: string[], signal?: AbortSignal) {
    const pages = [];
    for (let index = 0; index < symbols.length; index += SNAPSHOT_BATCH_SIZE) {
      pages.push(this.client.snapshots(symbols.slice(index, index + SNAPSHOT_BATCH_SIZE), signal));
    }
    return Object.assign({}, ...(await Promise.all(pages))) as Awaited<ReturnType<AlpacaClient["snapshots"]>>;
  }

  // ---- Streaming ---------------------------------------------------------

  subscribeQuotes(targets: QuoteSubscriptionTarget[], onQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void): () => void {
    const bySymbol = new Map<string, QuoteSubscriptionTarget[]>();
    for (const target of targets) {
      const parsed = parseTicker(target.symbol, target.exchange);
      if (!looksLikeUsEquity(parsed)) continue;
      const bucket = bySymbol.get(parsed.symbol) ?? [];
      bucket.push(target);
      bySymbol.set(parsed.symbol, bucket);
    }
    if (bySymbol.size === 0) return () => {};

    const listeners = new Map<string, (quote: Quote) => void>();
    for (const [symbol, symbolTargets] of bySymbol) {
      const listener = (quote: Quote) => {
        for (const target of symbolTargets) onQuote(target, { ...quote, symbol: parseTicker(target.symbol, target.exchange).requested });
      };
      listeners.set(symbol, listener);
      this.addSymbolListener(symbol, listener);
    }

    void this.seedStream(targets);

    return () => {
      for (const [symbol, listener] of listeners) this.removeSymbolListener(symbol, listener);
    };
  }

  private ensureStream(): AlpacaIexStream {
    if (!this.stream) {
      this.stream = new AlpacaIexStream(this.credentials, {
        onTrade: (trade) => this.onStreamTrade(trade),
        onQuote: (quote) => this.onStreamQuote(quote),
      }, this.log ?? undefined);
    }
    return this.stream;
  }

  private addSymbolListener(symbol: string, listener: (quote: Quote) => void): void {
    let subscription = this.subscriptions.get(symbol);
    if (!subscription) {
      subscription = { listeners: new Set(), release: this.ensureStream().subscribe([symbol]) };
      this.subscriptions.set(symbol, subscription);
    }
    subscription.listeners.add(listener);
    const last = this.lastQuotes.get(symbol);
    if (last) listener(last);
    this.startReseeding();
  }

  private removeSymbolListener(symbol: string, listener: (quote: Quote) => void): void {
    const subscription = this.subscriptions.get(symbol);
    if (!subscription) return;
    subscription.listeners.delete(listener);
    if (subscription.listeners.size > 0) return;
    subscription.release();
    this.subscriptions.delete(symbol);
    this.lastQuotes.delete(symbol);
    if (this.subscriptions.size === 0) this.stopReseeding();
  }

  private emit(symbol: string, quote: Quote): void {
    this.lastQuotes.set(symbol, quote);
    const subscription = this.subscriptions.get(symbol);
    if (!subscription) return;
    for (const listener of subscription.listeners) listener(quote);
  }

  private onStreamTrade(trade: StreamTrade): void {
    const symbol = trade.S?.toUpperCase();
    const current = symbol ? this.lastQuotes.get(symbol) : undefined;
    if (!symbol || !current) return;
    const next = applyStreamTrade(current, trade, Date.now());
    if (next) this.emit(symbol, next);
  }

  private onStreamQuote(update: StreamQuote): void {
    const symbol = update.S?.toUpperCase();
    const current = symbol ? this.lastQuotes.get(symbol) : undefined;
    if (!symbol || !current) return;
    this.emit(symbol, applyStreamQuote(current, update, Date.now()));
  }

  /** A snapshot per subscribed symbol, so a stream has a quote to apply its trades to. */
  private async seedStream(targets: QuoteSubscriptionTarget[]): Promise<void> {
    try {
      const results = await this.getQuotesBatch(targets);
      let newestTrade: number | undefined;
      for (const result of results) {
        if (!result.quote) continue;
        const symbol = parseTicker(result.target.symbol, result.target.exchange).symbol;
        if (!this.subscriptions.has(symbol)) continue;
        this.emit(symbol, result.quote);
        const printed = result.quote.lastTradeTime ?? result.quote.lastUpdated;
        if (newestTrade == null || printed > newestTrade) newestTrade = printed;
      }
      this.checkStreamLiveness(newestTrade);
    } catch (error) {
      this.log?.warn(`Alpaca: could not seed streamed quotes: ${String(error)}`);
    }
  }

  /** Reopens a stream that has been silent while the snapshots show trades printing. */
  private checkStreamLiveness(newestTradeMs: number | undefined): void {
    const stream = this.stream;
    if (!stream?.isLive || newestTradeMs == null) return;
    const lastMessage = stream.lastMessageAt;
    if (lastMessage == null) return;
    const behind = newestTradeMs - lastMessage;
    if (behind > this.staleStreamMs) stream.reconnect(`silent for ${Math.round(behind / 1000)}s while trades printed`);
  }

  private startReseeding(): void {
    if (this.reseedTimer) return;
    const interval = hasWebSocket() ? this.reseedMs : POLL_FALLBACK_MS;
    this.reseedTimer = setInterval(() => {
      const targets: QuoteSubscriptionTarget[] = [...this.subscriptions.keys()].map((symbol) => ({ symbol }));
      if (targets.length > 0) void this.seedStream(targets);
    }, interval);
  }

  private stopReseeding(): void {
    if (!this.reseedTimer) return;
    clearInterval(this.reseedTimer);
    this.reseedTimer = null;
  }

  dispose(): void {
    this.stopReseeding();
    this.stream?.dispose();
    this.stream = null;
    this.subscriptions.clear();
    this.lastQuotes.clear();
  }

  // ---- Financials, FX, search, articles -----------------------------------

  /** The quote and an empty statement set; the router fills fundamentals from the next provider. */
  async getTickerFinancials(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<TickerFinancials> {
    const quote = await this.getQuote(ticker, exchange, context);
    return {
      quote,
      financialCurrency: "USD",
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [],
    };
  }

  async getExchangeRate(fromCurrency: string): Promise<number> {
    if (fromCurrency.trim().toUpperCase() === "USD") return 1;
    throw new Error(`No data found: Alpaca Market Data has no ${fromCurrency} exchange rate`);
  }

  private async assetList(): Promise<AlpacaAsset[]> {
    const now = Date.now();
    if (this.assetListCache && now - this.assetListCache.at < ASSET_LIST_TTL_MS) return this.assetListCache.value;
    if (!this.assetListPending) {
      this.assetListPending = this.client.assets()
        .then((assets) => {
          this.assetListCache = { at: Date.now(), value: assets };
          return assets;
        })
        .finally(() => {
          this.assetListPending = null;
        });
    }
    return this.assetListPending;
  }

  async search(query: string, context?: SearchRequestContext): Promise<InstrumentSearchResult[]> {
    const text = query.trim();
    if (!text || !(await this.credentials.resolve())) return [];
    // A keystroke does not wait for a multi-megabyte catalogue: start loading it and answer the next one.
    if (context?.interactive && !this.assetListCache) {
      void this.assetList().catch(() => {});
      return [];
    }
    const assets = await this.assetList();
    const upper = text.toUpperCase();
    const lower = text.toLowerCase();
    const limit = context?.limit ?? DEFAULT_SEARCH_LIMIT;
    const ranked: Array<{ rank: number; asset: AlpacaAsset }> = [];
    for (const asset of assets) {
      if (asset.status !== "active" || asset.class !== "us_equity") continue;
      const symbol = asset.symbol.toUpperCase();
      const otc = asset.exchange?.toUpperCase() === "OTC";
      let rank: number;
      if (symbol === upper) rank = 0;
      else if (otc) continue;
      else if (symbol.replace(".", "-") === upper.replace(".", "-")) rank = 0;
      else if (symbol.startsWith(upper)) rank = 1;
      else if (asset.name?.toLowerCase().includes(lower)) rank = 2;
      else continue;
      ranked.push({ rank, asset });
    }
    ranked.sort((a, b) => a.rank - b.rank || a.asset.symbol.length - b.asset.symbol.length || a.asset.symbol.localeCompare(b.asset.symbol));
    return ranked.slice(0, limit).map(({ asset }) => ({
      providerId: this.id,
      symbol: asset.symbol,
      name: asset.name,
      exchange: gloomExchangeFor(asset.exchange) ?? asset.exchange,
      primaryExchange: gloomExchangeFor(asset.exchange),
      type: "EQUITY",
      currency: "USD",
    }));
  }

  async getArticleSummary(_url: string): Promise<string | null> {
    return null;
  }

  // ---- History -----------------------------------------------------------

  getChartResolutionSupport(): ChartResolutionSupport[] {
    return CHART_RESOLUTION_SUPPORT;
  }

  async getPriceHistory(ticker: string, exchange: string, range: TimeRange, context?: MarketDataRequestContext): Promise<PricePoint[]> {
    return (await this.getPriceHistoryWithMetadata(ticker, exchange, range, context)).points;
  }

  async getPriceHistoryWithMetadata(ticker: string, exchange: string, range: TimeRange, context?: MarketDataRequestContext): Promise<PriceHistoryResult> {
    return this.getPriceHistoryForResolutionWithMetadata(ticker, exchange, range, RESOLUTION_BY_RANGE[range], context);
  }

  async getPriceHistoryForResolution(
    ticker: string, exchange: string, bufferRange: TimeRange, resolution: ManualChartResolution, context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    return (await this.getPriceHistoryForResolutionWithMetadata(ticker, exchange, bufferRange, resolution, context)).points;
  }

  async getPriceHistoryForResolutionWithMetadata(
    ticker: string, exchange: string, bufferRange: TimeRange, resolution: ManualChartResolution, context?: MarketDataRequestContext,
  ): Promise<PriceHistoryResult> {
    const end = new Date();
    return this.history(ticker, exchange, rangeStart(bufferRange, end), undefined, resolution, context);
  }

  async getDetailedPriceHistory(
    ticker: string, exchange: string, startDate: Date, endDate: Date, barSize: string, context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    return (await this.getDetailedPriceHistoryWithMetadata(ticker, exchange, startDate, endDate, barSize, context)).points;
  }

  async getDetailedPriceHistoryWithMetadata(
    ticker: string, exchange: string, startDate: Date, endDate: Date, barSize: string, context?: MarketDataRequestContext,
  ): Promise<PriceHistoryResult> {
    const resolution = resolutionForBarSize(barSize);
    if (!resolution) throw new Error(`No data found: Alpaca Market Data has no ${barSize} bars`);
    const end = endDate.getTime() > Date.now() ? undefined : endDate;
    return this.history(ticker, exchange, startDate, end, resolution, context);
  }

  private async history(
    ticker: string, exchange: string, start: Date, end: Date | undefined, resolution: ManualChartResolution, context?: MarketDataRequestContext,
  ): Promise<PriceHistoryResult> {
    const served = await this.served(ticker, exchange);
    if (!served) throw notProvided(ticker);
    const extended = context?.historySession === "extended" && isIntraday(resolution);
    const bars = await this.client.bars(served.parsed.symbol, TIMEFRAME_BY_RESOLUTION[resolution], start, end);
    const points = barsToPricePoints(bars, { resolution, now: Date.now(), regularHoursOnly: !extended });
    if (points.length === 0) throw new Error(`No history for ${ticker} on Alpaca Market Data in that window`);
    return {
      points,
      resolution,
      ...(extended ? { extendedHours: true } : {}),
    };
  }

  // ---- Options -----------------------------------------------------------

  async getOptionsChain(ticker: string, exchange?: string, expirationDate?: number, _context?: MarketDataRequestContext): Promise<OptionsChain> {
    const served = await this.served(ticker, exchange);
    if (!served) throw notProvided(ticker);
    const symbol = served.parsed.symbol;
    const requested = expirationDate != null ? expiryIsoDate(expirationDate) : null;
    const today = newYorkDate(Date.now());
    const contracts = await this.client.optionContracts(symbol, { expirationFrom: today });
    const expiry = chooseExpiry(listedExpiries(contracts), requested);
    if (!expiry) throw new Error(`No data found: Alpaca lists no options on ${ticker}`);
    const [snapshots, underlying] = await Promise.all([
      this.client.optionSnapshots(symbol, expiry),
      this.client.snapshots([symbol]).then((result) => result[symbol]?.latestTrade?.p ?? null).catch(() => null),
    ]);
    return buildOptionsChain({
      underlyingSymbol: served.parsed.requested,
      underlyingPrice: underlying,
      contracts,
      snapshots,
      expirationDate: expiry,
      now: Date.now(),
    });
  }
}
