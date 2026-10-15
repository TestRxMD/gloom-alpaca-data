/**
 * The US equity session clock, read in New York time.
 *
 * Alpaca stamps trades in UTC and says nothing about the session they belong
 * to, while Gloomberb judges a quote's freshness by the session its exchange is
 * in. This derives that session from the wall clock, with Alpaca's market
 * clock endpoint marking the holidays the wall clock cannot know.
 */
import type { MarketState } from "gloomberb/types/financials";

export const NEW_YORK = "America/New_York";

const PRE_OPEN_MINUTES = 4 * 60;
export const REGULAR_OPEN_MINUTES = 9 * 60 + 30;
export const REGULAR_CLOSE_MINUTES = 16 * 60;
const POST_CLOSE_MINUTES = 20 * 60;

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: NEW_YORK,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface NewYorkParts {
  /** YYYY-MM-DD in New York. */
  date: string;
  /** Minutes since New York midnight. */
  minutes: number;
  /** 0 is Sunday. */
  weekday: number;
}

export function newYorkParts(timestampMs: number): NewYorkParts {
  const parts = partsFormat.formatToParts(new Date(timestampMs));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(read("hour")) % 24;
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    minutes: hour * 60 + Number(read("minute")),
    weekday: WEEKDAYS[read("weekday")] ?? 0,
  };
}

export function newYorkDate(timestampMs: number): string {
  return newYorkParts(timestampMs).date;
}

/**
 * Alpaca stamps to the nanosecond (`2026-10-14T19:59:59.404398015Z`), more
 * fraction than every JavaScript engine's `Date.parse` accepts. Milliseconds,
 * or undefined for anything that is not a timestamp.
 */
export function parseTimestamp(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d{2}:?\d{2})$)/, "$1");
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : undefined;
}

export type UsSession = "PRE" | "REGULAR" | "POST" | "CLOSED";

/** The session the New York clock alone implies; it does not know holidays. */
export function usSessionAt(timestampMs: number): UsSession {
  const { minutes, weekday } = newYorkParts(timestampMs);
  if (weekday === 0 || weekday === 6) return "CLOSED";
  if (minutes >= REGULAR_OPEN_MINUTES && minutes < REGULAR_CLOSE_MINUTES) return "REGULAR";
  if (minutes >= PRE_OPEN_MINUTES && minutes < REGULAR_OPEN_MINUTES) return "PRE";
  if (minutes >= REGULAR_CLOSE_MINUTES && minutes < POST_CLOSE_MINUTES) return "POST";
  return "CLOSED";
}

export interface AlpacaClock {
  is_open: boolean;
  next_open: string;
  next_close: string;
  timestamp?: string;
}

/**
 * The market state a quote carries now. Alpaca's clock corrects the two cases
 * the wall clock gets wrong: a holiday during regular hours (closed), and a
 * holiday morning that would otherwise read as pre-market.
 */
export function marketStateAt(timestampMs: number, clock?: AlpacaClock | null): MarketState {
  const session = usSessionAt(timestampMs);
  if (!clock) return session;
  if (session === "REGULAR" && !clock.is_open) return "CLOSED";
  if (session === "PRE") {
    const nextOpen = Date.parse(clock.next_open);
    if (Number.isFinite(nextOpen) && newYorkDate(nextOpen) !== newYorkDate(timestampMs)) return "CLOSED";
  }
  if (clock.is_open && session !== "REGULAR") return "REGULAR";
  return session;
}

/** Whether a trade printed inside the regular session of its own day. */
export function isRegularHoursPrint(timestampMs: number): boolean {
  const { minutes } = newYorkParts(timestampMs);
  return minutes >= REGULAR_OPEN_MINUTES && minutes < REGULAR_CLOSE_MINUTES;
}
