import { describe, expect, test } from "bun:test";
import {
  buildOptionsChain,
  chooseExpiry,
  expiryIsoDate,
  expirySeconds,
  listedExpiries,
  type AlpacaOptionContract,
  type AlpacaOptionSnapshot,
} from "./options";
import contractsFixture from "./fixtures/options-contracts.json";
import snapshotsFixture from "./fixtures/options-snapshots.json";

const contracts = (contractsFixture as { option_contracts: AlpacaOptionContract[] }).option_contracts;
const snapshots = (snapshotsFixture as { snapshots: Record<string, AlpacaOptionSnapshot> }).snapshots;
const NOW = Date.parse("2026-10-15T07:10:37Z");

describe("expiries", () => {
  test("round-trip between YYYY-MM-DD and the host's Unix seconds", () => {
    expect(expirySeconds("2026-10-16")).toBe(Date.UTC(2026, 9, 16) / 1000);
    expect(expiryIsoDate(expirySeconds("2026-10-16"))).toBe("2026-10-16");
  });

  test("list and choose", () => {
    const listed = listedExpiries([
      ...contracts,
      { ...contracts[0]!, symbol: "AAPL261023C00130000", expiration_date: "2026-10-23" },
    ]);
    expect(listed).toEqual(["2026-10-16", "2026-10-23"]);
    expect(chooseExpiry(listed, "2026-10-23")).toBe("2026-10-23");
    expect(chooseExpiry(listed, "2026-12-18")).toBe("2026-10-16");
    expect(chooseExpiry(listed, null)).toBe("2026-10-16");
    expect(chooseExpiry([], null)).toBeNull();
  });
});

describe("buildOptionsChain", () => {
  test("joins the recorded contracts with their snapshots", () => {
    const chain = buildOptionsChain({
      underlyingSymbol: "AAPL",
      underlyingPrice: 343.01,
      contracts,
      snapshots,
      expirationDate: "2026-10-16",
      now: NOW,
    });
    expect(chain.underlyingSymbol).toBe("AAPL");
    expect(chain.providerId).toBe("alpaca");
    expect(chain.dataSource).toBe("live");
    expect(chain.expirationDates).toEqual([expirySeconds("2026-10-16")]);
    expect(chain.openInterestAsOf).toBe("2026-10-13");
    expect(chain.puts).toHaveLength(0);
    expect(chain.calls.map((call) => call.strike)).toEqual([130, 135, 140, 145]);

    const deep = chain.calls[0]!;
    expect(deep.contractSymbol).toBe("AAPL261016C00130000");
    expect(deep.currency).toBe("USD");
    expect(deep.bid).toBe(207.81);
    expect(deep.ask).toBe(213.98);
    expect(deep.lastPrice).toBe(214.64);
    expect(deep.change).toBeCloseTo(214.64 - 210.17, 6);
    expect(deep.openInterest).toBe(38);
    expect(deep.volume).toBe(1);
    expect(deep.inTheMoney).toBe(true);
    expect(deep.expiration).toBe(expirySeconds("2026-10-16"));
    expect(deep.lastTradeDate).toBe(Math.floor(Date.parse("2026-10-13T16:31:07.036Z") / 1000));
    expect(deep.lastUpdated).toBe(Date.parse("2026-10-14T19:59:59.135Z"));
    expect(deep.impliedVolatility).toBe(0);
  });

  test("a contract without a snapshot still lists with its catalogue close", () => {
    const chain = buildOptionsChain({
      underlyingSymbol: "AAPL",
      underlyingPrice: 100,
      contracts,
      snapshots: {},
      expirationDate: "2026-10-16",
      now: NOW,
    });
    const first = chain.calls[0]!;
    expect(first.lastPrice).toBe(214.47);
    expect(first.bid).toBe(0);
    expect(first.ask).toBe(0);
    expect(first.change).toBe(0);
    expect(first.inTheMoney).toBe(false);
    expect(first.lastTradeDate).toBe(0);
    expect(first.lastUpdated).toBeUndefined();
  });

  test("puts are in the money above the underlying", () => {
    const put: AlpacaOptionContract = { ...contracts[0]!, symbol: "AAPL261016P00350000", type: "put", strike_price: "350" };
    const chain = buildOptionsChain({ underlyingSymbol: "AAPL", underlyingPrice: 343.01, contracts: [put], snapshots: {}, now: NOW });
    expect(chain.calls).toHaveLength(0);
    expect(chain.puts[0]!.inTheMoney).toBe(true);
  });
});
