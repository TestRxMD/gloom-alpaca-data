/**
 * Watch the plugin's IEX websocket for a few seconds and report what arrived.
 *
 *   bun scripts/observe-stream.ts [--seconds 30] [--symbols SPY,AAPL] [--handshake] [--busy-ok]
 *
 * Exits 0 when at least one trade arrived, or in --handshake mode once the
 * socket authenticated and subscribed. With --busy-ok it also exits 0 when
 * Alpaca refuses the socket because another process on the same keys (your
 * own Gloomberb, usually) already holds the account's one stream: the keys
 * worked and the stream is in use, which is not a defect. Exits 1 otherwise.
 * Keys come from the
 * same places the plugin reads them: environment variables or Gloomberb's
 * config.json. Nothing secret is printed.
 */
import { CredentialStore } from "../credentials";
import { AlpacaIexStream } from "../stream";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value || fallback;
};
const seconds = Number(flag("seconds", "30"));
const symbols = flag("symbols", "SPY,AAPL").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const handshakeOnly = args.includes("--handshake");
const busyOk = args.includes("--busy-ok");

const credentials = new CredentialStore();
if (!(await credentials.resolve())) {
  console.error("No Alpaca credentials found in the environment or Gloomberb's config.json.");
  process.exit(1);
}

let trades = 0;
let busy = false;
let quotes = 0;
let ready = false;
const lastTrade = new Map<string, { price: number; at: string }>();

const stream = new AlpacaIexStream(
  credentials,
  {
    onTrade(trade) {
      trades += 1;
      lastTrade.set(trade.S, { price: trade.p, at: trade.t });
      if (trades <= 5) console.log(`trade  ${trade.S} ${trade.p} x${trade.s} @ ${trade.t}`);
    },
    onQuote(quote) {
      quotes += 1;
      if (quotes <= 3) console.log(`quote  ${quote.S} bid ${quote.bp} ask ${quote.ap} @ ${quote.t}`);
    },
    onReady() {
      ready = true;
      console.log(`ready  authenticated and subscribed to ${symbols.join(", ")}`);
      if (handshakeOnly) finish();
    },
  },
  {
    warn: (m) => {
      if (/streaming connection is in use/.test(m)) busy = true;
      console.warn(`warn   ${m}`);
    },
    error: (m) => console.error(`error  ${m}`),
  },
);

const release = stream.subscribe(symbols);
const timer = setTimeout(finish, seconds * 1000);

function finish(): void {
  clearTimeout(timer);
  release();
  stream.dispose?.();
  console.log(`\nsummary ready=${ready} trades=${trades} quotes=${quotes} over ${seconds}s`);
  for (const [symbol, t] of lastTrade) console.log(`  ${symbol} last ${t.price} @ ${t.at}`);
  const ok = handshakeOnly ? ready : trades > 0;
  if (!ok && busyOk && busy && !ready) {
    console.log("SKIP   the account's one stream is held by another process; keys accepted, nothing to observe");
    process.exit(0);
  }
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}
