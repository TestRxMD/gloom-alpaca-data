/**
 * Alpaca snapshot and stream messages mapped to Gloomberb quotes.
 *
 * A snapshot carries the latest trade and quote, the current minute bar, the
 * regular-session daily bar of the latest trading day, and the one before it.
 * Daily bars are regular-session bars (their open is the 9:30 print), which
 * is what makes the previous close and the after-hours split below sound.
 */
import type { MarketState, Quote } from "gloomberb/types/financials";
import { isRegularHoursPrint, newYorkDate, newYorkParts, parseTimestamp, REGULAR_CLOSE_MINUTES, REGULAR_OPEN_MINUTES } from "./session";

/** A bid or ask this far from the last price is an empty IEX book, not a market. */
const BOOK_SANITY_RATIO = 0.5;

export const ALPACA_PROVIDER_ID = "alpaca";

export interface AlpacaBar {
  /** Bar open, RFC 3339. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number;
  vw?: number;
}

export interface AlpacaTrade {
  t: string;
  p: number;
  s: number;
  x?: string;
  c?: string[] | string;
  i?: number;
}

export interface AlpacaQuote {
  t: string;
  bp: number;
  bs: number;
  ap: number;
  as: number;
  bx?: string;
  ax?: string;
}

export interface AlpacaSnapshot {
  latestTrade?: AlpacaTrade;
  latestQuote?: AlpacaQuote;
  minuteBar?: AlpacaBar;
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
}

export interface QuoteListing {
  /** Company name from the asset record, when known. */
  name?: string;
  /** Alpaca venue name (NASDAQ, NYSE, ARCA...), already mapped to Gloomberb's spelling. */
  listingExchange?: string;
}

