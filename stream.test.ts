import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CredentialStore } from "./credentials";
import { AlpacaIexStream } from "./stream";

/** A scripted WebSocket: the test opens it, feeds it server messages, and reads what was sent. */
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.({});
    this.receive([{ T: "success", msg: "connected" }]);
  }
  receive(messages: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(messages) });
  }
}

const credentials = { resolve: async () => ({ keyId: "key", secretKey: "secret", keyType: "paper" as const }) } as unknown as CredentialStore;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const originalWebSocket = globalThis.WebSocket;

function logger() {
  const warnings: string[] = [];
  const errors: string[] = [];
  const notices: string[] = [];
  return {
    warnings, errors, notices,
    log: { warn: (m: string) => warnings.push(m), error: (m: string) => errors.push(m), notice: (m: string) => notices.push(m) },
  };
}

async function latestSocket(): Promise<FakeSocket> {
  await tick();
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket was opened");
  return socket;
}

describe("AlpacaIexStream connection limit", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  test("says once that another process holds the connection, and once when streaming starts", async () => {
    const { log, notices, warnings } = logger();
    const stream = new AlpacaIexStream(credentials, { onTrade() {}, onQuote() {} }, log, { connectionLimitRetryMs: 10 });
    stream.subscribe(["AAPL"]);

    const first = await latestSocket();
    first.open();
    expect(first.sent).toHaveLength(1);
    first.receive([{ T: "error", code: 406, msg: "connection limit exceeded" }]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/connection/i);

    // The retry is refused again: no second notice.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await latestSocket();
    expect(second).not.toBe(first);
    second.open();
    second.receive([{ T: "error", code: 406, msg: "connection limit exceeded" }]);
    expect(notices).toHaveLength(1);
    expect(warnings).toHaveLength(0);

    // The other process went away: the retry authenticates and the symbols are subscribed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const third = await latestSocket();
    third.open();
    third.receive([{ T: "success", msg: "authenticated" }]);
    expect(stream.isLive).toBe(true);
    expect(third.sent.at(-1)).toContain('"subscribe"');
    expect(third.sent.at(-1)).toContain("AAPL");
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatch(/streaming/i);

    // A later refusal is reported again, once.
    third.onclose?.({ code: 1006, reason: "" });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const fourth = await latestSocket();
    fourth.open();
    fourth.receive([{ T: "error", code: 406, msg: "connection limit exceeded" }]);
    expect(notices).toHaveLength(3);
    stream.dispose();
  });

  test("a logger without notice() still hears about it once, as a warning", async () => {
    const warnings: string[] = [];
    const stream = new AlpacaIexStream(credentials, { onTrade() {}, onQuote() {} }, { warn: (m) => warnings.push(m), error() {} }, { connectionLimitRetryMs: 10 });
    stream.subscribe(["SPY"]);
    const first = await latestSocket();
    first.open();
    first.receive([{ T: "error", code: 406, msg: "connection limit exceeded" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await latestSocket();
    second.open();
    second.receive([{ T: "error", code: 406, msg: "connection limit exceeded" }]);
    expect(warnings).toHaveLength(1);
    stream.dispose();
  });
});
