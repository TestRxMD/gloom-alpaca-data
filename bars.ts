/**
 * Alpaca bars mapped to Gloomberb price points, and the chart resolutions the
 * bars endpoint serves.
 */
import type { PricePoint } from "gloomberb/types/financials";
import type { ChartResolutionSupport, ManualChartResolution, TimeRange } from "gloomberb/time-series";
import type { AlpacaBar } from "./quotes";
import { newYorkParts, parseTimestamp, REGULAR_CLOSE_MINUTES, REGULAR_OPEN_MINUTES } from "./session";

export const TIMEFRAME_BY_RESOLUTION: Readonly<Record<ManualChartResolution, string>> = {
  "1m": "1Min",
  "5m": "5Min",
  "15m": "15Min",
  "30m": "30Min",
  "45m": "45Min",
  "1h": "1Hour",
  "1d": "1Day",
  "1wk": "1Week",
  "1mo": "1Month",
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const STEP_MS_BY_RESOLUTION: Readonly<Record<ManualChartResolution, number>> = {
  "1m": MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "30m": 30 * MINUTE,
  "45m": 45 * MINUTE,
  "1h": HOUR,
  "1d": DAY,
  "1wk": 7 * DAY,
  "1mo": 31 * DAY,
};

/** IEX history on Alpaca reaches back to 2016 at every timeframe; these mirror the host's own ladder. */
export const CHART_RESOLUTION_SUPPORT: ChartResolutionSupport[] = [
  { resolution: "1m", maxRange: "1W" },
  { resolution: "5m", maxRange: "1M" },
  { resolution: "15m", maxRange: "3M" },
  { resolution: "30m", maxRange: "6M" },
  { resolution: "1h", maxRange: "1Y" },
  { resolution: "1d", maxRange: "5Y" },
  { resolution: "1wk", maxRange: "5Y" },
  { resolution: "1mo", maxRange: "ALL" },
];

/** The resolution a plain range request charts at, the same choice the host makes. */
export const RESOLUTION_BY_RANGE: Readonly<Record<TimeRange, ManualChartResolution>> = {
  "1D": "5m",
  "1W": "1h",
  "1M": "1d",
  "3M": "1d",
  "6M": "1d",
  "1Y": "1d",
  "5Y": "1wk",
  "ALL": "1mo",
};

export function isIntraday(resolution: ManualChartResolution): boolean {
  return STEP_MS_BY_RESOLUTION[resolution] < DAY;
}

/** The start of a range that ends at `end`, in UTC calendar terms. */
export function rangeStart(range: TimeRange, end: Date): Date {
  const start = new Date(end);
  switch (range) {
    case "1D": start.setUTCDate(start.getUTCDate() - 1); break;
    case "1W": start.setUTCDate(start.getUTCDate() - 7); break;
    case "1M": start.setUTCMonth(start.getUTCMonth() - 1); break;
    case "3M": start.setUTCMonth(start.getUTCMonth() - 3); break;
    case "6M": start.setUTCMonth(start.getUTCMonth() - 6); break;
    case "1Y": start.setUTCFullYear(start.getUTCFullYear() - 1); break;
    case "5Y": start.setUTCFullYear(start.getUTCFullYear() - 5); break;
    case "ALL": return new Date(Date.UTC(2016, 0, 1));
  }
  return start;
}

/**
 * The resolution a bar-size string names: the host's own codes (`5m`, `1h`,
 * `1d`, `1wk`, `1mo`) and the spellings other sources use (`5min`, `1 hour`,
 * `1day`, `1W`, `1month`). Null when it names none.
 */
export function resolutionForBarSize(barSize: string): ManualChartResolution | null {
  const text = barSize.trim().toLowerCase().replace(/\s+/g, "");
  if (text in TIMEFRAME_BY_RESOLUTION) return text as ManualChartResolution;
  const match = /^(\d+)(min|mins|minute|minutes|m|h|hr|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months)$/.exec(text);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2]!;
  if (/^(min|mins|minute|minutes|m)$/.test(unit)) {
    return [1, 5, 15, 30, 45].includes(count) ? (`${count}m` as ManualChartResolution) : null;
  }
  if (/^(h|hr|hour|hours)$/.test(unit)) return count === 1 ? "1h" : null;
  if (/^(d|day|days)$/.test(unit)) return count === 1 ? "1d" : null;
  if (/^(w|wk|week|weeks)$/.test(unit)) return count === 1 ? "1wk" : null;
  return count === 1 ? "1mo" : null;
}

export interface BarMappingOptions {
  resolution: ManualChartResolution;
  now: number;
  /** Drop intraday bars outside 09:30–16:00 New York; daily and longer bars are never filtered. */
  regularHoursOnly: boolean;
}

function overlapsRegularSession(openMs: number, stepMs: number): boolean {
  const { minutes } = newYorkParts(openMs);
  const closeMinutes = minutes + stepMs / MINUTE;
  return minutes < REGULAR_CLOSE_MINUTES && closeMinutes > REGULAR_OPEN_MINUTES;
}

/** Bars in time order as price points; the last one is partial while its period is still open. */
export function barsToPricePoints(bars: readonly AlpacaBar[], options: BarMappingOptions): PricePoint[] {
  const step = STEP_MS_BY_RESOLUTION[options.resolution];
  const intraday = isIntraday(options.resolution);
  const points: PricePoint[] = [];
  for (const bar of bars) {
    const open = parseTimestamp(bar.t);
    if (open == null) continue;
    if (!(typeof bar.c === "number" && Number.isFinite(bar.c) && bar.c > 0)) continue;
    if (intraday && options.regularHoursOnly && !overlapsRegularSession(open, step)) continue;
    const point: PricePoint = {
      date: new Date(open),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    };
    if (open + step > options.now) point.partial = true;
    points.push(point);
  }
  points.sort((a, b) => a.date.getTime() - b.date.getTime());
  return points;
}
