import { describe, expect, test } from "bun:test";
import type { Quote } from "gloomberb/types/financials";
import { applyStreamQuote, applyStreamTrade, snapshotToQuote, type AlpacaSnapshot } from "./quotes";
import { marketStateAt, parseTimestamp, usSessionAt } from "./session";
import snapshots from "./fixtures/snapshots.json";

const recorded = snapshots as unknown as Record<string, AlpacaSnapshot>;
/** When the fixture was recorded: 03:10 New York on Oct 15 2026, before the pre-market. */
const RECORDED_AT = Date.parse("2026-10-15T07:10:37Z");

const listing = { name: "Apple Inc. Common Stock", listingExchange: "NASDAQ" };

describe("parseTimestamp", () => {
  test("accepts Alpaca's nanosecond fractions", () => {
    expect(parseTimestamp("2026-10-14T19:59:59.404398015Z")).toBe(Date.parse("2026-10-14T19:59:59.404Z"));
    expect(parseTimestamp("2026-10-14T04:00:00Z")).toBe(Date.parse("2026-10-14T04:00:00Z"));
    expect(parseTimestamp("2026-10-15T03:16:16.744388031-04:00")).toBe(Date.parse("2026-10-15T07:16:16.744Z"));
    expect(parseTimestamp("not a time")).toBeUndefined();
  });
});

describe("US session clock", () => {
  test("reads the New York session off a UTC instant", () => {
    expect(usSessionAt(Date.parse("2026-10-14T13:30:00Z"))).toBe("REGULAR");
    expect(usSessionAt(Date.parse("2026-10-14T19:59:00Z"))).toBe("REGULAR");
    expect(usSessionAt(Date.parse("2026-10-14T12:00:00Z"))).toBe("PRE");
    expect(usSessionAt(Date.parse("2026-10-14T20:30:00Z"))).toBe("POST");
    expect(usSessionAt(RECORDED_AT)).toBe("CLOSED");
    expect(usSessionAt(Date.parse("2026-10-17T15:00:00Z"))).toBe("CLOSED"); // Saturday
  });

  test("Alpaca's clock marks a holiday the wall clock would call regular hours", () => {
    const duringHours = Date.parse("2026-10-14T15:00:00Z");
    const closedClock = { is_open: false, next_open: "2026-10-15T09:30:00-04:00", next_close: "2026-10-15T16:00:00-04:00" };
    expect(marketStateAt(duringHours, closedClock)).toBe("CLOSED");
    expect(marketStateAt(duringHours, { ...closedClock, is_open: true })).toBe("REGULAR");
    // A holiday morning: the next open is tomorrow, so there is no pre-market today.
    expect(marketStateAt(Date.parse("2026-10-14T12:00:00Z"), closedClock)).toBe("CLOSED");
    expect(marketStateAt(Date.parse("2026-10-14T12:00:00Z"), { ...closedClock, next_open: "2026-10-14T09:30:00-04:00" })).toBe("PRE");
    expect(marketStateAt(duringHours, null)).toBe("REGULAR");
  });
});

