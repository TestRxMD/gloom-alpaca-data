/** A scripted WebSocket for tests: the test opens it, feeds it server messages, and reads what was sent. */
export class FakeSocket {
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
  /** Connects and lets the server greet, which makes the client authenticate. */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.({});
    this.receive([{ T: "success", msg: "connected" }]);
  }
  /** Connects, greets and authenticates in one step. */
  openAuthenticated() {
    this.open();
    this.receive([{ T: "success", msg: "authenticated" }]);
  }
  receive(messages: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(messages) });
  }
}

const originalWebSocket = globalThis.WebSocket;

export function installFakeSocket(): void {
  FakeSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
}

export function restoreSocket(): void {
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
}

/** The socket opened most recently, after letting pending promises settle. */
export async function latestSocket(): Promise<FakeSocket> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket was opened");
  return socket;
}
