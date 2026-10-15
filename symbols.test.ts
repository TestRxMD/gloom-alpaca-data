import { describe, expect, test } from "bun:test";
import { credentialsFromEnvironment, credentialsFromValues } from "./credentials";
import { gloomExchangeFor, isOccOptionSymbol, looksLikeUsEquity, parseTicker, toAlpacaSymbol } from "./symbols";

describe("parseTicker", () => {
  test("splits a venue suffix and spells share classes Alpaca's way", () => {
    expect(parseTicker("BRK-B:NYSE")).toEqual({ symbol: "BRK.B", requested: "BRK-B", exchange: "NYSE" });
    expect(parseTicker("brk/b", "nyse")).toEqual({ symbol: "BRK.B", requested: "BRK/B", exchange: "NYSE" });
    expect(parseTicker("AAPL")).toEqual({ symbol: "AAPL", requested: "AAPL", exchange: "" });
    expect(parseTicker("AAPL", "NMS").exchange).toBe("NASDAQ");
    expect(parseTicker("SPY", "NYSEARCA").exchange).toBe("ARCA");
    expect(parseTicker("VOD:LSE").exchange).toBeNull();
  });

  test("toAlpacaSymbol leaves currency pairs alone", () => {
    expect(toAlpacaSymbol("BTC-USD")).toBe("BTC-USD");
    expect(toAlpacaSymbol("bf-a")).toBe("BF.A");
  });
});

describe("looksLikeUsEquity", () => {
  const yes = ["AAPL", "SPY", "BRK-B", "BRK.B:NYSE", "F", "GOOGL:NASDAQ", "TSLA:XNAS"];
  const no = ["^GSPC", "EURUSD=X", "BTC-USD", "ES=F", "VOD:LSE", "7203:TSE", "AAPL261016C00130000", "", "TOOLONGNAME", "BTC/USD"];
  test.each(yes)("%s is one", (ticker) => expect(looksLikeUsEquity(parseTicker(ticker))).toBe(true));
  test.each(no)("%s is not", (ticker) => expect(looksLikeUsEquity(parseTicker(ticker))).toBe(false));

  test("OCC option symbols are recognised", () => {
    expect(isOccOptionSymbol("AAPL261016C00130000")).toBe(true);
    expect(isOccOptionSymbol("AAPL")).toBe(false);
  });
});

describe("exchanges", () => {
  test("Alpaca venue names map to the host's codes", () => {
    expect(gloomExchangeFor("NASDAQ")).toBe("NASDAQ");
    expect(gloomExchangeFor("ARCA")).toBe("ARCA");
    expect(gloomExchangeFor("OTC")).toBe("OTC");
    expect(gloomExchangeFor(undefined)).toBeUndefined();
  });
});

describe("credentials", () => {
  test("a form needs both halves of the pair and defaults to paper keys", () => {
    expect(credentialsFromValues({ keyId: " PK1 ", secretKey: "s" })).toEqual({ keyId: "PK1", secretKey: "s", keyType: "paper" });
    expect(credentialsFromValues({ keyId: "PK1", secretKey: "s", keyType: "live" })?.keyType).toBe("live");
    expect(credentialsFromValues({ keyId: "PK1" })).toBeNull();
    expect(credentialsFromValues(null)).toBeNull();
  });

  test("the environment is read in Alpaca's and the SDK examples' variable names", () => {
    expect(credentialsFromEnvironment({ APCA_API_KEY_ID: "a", APCA_API_SECRET_KEY: "b" })).toEqual({ keyId: "a", secretKey: "b", keyType: "paper" });
    expect(credentialsFromEnvironment({ ALPACA_API_KEY: "a", ALPACA_SECRET_KEY: "b", ALPACA_PAPER: "false" })?.keyType).toBe("live");
    expect(credentialsFromEnvironment({ ALPACA_API_KEY: "a", ALPACA_SECRET_KEY: "b", ALPACA_PAPER: "true" })?.keyType).toBe("paper");
    expect(credentialsFromEnvironment({ ALPACA_API_KEY: "a" })).toBeNull();
  });
});
