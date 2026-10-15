import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AlpacaClient } from "./alpaca-client";
import type { CredentialStore } from "./credentials";
import { FakeSocket, installFakeSocket, latestSocket, restoreSocket } from "./fixtures/fake-socket";
import { AlpacaProvider } from "./provider";

const credentials = { resolve: async () => ({ keyId: "key", secretKey: "secret", keyType: "paper" as const }) } as unknown as CredentialStore;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Snapshots whose latest trade is "now", so each reseed sees a fresh print. */
function fakeClient(): AlpacaClient {
  return {
    asset: async (symbol: string) => ({ id: symbol, symbol, class: "us_equity", status: "active", exchange: "ARCA", name: `${symbol} Trust` }),
    clock: async () => null,
    snapshots: async (symbols: readonly string[]) => Object.fromEntries(symbols.map((symbol) => [symbol, {
      latestTrade: { t: new Date().toISOString(), p: 500, s: 100 },
      dailyBar: { t: new Date().toISOString(), o: 499, h: 501, l: 498, c: 500, v: 1_000 },
    }])),
  } as unknown as AlpacaClient;
}

function trade(symbol: string) {
  return { T: "t", S: symbol, p: 500.5, s: 10, t: new Date().toISOString() };
}

describe("AlpacaProvider stream liveness", () => {
  beforeEach(installFakeSocket);
  afterEach(restoreSocket);

  test("reconnects a stream that fell silent while snapshots show new trades", async () => {
    const warnings: string[] = [];
    const provider = new AlpacaProvider(credentials, fakeClient(), { reseedMs: 30, staleStreamMs: 50 });
    provider.setLogger({ warn: (m) => warnings.push(m), error() {} });
    const deliveries: string[] = [];
    const stop = provider.subscribeQuotes([{ symbol: "SPY" }], (_target, quote) => deliveries.push(quote.delivery ?? "?"));

    const first = await latestSocket();
    first.openAuthenticated();
    await sleep(10);
    first.receive([trade("SPY")]);
    expect(deliveries).toContain("stream");
    expect(FakeSocket.instances).toHaveLength(1);

    // Nothing more arrives on the socket, while every reseed finds a newer print.
    await sleep(150);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    expect(warnings.some((m) => /silent|stale/i.test(m))).toBe(true);
    stop();
    provider.dispose();
  });

  test("leaves a stream alone while it keeps delivering", async () => {
    const warnings: string[] = [];
    const provider = new AlpacaProvider(credentials, fakeClient(), { reseedMs: 30, staleStreamMs: 50 });
    provider.setLogger({ warn: (m) => warnings.push(m), error() {} });
    const stop = provider.subscribeQuotes([{ symbol: "SPY" }], () => {});
    const first = await latestSocket();
    first.openAuthenticated();
    const feeder = setInterval(() => first.receive([trade("SPY")]), 10);
    await sleep(150);
    clearInterval(feeder);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    stop();
    provider.dispose();
  });
});