export interface SnapshotQuoteInput {
  /** The symbol the quote answers for, as Gloomberb asked (without venue suffix). */
  symbol: string;
  snapshot: AlpacaSnapshot;
  now: number;
  marketState: MarketState;
  listing?: QuoteListing;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const parseTime = parseTimestamp;

function percent(change: number, reference: number | undefined): number {
  return reference ? (change / reference) * 100 : 0;
}

/** The side of the book, when it is near the price; IEX shows a one-cent bid or an empty ask after hours. */
function bookSide(value: unknown, price: number): number | undefined {
  const side = positive(value);
  if (side == null) return undefined;
  return Math.abs(side - price) <= price * BOOK_SANITY_RATIO ? side : undefined;
}

/**
 * The quote a snapshot describes, or null when it has no price at all (a
 * listing that never traded on IEX, or a symbol Alpaca returned empty).
 */
export function snapshotToQuote(input: SnapshotQuoteInput): Quote | null {
  const { snapshot, now, marketState, listing } = input;
  const trade = snapshot.latestTrade;
  const tradePrice = positive(trade?.p);
  const tradeTime = parseTime(trade?.t);
  const fallbackBar = snapshot.minuteBar ?? snapshot.dailyBar;
  const price = tradePrice ?? positive(fallbackBar?.c);
  if (price == null) return null;
  const lastUpdated = tradePrice != null && tradeTime != null
    ? tradeTime
    : parseTime(fallbackBar?.t) ?? now;

  const daily = snapshot.dailyBar;
  const dailyDate = daily ? newYorkDate(parseTime(daily.t) ?? 0) : null;
  const tradeDate = newYorkDate(lastUpdated);
  const todayDate = newYorkDate(now);
  // The daily bar is the latest regular session with a print. When the latest
  // trade belongs to that session (or to its extended hours), the previous
  // close is the bar before it; a trade from a later day than the daily bar
  // is a pre-market print, and the daily bar's close is its reference.
  const dailyIsTradeDay = dailyDate === tradeDate;
  const previousClose = dailyIsTradeDay
    ? positive(snapshot.prevDailyBar?.c) ?? positive(daily?.c)
    : positive(daily?.c);
  const sessionBar = dailyIsTradeDay ? daily : undefined;

  const tradeMinutes = newYorkParts(lastUpdated).minutes;
  const isToday = tradeDate === todayDate;
  const afterHoursPrint = isToday && marketState === "POST" && tradeMinutes >= REGULAR_CLOSE_MINUTES
    && tradePrice != null && sessionBar != null;
  const preMarketPrint = isToday && marketState === "PRE" && tradeMinutes < REGULAR_OPEN_MINUTES && tradePrice != null;

  // After the close, the quote keeps the regular session's close, move and
  // range, and carries the after-hours print beside it.
  const regularPrice = afterHoursPrint ? positive(sessionBar?.c) ?? price : price;
  const change = previousClose != null ? regularPrice - previousClose : 0;

  const quote: Quote = {
    symbol: input.symbol,
    providerId: ALPACA_PROVIDER_ID,
    price: regularPrice,
    currency: "USD",
    change,
    changePercent: percent(change, previousClose),
    previousClose,
    open: positive(sessionBar?.o),
    high: positive(sessionBar?.h),
    low: positive(sessionBar?.l),
    volume: nonNegative(sessionBar?.v),
    name: listing?.name,
    lastUpdated,
    receivedAt: now,
    delivery: "poll",
    marketState,
    sessionConfidence: "derived",
    listingExchangeName: listing?.listingExchange,
    exchangeName: listing?.listingExchange,
    lastTradePrice: tradePrice,
    lastTradeTime: tradePrice != null ? tradeTime : undefined,
    dataSource: "live",
  };

  const bid = bookSide(snapshot.latestQuote?.bp, price);
  const ask = bookSide(snapshot.latestQuote?.ap, price);
  if (bid != null) {
    quote.bid = bid;
    quote.bidSize = nonNegative(snapshot.latestQuote?.bs);
  }
  if (ask != null) {
    quote.ask = ask;
    quote.askSize = nonNegative(snapshot.latestQuote?.as);
  }

  if (afterHoursPrint && tradePrice != null) {
    const postChange = tradePrice - regularPrice;
    quote.postMarketPrice = tradePrice;
    quote.postMarketChange = postChange;
    quote.postMarketChangePercent = percent(postChange, regularPrice);
    quote.extendedSessionPrint = true;
  } else if (preMarketPrint && tradePrice != null) {
    const preChange = previousClose != null ? tradePrice - previousClose : 0;
    quote.preMarketPrice = tradePrice;
    quote.preMarketChange = preChange;
    quote.preMarketChangePercent = percent(preChange, previousClose);
    quote.extendedSessionPrint = true;
  } else if (marketState === "PRE" || marketState === "POST") {
    quote.extendedSessionPrint = false;
  }

  return stripUndefined(quote);
}

/** A streamed trade: `{"T":"t","S":"AAPL","p":...,"s":...,"t":"..."}`. */
export interface StreamTrade {
  T: "t";
  S: string;
  p: number;
  s: number;
  t: string;
  x?: string;
  c?: string[];
}

/** A streamed top-of-book quote from IEX: `{"T":"q","S":"AAPL","bp":...,"ap":...}`. */
export interface StreamQuote {
  T: "q";
  S: string;
  bp: number;
  bs: number;
  ap: number;
  as: number;
  t: string;
}

/**
 * The quote after a streamed trade. Keeps the session split a snapshot
 * established: a print after the close moves the after-hours price, not the
 * regular close.
 */
export function applyStreamTrade(current: Quote, trade: StreamTrade, now: number): Quote | null {
  const price = positive(trade.p);
  if (price == null) return null;
  const time = parseTime(trade.t) ?? now;
  const next: Quote = { ...current, lastUpdated: time, receivedAt: now, delivery: "stream", lastTradePrice: price, lastTradeTime: time, dataSource: "live" };
  const state = current.marketState;
  const regularHours = isRegularHoursPrint(time);
  if (state === "POST" && !regularHours) {
    const postChange = price - current.price;
    next.postMarketPrice = price;
    next.postMarketChange = postChange;
    next.postMarketChangePercent = percent(postChange, current.price);
    next.extendedSessionPrint = true;
    return next;
  }
  const previousClose = current.previousClose;
  const change = previousClose != null ? price - previousClose : current.change;
  next.price = price;
  next.change = change;
  next.changePercent = percent(change, previousClose);
  if (state === "PRE" && !regularHours) {
    next.preMarketPrice = price;
    next.preMarketChange = change;
    next.preMarketChangePercent = next.changePercent;
    next.extendedSessionPrint = true;
  }
  if (state === "REGULAR") {
    next.high = current.high != null ? Math.max(current.high, price) : price;
    next.low = current.low != null ? Math.min(current.low, price) : price;
    next.open = current.open ?? price;
    next.volume = (current.volume ?? 0) + (nonNegative(trade.s) ?? 0);
  }
  return next;
}

/** The quote after a streamed bid/ask update. */
export function applyStreamQuote(current: Quote, update: StreamQuote, now: number): Quote {
  const next: Quote = { ...current, receivedAt: now, delivery: "stream" };
  const reference = current.lastTradePrice ?? current.price;
  const bid = bookSide(update.bp, reference);
  const ask = bookSide(update.ap, reference);
  if (bid != null) {
    next.bid = bid;
    next.bidSize = nonNegative(update.bs);
  }
  if (ask != null) {
    next.ask = ask;
    next.askSize = nonNegative(update.as);
  }
  return next;
}

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}
