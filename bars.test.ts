import { describe, expect, test } from "bun:test";
import { barsToPricePoints, CHART_RESOLUTION_SUPPORT, rangeStart, resolutionForBarSize, TIMEFRAME_BY_RESOLUTION } from "./bars";
import type { AlpacaBar } from "./quotes";
import fiveMinute from "./fixtures/bars-5min.json";
import daily from "./fixtures/bars-daily.json";

const fiveMinuteBars = (fiveMinute as { bars: AlpacaBar[] }).bars;
const dailyBars = (daily as { bars: AlpacaBar[] }).bars;

describe("barsToPricePoints", () => {
  test("maps the recorded 5-minute bars in order with their OHLCV", () => {
    const now = Date.parse("2026-10-15T07:00:00Z");
    const points = barsToPricePoints(fiveMinuteBars, { resolution: "5m", now, regularHoursOnly: true });
    expect(points).toHaveLength(5);
    expect(points[0]!.date.toISOString()).toBe("2026-10-14T13:30:00.000Z");
    expect(points[0]).toMatchObject({ open: 344.605, high: 345.935, low: 343.74, close: 345.61, volume: 73886 });
    expect(points[4]!.close).toBe(345.46);
    expect(points.every((point) => point.partial === undefined)).toBe(true);
  });

  test("drops pre-market bars unless extended hours were asked for", () => {
    const preMarket: AlpacaBar = { t: "2026-10-14T12:00:00Z", o: 344, h: 344.5, l: 343.9, c: 344.3, v: 120 };
    const afterHours: AlpacaBar = { t: "2026-10-14T20:15:00Z", o: 343, h: 343.2, l: 342.9, c: 343.1, v: 80 };
    const now = Date.parse("2026-10-15T07:00:00Z");
    const all = [preMarket, ...fiveMinuteBars, afterHours];
    expect(barsToPricePoints(all, { resolution: "5m", now, regularHoursOnly: true })).toHaveLength(5);
    expect(barsToPricePoints(all, { resolution: "5m", now, regularHoursOnly: false })).toHaveLength(7);
  });

  test("keeps the clock-aligned hour bar that opens before 09:30", () => {
    const nineOClock: AlpacaBar = { t: "2026-10-14T13:00:00Z", o: 344, h: 345, l: 343, c: 344.5, v: 500 };
    const eightOClock: AlpacaBar = { t: "2026-10-14T12:00:00Z", o: 344, h: 345, l: 343, c: 344.5, v: 500 };
    const points = barsToPricePoints([eightOClock, nineOClock], { resolution: "1h", now: Date.parse("2026-10-15T07:00:00Z"), regularHoursOnly: true });
    expect(points.map((point) => point.date.toISOString())).toEqual(["2026-10-14T13:00:00.000Z"]);
  });

  test("marks the bar still in progress as partial", () => {
    const now = Date.parse("2026-10-14T13:52:00Z");
    const points = barsToPricePoints(fiveMinuteBars, { resolution: "5m", now, regularHoursOnly: true });
    expect(points.at(-1)!.partial).toBe(true);
    expect(points.at(-2)!.partial).toBeUndefined();
  });

  test("maps daily bars without filtering and sorts by time", () => {
    const reversed = [...dailyBars].reverse();
    const points = barsToPricePoints(reversed, { resolution: "1d", now: Date.parse("2026-10-15T07:00:00Z"), regularHoursOnly: true });
    expect(points.map((point) => point.date.toISOString().slice(0, 10))).toEqual(["2026-10-08", "2026-10-09", "2026-10-12"]);
    expect(points[2]!.close).toBe(341.045);
  });
});

describe("resolutions", () => {
  test("every chart resolution has an Alpaca timeframe", () => {
    expect(TIMEFRAME_BY_RESOLUTION["1m"]).toBe("1Min");
    expect(TIMEFRAME_BY_RESOLUTION["1h"]).toBe("1Hour");
    expect(TIMEFRAME_BY_RESOLUTION["1wk"]).toBe("1Week");
    expect(CHART_RESOLUTION_SUPPORT.map((entry) => entry.resolution)).toEqual(["1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo"]);
  });

  test("reads bar sizes in the host's and other sources' spellings", () => {
    expect(resolutionForBarSize("5m")).toBe("5m");
    expect(resolutionForBarSize("5min")).toBe("5m");
    expect(resolutionForBarSize("1 hour")).toBe("1h");
    expect(resolutionForBarSize("1d")).toBe("1d");
    expect(resolutionForBarSize("1day")).toBe("1d");
    expect(resolutionForBarSize("1wk")).toBe("1wk");
    expect(resolutionForBarSize("1W")).toBe("1wk");
    expect(resolutionForBarSize("1mo")).toBe("1mo");
    expect(resolutionForBarSize("2h")).toBeNull();
    expect(resolutionForBarSize("tick")).toBeNull();
  });

  test("range starts count back on the UTC calendar", () => {
    const end = new Date("2026-10-15T07:00:00Z");
    expect(rangeStart("1D", end).toISOString()).toBe("2026-10-14T07:00:00.000Z");
    expect(rangeStart("1M", end).toISOString()).toBe("2026-09-15T07:00:00.000Z");
    expect(rangeStart("5Y", end).toISOString()).toBe("2021-10-15T07:00:00.000Z");
    expect(rangeStart("ALL", end).toISOString()).toBe("2016-01-01T00:00:00.000Z");
  });
});
