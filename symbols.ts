/**
 * Which Gloomberb tickers Alpaca can answer for, and how they are spelled there.
 *
 * Alpaca Market Data covers US-listed equities and ETFs. Everything else
 * (indices, FX, crypto, futures, option contracts, non-US venues) is declined
 * here so the provider router keeps asking Gloom Cloud for it.
 */

/** Exchange codes Gloomberb or a user may write for a US listing, mapped to Alpaca's venue names. */
const US_EXCHANGE_ALIASES: Record<string, string> = {
  NASDAQ: "NASDAQ", NAS: "NASDAQ", XNAS: "NASDAQ", NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ",
  NASDAQGS: "NASDAQ", NASDAQGM: "NASDAQ", NASDAQCM: "NASDAQ",
  NYSE: "NYSE", NYQ: "NYSE", NYS: "NYSE", XNYS: "NYSE",
  AMEX: "AMEX", ASE: "AMEX", XASE: "AMEX", "NYSE AMERICAN": "AMEX", NYSEAMERICAN: "AMEX",
  ARCA: "ARCA", PCX: "ARCA", NYSEARCA: "ARCA", "NYSE ARCA": "ARCA", ARCX: "ARCA",
  BATS: "BATS", BTS: "BATS", CBOE: "BATS", "CBOE US": "BATS",
};

/** Alpaca venue names the listing side of a quote reports; `canonicalExchange` in the host reads these. */
export const ALPACA_TO_GLOOM_EXCHANGE: Record<string, string> = {
  NASDAQ: "NASDAQ",
  NYSE: "NYSE",
  AMEX: "AMEX",
  ARCA: "ARCA",
  BATS: "BATS",
  OTC: "OTC",
};

const OCC_OPTION_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
/** One to five letters, optionally a share class (BRK.B, BF.A) or a suffix Alpaca spells with a dot (RDS.A). */
const ALPACA_EQUITY_SYMBOL = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;

export interface ParsedTicker {
  /** The symbol as Alpaca spells it: upper case, share class after a dot. */
  symbol: string;
  /** The symbol as it was asked for, without a venue suffix. */
  requested: string;
  /** Alpaca's venue name when a US venue was named, "" when none was, null when a non-US venue was. */
  exchange: string | null;
}

/**
 * Splits `BRK-B:NYSE` style keys. A venue may arrive as a suffix on the ticker
 * or as a separate argument; the suffix wins when both are present.
 */
export function parseTicker(ticker: string, exchange?: string): ParsedTicker {
  const trimmed = ticker.trim().toUpperCase();
  const separator = trimmed.lastIndexOf(":");
  const requested = separator > 0 ? trimmed.slice(0, separator) : trimmed;
  const suffixVenue = separator > 0 ? trimmed.slice(separator + 1) : "";
  const venue = (suffixVenue || exchange || "").trim().toUpperCase();
  const mapped = venue ? US_EXCHANGE_ALIASES[venue] ?? null : "";
  return {
    symbol: toAlpacaSymbol(requested),
    requested,
    exchange: mapped,
  };
}

/** `BRK-B` and `BRK/B` are `BRK.B` at Alpaca. */
export function toAlpacaSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[-/]([A-Z]{1,2})$/, ".$1");
}

/**
 * Whether a ticker is shaped like something Alpaca lists, before asking it.
 * Cheap and local, so the router can skip the request for the obvious misses.
 */
export function looksLikeUsEquity(parsed: ParsedTicker): boolean {
  if (parsed.exchange === null) return false;
  const { symbol } = parsed;
  if (!symbol || symbol.startsWith("^") || symbol.includes("=") || symbol.includes("/")) return false;
  if (OCC_OPTION_SYMBOL.test(symbol)) return false;
  return ALPACA_EQUITY_SYMBOL.test(symbol);
}

export function isOccOptionSymbol(symbol: string): boolean {
  return OCC_OPTION_SYMBOL.test(symbol.trim().toUpperCase());
}

/** The venue name a Gloomberb quote carries for an Alpaca asset. */
export function gloomExchangeFor(alpacaExchange: string | undefined): string | undefined {
  if (!alpacaExchange) return undefined;
  return ALPACA_TO_GLOOM_EXCHANGE[alpacaExchange.toUpperCase()] ?? alpacaExchange.toUpperCase();
}
