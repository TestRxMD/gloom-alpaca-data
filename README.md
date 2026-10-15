# Alpaca Market Data for Gloomberb

A [Gloomberb](https://github.com/gloom-sh/gloomberb) plugin that serves US-listed
equities and ETFs from [Alpaca Market Data](https://alpaca.markets/data) ahead of
Gloom Cloud. Alpaca's free plan includes the IEX feed in real time, so quotes,
streamed trades, intraday and daily bars, and options chains arrive live instead
of fifteen minutes behind.

It registers one `asset-data` capability (provider id `alpaca`, priority 5) and
answers only for tickers Alpaca lists as active US equities. Everything else
falls through to Gloom Cloud as before.

## What comes from where

| Data | Source |
|---|---|
| Quotes for US equities and ETFs (price, change, bid/ask, day range) | Alpaca, real-time IEX |
| Streamed trades and quotes in watchlists, portfolios and detail panes | Alpaca, one shared IEX websocket |
| Charts at every resolution (1m to 1mo), `GP`, `history` | Alpaca bars, split-adjusted |
| Options chains (strikes, bid/ask, last, open interest) | Alpaca indicative options feed plus its contract catalogue |
| Ticker search for US symbols and company names | Alpaca asset catalogue, merged with Gloom Cloud's results |
| Fundamentals, statements, profiles, earnings | Gloom Cloud |
| SEC filings, holders, analyst research, corporate actions | Gloom Cloud |
| News and article summaries | Gloom Cloud |
| Crypto, FX, indices, futures, non-US listings, OTC | Gloom Cloud |

A quote carries `providerId: "alpaca"` and `dataSource: "live"` when Alpaca
answered it. `gloomberb quote AAPL --json` shows both.

## Setup

1. Create a free account at [app.alpaca.markets](https://app.alpaca.markets) and
   generate an API key pair. Paper-trading keys are fine: market data is the same
   for paper and live keys, and the free Market Data plan comes with either.
2. Install the plugin:

   ```bash
   gloomberb install jnieters/gloom-alpaca-data
   ```

   or, from a checkout, `gloomberb plugin link ./gloom-alpaca-data`.
3. In Gloomberb open the Plugins pane (`PL`), select **Alpaca Market Data** and
   press `s`, or run the **Set up Alpaca Market Data** command. Enter the key ID
   and secret, and pick *Paper* or *Live* to match the account the pair belongs
   to (the asset catalogue and market clock are read from that account's trading
   API host).

The values are stored under `pluginConfig["alpaca-data"]` in Gloomberb's
`config.json`. CLI commands such as `gloomberb quote` read them from there, so
they work without the app running. The pair can also come from the environment
as `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` (or `ALPACA_API_KEY` /
`ALPACA_SECRET_KEY`, with `ALPACA_PAPER=false` for live keys).

Check that it loaded:

```bash
gloomberb plugin doctor gloom-alpaca-data
gloomberb quote AAPL --json
```

## What to expect from the IEX feed

- **Prices are IEX prints.** IEX handles a few percent of US volume, so the last
  trade can differ by a cent or two from the consolidated tape, and the day's
  volume is IEX volume only, not the consolidated total.
- **After hours is thin.** IEX trades 8:00 to 17:00 New York (pre-market from
  8:00, a short post-market to 17:00), so a quote after 17:00 shows the regular
  close with the last IEX print beside it, and a pre-market quote before 8:00 is
  the previous close.
- **Bid and ask** are IEX's top of book. An empty side (a one-cent bid after the
  close) is dropped rather than shown.
- **Charts** show regular-hours bars (09:30 to 16:00) unless the chart asks for
  extended hours. History reaches back to 2016 at every resolution.
- **Options** use Alpaca's indicative feed: real-time, derived quotes. Implied
  volatility is shown when the feed includes it, otherwise 0. Open interest is
  the prior session's, dated in the chain's `openInterestAsOf`.
- **One streaming connection.** A free account holds one websocket. Another
  process on the same keys (a bot, a second Gloomberb) takes it over, and the
  plugin falls back to re-reading snapshots once a minute until it is free.
- **Sessions and holidays.** The market state is derived from the New York
  clock, corrected by Alpaca's market clock for holidays during regular hours.

## Development

The plugin is plain TypeScript with no dependencies beyond the host. It uses
`httpFetch` from `gloomberb/utils` for REST and the native `WebSocket` for
streaming, so it compiles for the terminal, the desktop view and the web app.

```bash
bun install            # dev dependencies: typescript and type packages
bun run link-host      # clone Gloomberb at the installed version and link it into node_modules
bun run typecheck
bun test               # mapper tests against recorded Alpaca responses in fixtures/
gloomberb plugin link . && gloomberb plugin doctor gloom-alpaca-data
```

`link-host` mirrors what Gloomberb does at install time for a source-run host:
one copy of `gloomberb` and `react`, linked rather than installed. A packaged
Gloomberb (the .app) has no source tree to link, so the script keeps a checkout
under `~/.cache/gloomberb-host` (`GLOOMBERB_SRC` overrides the path,
`GLOOMBERB_VERSION` the tag).

### Layout

| File | Role |
|---|---|
| `index.ts` | The `GloomPlugin`: config schema, hosts, the capability, and `setup()` wiring the keys in |
| `provider.ts` | The `AssetDataProvider`: `canProvide`, quotes, batches, streaming, history, search, options |
| `alpaca-client.ts` | The REST endpoints, paginated, through `httpFetch` |
| `stream.ts` | The shared IEX websocket with per-symbol reference counts and reconnects |
| `quotes.ts`, `bars.ts`, `options.ts` | Pure mappers from Alpaca JSON to Gloomberb's `Quote`, `PricePoint`, `OptionsChain` |
| `session.ts` | The New York session clock and Alpaca timestamp parsing |
| `symbols.ts` | Which tickers Alpaca can answer for, and how it spells them (`BRK-B` is `BRK.B`) |
| `credentials.ts` | Where the key pair comes from: the config form, the environment, or `config.json` |

### Why priority 5

The provider router sorts sources by the lowest priority among a source's
capabilities. Gloom Cloud's market provider declares 100, but its news
capability declares 10, so Gloom Cloud sorts at 10. A market provider that wants
to be asked first has to sit below that.

## License

MIT
