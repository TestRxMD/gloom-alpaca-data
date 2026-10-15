/**
 * An options chain from Alpaca's two halves: the contract catalogue on the
 * trading API (expiries, strikes, open interest) and the options snapshots on
 * the data API (bid, ask, last, implied volatility).
 */
import type { OptionContract, OptionsChain } from "gloomberb/types/financials";
import type { AlpacaBar, AlpacaQuote } from "./quotes";
import { ALPACA_PROVIDER_ID } from "./quotes";
import { parseTimestamp } from "./session";

export interface AlpacaOptionContract {
  symbol: string;
  underlying_symbol: string;
  expiration_date: string;
  strike_price: string | number;
  type: "call" | "put";
  open_interest?: string | number | null;
  open_interest_date?: string | null;
  close_price?: string | number | null;
  close_price_date?: string | null;
  status?: string;
  tradable?: boolean;
}

export interface AlpacaOptionSnapshot {
  latestTrade?: { t: string; p: number; s: number; x?: string };
  latestQuote?: AlpacaQuote;
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
  minuteBar?: AlpacaBar;
  impliedVolatility?: number;
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number; rho?: number };
}

export interface OptionsChainInput {
  underlyingSymbol: string;
  underlyingPrice: number | null;
  contracts: readonly AlpacaOptionContract[];
  /** Snapshots keyed by OCC contract symbol, for the chosen expiry. */
  snapshots: Readonly<Record<string, AlpacaOptionSnapshot>>;
  /** The expiry to build, YYYY-MM-DD; the nearest listed one when absent. */
  expirationDate?: string | null;
  now: number;
}

/** The Unix seconds of a YYYY-MM-DD expiry at 00:00 UTC, how the host dates expiries. */
export function expirySeconds(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);
}

/** The YYYY-MM-DD an expiry in Unix seconds names. */
export function expiryIsoDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function number(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** The expiries a catalogue lists, as sorted YYYY-MM-DD strings. */
export function listedExpiries(contracts: readonly AlpacaOptionContract[]): string[] {
  return [...new Set(contracts.map((contract) => contract.expiration_date).filter(Boolean))].sort();
}

/** The expiry a chain request means: the one asked for when listed, else the nearest. */
export function chooseExpiry(expiries: readonly string[], requested?: string | null): string | null {
  if (requested && expiries.includes(requested)) return requested;
  return expiries[0] ?? null;
}

function toOptionContract(
  contract: AlpacaOptionContract,
  snapshot: AlpacaOptionSnapshot | undefined,
  underlyingPrice: number | null,
  now: number,
): OptionContract | null {
  const strike = number(contract.strike_price);
  if (strike == null) return null;
  const bid = number(snapshot?.latestQuote?.bp) ?? 0;
  const ask = number(snapshot?.latestQuote?.ap) ?? 0;
  const lastTrade = number(snapshot?.latestTrade?.p);
  const closePrice = number(contract.close_price);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : undefined;
  const lastPrice = lastTrade ?? closePrice ?? mid ?? 0;
  const previousClose = number(snapshot?.prevDailyBar?.c);
  const change = previousClose != null ? lastPrice - previousClose : 0;
  const tradeTime = parseTimestamp(snapshot?.latestTrade?.t) ?? NaN;
  const quoteTime = parseTimestamp(snapshot?.latestQuote?.t) ?? NaN;
  const observed = [tradeTime, quoteTime].filter((value) => Number.isFinite(value));
  const inTheMoney = underlyingPrice != null
    ? contract.type === "call" ? strike < underlyingPrice : strike > underlyingPrice
    : false;
  const result: OptionContract = {
    contractSymbol: contract.symbol,
    strike,
    currency: "USD",
    lastPrice,
    change,
    percentChange: previousClose ? (change / previousClose) * 100 : 0,
    bid,
    ask,
    impliedVolatility: number(snapshot?.impliedVolatility) ?? 0,
    inTheMoney,
    expiration: expirySeconds(contract.expiration_date),
    lastTradeDate: Number.isFinite(tradeTime) ? Math.floor(tradeTime / 1000) : 0,
  };
  const volume = number(snapshot?.dailyBar?.v);
  if (volume != null) result.volume = volume;
  const openInterest = number(contract.open_interest);
  if (openInterest != null) result.openInterest = openInterest;
  if (observed.length > 0) result.lastUpdated = Math.min(Math.max(...observed), now);
  return result;
}

export function buildOptionsChain(input: OptionsChainInput): OptionsChain {
  const expiries = listedExpiries(input.contracts);
  const expiry = chooseExpiry(expiries, input.expirationDate);
  const calls: OptionContract[] = [];
  const puts: OptionContract[] = [];
  let openInterestAsOf: string | null = null;
  for (const contract of input.contracts) {
    if (contract.expiration_date !== expiry) continue;
    const mapped = toOptionContract(contract, input.snapshots[contract.symbol], input.underlyingPrice, input.now);
    if (!mapped) continue;
    (contract.type === "put" ? puts : calls).push(mapped);
    if (contract.open_interest_date && (!openInterestAsOf || contract.open_interest_date > openInterestAsOf)) {
      openInterestAsOf = contract.open_interest_date;
    }
  }
  const byStrike = (a: OptionContract, b: OptionContract) => a.strike - b.strike;
  calls.sort(byStrike);
  puts.sort(byStrike);
  return {
    underlyingSymbol: input.underlyingSymbol,
    expirationDates: expiries.map(expirySeconds),
    calls,
    puts,
    providerId: ALPACA_PROVIDER_ID,
    dataSource: "live",
    asOf: new Date(input.now).toISOString(),
    openInterestAsOf,
  };
}