describe("snapshotToQuote", () => {
  test("maps the recorded AAPL snapshot after the close", () => {
    const quote = snapshotToQuote({ symbol: "AAPL", snapshot: recorded.AAPL!, now: RECORDED_AT, marketState: "CLOSED", listing });
    expect(quote).not.toBeNull();
    expect(quote!.symbol).toBe("AAPL");
    expect(quote!.providerId).toBe("alpaca");
    expect(quote!.dataSource).toBe("live");
    expect(quote!.currency).toBe("USD");
    expect(quote!.price).toBe(343.01);
    // The latest trade belongs to the daily bar's session, so the reference is the bar before it.
    expect(quote!.previousClose).toBe(341.33);
    expect(quote!.change).toBeCloseTo(1.68, 6);
    expect(quote!.changePercent).toBeCloseTo((1.68 / 341.33) * 100, 6);
    expect(quote!.open).toBe(344.605);
    expect(quote!.high).toBe(347.09);
    expect(quote!.low).toBe(341.72);
    expect(quote!.volume).toBe(1874329);
    expect(quote!.lastUpdated).toBe(Date.parse("2026-10-14T19:59:59.404Z"));
    expect(quote!.lastTradePrice).toBe(343.01);
    expect(quote!.marketState).toBe("CLOSED");
    expect(quote!.listingExchangeName).toBe("NASDAQ");
    expect(quote!.name).toBe("Apple Inc. Common Stock");
    // IEX shows a one-cent bid after hours; it is not a market and is dropped. The ask is near the price and kept.
    expect(quote!.bid).toBeUndefined();
    expect(quote!.ask).toBe(343.19);
    expect(quote!.askSize).toBe(40);
    expect(quote!.postMarketPrice).toBeUndefined();
    expect(quote!.preMarketPrice).toBeUndefined();
  });

  test("answers under the symbol Gloomberb asked for", () => {
    const quote = snapshotToQuote({ symbol: "BRK-B", snapshot: recorded["BRK.B"]!, now: RECORDED_AT, marketState: "CLOSED" });
    expect(quote?.symbol).toBe("BRK-B");
    expect(quote?.price).toBeGreaterThan(0);
  });

  test("keeps the regular close and carries an after-hours print beside it", () => {
    const snapshot: AlpacaSnapshot = {
      ...recorded.AAPL!,
      latestTrade: { t: "2026-10-14T20:30:00Z", p: 344.5, s: 10 },
    };
    const now = Date.parse("2026-10-14T20:35:00Z");
    const quote = snapshotToQuote({ symbol: "AAPL", snapshot, now, marketState: "POST", listing })!;
    expect(quote.price).toBe(343.01);
    expect(quote.change).toBeCloseTo(1.68, 6);
    expect(quote.postMarketPrice).toBe(344.5);
    expect(quote.postMarketChange).toBeCloseTo(1.49, 6);
    expect(quote.extendedSessionPrint).toBe(true);
    expect(quote.lastUpdated).toBe(Date.parse("2026-10-14T20:30:00Z"));
  });

  test("after the close with no after-hours print, the regular close is current", () => {
    const now = Date.parse("2026-10-14T20:05:00Z");
    const quote = snapshotToQuote({ symbol: "AAPL", snapshot: recorded.AAPL!, now, marketState: "POST", listing })!;
    expect(quote.price).toBe(343.01);
    expect(quote.postMarketPrice).toBeUndefined();
    expect(quote.extendedSessionPrint).toBe(false);
  });

  test("a pre-market print references yesterday's close and has no session range yet", () => {
    const snapshot: AlpacaSnapshot = {
      ...recorded.AAPL!,
      latestTrade: { t: "2026-10-15T12:00:00Z", p: 345, s: 10 },
      latestQuote: { t: "2026-10-15T12:00:00Z", bp: 344.9, bs: 1, ap: 345.1, as: 1 },
    };
    const now = Date.parse("2026-10-15T12:05:00Z");
    const quote = snapshotToQuote({ symbol: "AAPL", snapshot, now, marketState: "PRE", listing })!;
    expect(quote.price).toBe(345);
    expect(quote.previousClose).toBe(343.01);
    expect(quote.change).toBeCloseTo(1.99, 6);
    expect(quote.preMarketPrice).toBe(345);
    expect(quote.preMarketChange).toBeCloseTo(1.99, 6);
    expect(quote.extendedSessionPrint).toBe(true);
    expect(quote.open).toBeUndefined();
    expect(quote.volume).toBeUndefined();
    expect(quote.bid).toBe(344.9);
    expect(quote.ask).toBe(345.1);
  });

  test("falls back to the latest bar when nothing has traded, and to null when nothing has", () => {
    const barOnly: AlpacaSnapshot = { dailyBar: recorded.AAPL!.dailyBar, prevDailyBar: recorded.AAPL!.prevDailyBar };
    const quote = snapshotToQuote({ symbol: "AAPL", snapshot: barOnly, now: RECORDED_AT, marketState: "CLOSED" })!;
    expect(quote.price).toBe(343.01);
    expect(quote.lastUpdated).toBe(Date.parse("2026-10-14T04:00:00Z"));
    expect(quote.lastTradePrice).toBeUndefined();
    expect(snapshotToQuote({ symbol: "ZZZZ", snapshot: {}, now: RECORDED_AT, marketState: "CLOSED" })).toBeNull();
  });
});

describe("streamed updates", () => {
  const seed = (): Quote => snapshotToQuote({
    symbol: "AAPL",
    snapshot: { ...recorded.AAPL!, latestTrade: { t: "2026-10-14T18:00:00Z", p: 342, s: 10 } },
    now: Date.parse("2026-10-14T18:00:05Z"),
    marketState: "REGULAR",
    listing,
  })!;

  test("a regular-hours trade moves the price, range and volume", () => {
    const now = Date.parse("2026-10-14T18:01:00Z");
    const next = applyStreamTrade(seed(), { T: "t", S: "AAPL", p: 348, s: 100, t: "2026-10-14T18:00:59.123456789Z" }, now)!;
    expect(next.price).toBe(348);
    expect(next.change).toBeCloseTo(348 - 341.33, 6);
    expect(next.high).toBe(348);
    expect(next.low).toBe(341.72);
    expect(next.volume).toBe(1874329 + 100);
    expect(next.lastUpdated).toBe(Date.parse("2026-10-14T18:00:59.123Z"));
    expect(next.delivery).toBe("stream");
    expect(next.receivedAt).toBe(now);
  });

  test("an after-hours trade moves the after-hours price and leaves the close", () => {
    const closed: Quote = { ...seed(), marketState: "POST", price: 343.01, change: 1.68 };
    const next = applyStreamTrade(closed, { T: "t", S: "AAPL", p: 344, s: 5, t: "2026-10-14T20:30:00Z" }, Date.parse("2026-10-14T20:30:01Z"))!;
    expect(next.price).toBe(343.01);
    expect(next.change).toBe(1.68);
    expect(next.postMarketPrice).toBe(344);
    expect(next.postMarketChange).toBeCloseTo(0.99, 6);
  });

  test("a book update sets a plausible bid and ask and drops an empty side", () => {
    const next = applyStreamQuote(seed(), { T: "q", S: "AAPL", bp: 341.9, bs: 3, ap: 0, as: 0, t: "2026-10-14T18:00:30Z" }, Date.parse("2026-10-14T18:00:31Z"));
    expect(next.bid).toBe(341.9);
    expect(next.bidSize).toBe(3);
    expect(next.ask).toBe(343.19);
    expect(applyStreamTrade(seed(), { T: "t", S: "AAPL", p: 0, s: 1, t: "2026-10-14T18:00:30Z" }, Date.now())).toBeNull();
  });
});
