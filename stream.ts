/**
 * One websocket to Alpaca's IEX stream, shared by every quote subscription.
 *
 * A free Alpaca account may hold one streaming connection, so the socket is
 * opened when the first symbol is wanted, keeps a reference count per symbol,
 * and closes once nothing is wanted. It re-authenticates and re-subscribes
 * after a drop, backing off up to half a minute.
 */
import type { CredentialStore } from "./credentials";
import { STREAM_URL } from "./alpaca-client";
import type { StreamQuote, StreamTrade } from "./quotes";

export interface StreamLogger {
  warn(message: string): void;
  error(message: string): void;
  /** Something the person should see once, not only in the debug log; falls back to warn(). */
  notice?(message: string): void;
}

export interface StreamOptions {
  /** How long to wait before retrying when another process holds the account's one connection. */
  connectionLimitRetryMs?: number;
}

export interface StreamHandlers {
  onTrade(trade: StreamTrade): void;
  onQuote(quote: StreamQuote): void;
  /** The stream can carry data again (after the first or a later authentication). */
  onReady?(): void;
}

interface ControlMessage {
  T: "success" | "error" | "subscription";
  msg?: string;
  code?: number;
  trades?: string[];
  quotes?: string[];
}

type StreamMessage = ControlMessage | StreamTrade | StreamQuote | { T: string };

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
/** "connection limit exceeded": another process holds the account's one connection; try again later. */
const CONNECTION_LIMIT_RETRY_MS = 30_000;
const AUTH_ERROR_CODES = new Set([401, 402, 403, 404]);

export function hasWebSocket(): boolean {
  return typeof WebSocket !== "undefined";
}

export class AlpacaIexStream {
  private socket: WebSocket | null = null;
  private authenticated = false;
  private wanted = new Map<string, number>();
  private subscribed = new Set<string>();
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private disposed = false;
  private authFailed = false;
  /** The connection-limit refusal has been reported and not yet lifted by an authentication. */
  private connectionLimitReported = false;
  private readonly connectionLimitRetryMs: number;

  constructor(
    private readonly credentials: CredentialStore,
    private readonly handlers: StreamHandlers,
    private readonly log?: StreamLogger,
    options?: StreamOptions,
  ) {
    this.connectionLimitRetryMs = options?.connectionLimitRetryMs ?? CONNECTION_LIMIT_RETRY_MS;
  }

  /** Wants trades and quotes for these symbols until the returned function is called. */
  subscribe(symbols: readonly string[]): () => void {
    const added = symbols.map((symbol) => symbol.toUpperCase());
    for (const symbol of added) this.wanted.set(symbol, (this.wanted.get(symbol) ?? 0) + 1);
    this.ensureConnection();
    this.flushSubscriptions();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const symbol of added) {
        const count = (this.wanted.get(symbol) ?? 1) - 1;
        if (count <= 0) this.wanted.delete(symbol);
        else this.wanted.set(symbol, count);
      }
      this.flushSubscriptions();
      if (this.wanted.size === 0) this.closeSocket();
    };
  }

  get isLive(): boolean {
    return this.authenticated && this.socket?.readyState === WebSocket.OPEN;
  }

  dispose(): void {
    this.disposed = true;
    this.wanted.clear();
    this.closeSocket();
  }

  private ensureConnection(): void {
    if (this.disposed || this.authFailed || this.socket || this.connecting || this.wanted.size === 0) return;
    if (!hasWebSocket()) return;
    this.connecting = true;
    void this.connect();
  }

  private async connect(): Promise<void> {
    const credentials = await this.credentials.resolve();
    if (!credentials) {
      this.connecting = false;
      this.log?.warn("Alpaca stream: no API key pair, quotes stay on polling.");
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(STREAM_URL);
    } catch (error) {
      this.connecting = false;
      this.log?.error(`Alpaca stream: could not open the socket: ${String(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.connecting = false;
      // The server greets with {"T":"success","msg":"connected"}; authentication is sent on that.
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleMessage(String(event.data), credentials);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.log?.warn("Alpaca stream: socket error.");
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connecting = false;
      this.authenticated = false;
      this.subscribed.clear();
      if (this.disposed || this.wanted.size === 0 || this.authFailed) return;
      this.log?.warn(`Alpaca stream: closed (${event.code}${event.reason ? ` ${event.reason}` : ""}); reconnecting.`);
      this.scheduleReconnect();
    };
  }

  private handleMessage(raw: string, credentials: { keyId: string; secretKey: string }): void {
    let messages: StreamMessage[];
    try {
      const parsed = JSON.parse(raw) as StreamMessage | StreamMessage[];
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return;
    }
    for (const message of messages) {
      switch (message.T) {
        case "t":
          this.handlers.onTrade(message as StreamTrade);
          break;
        case "q":
          this.handlers.onQuote(message as StreamQuote);
          break;
        case "success": {
          const control = message as ControlMessage;
          if (control.msg === "connected") {
            this.send({ action: "auth", key: credentials.keyId, secret: credentials.secretKey });
          } else if (control.msg === "authenticated") {
            this.authenticated = true;
            this.reconnectDelay = INITIAL_RECONNECT_MS;
            this.subscribed.clear();
            this.flushSubscriptions();
            if (this.connectionLimitReported) {
              this.connectionLimitReported = false;
              this.notice("Alpaca stream: the connection is free again; streaming quotes.");
            }
            this.handlers.onReady?.();
          }
          break;
        }
        case "subscription": {
          const control = message as ControlMessage;
          this.subscribed = new Set((control.trades ?? []).map((symbol) => symbol.toUpperCase()));
          break;
        }
        case "error": {
          const control = message as ControlMessage;
          const code = control.code ?? 0;
          if (AUTH_ERROR_CODES.has(code)) {
            this.authFailed = true;
            this.log?.error(`Alpaca stream: ${control.msg ?? "authentication failed"} (${code}); streaming is off until the keys change.`);
            this.closeSocket();
          } else if (code === 406) {
            // A free Alpaca account holds one stream: another Gloomberb (terminal, desktop, or a CLI
            // subscribe) or another program has it. Say so once; quotes keep polling every minute.
            if (!this.connectionLimitReported) {
              this.connectionLimitReported = true;
              this.notice(
                "Alpaca stream: the account's one streaming connection is in use by another process "
                + "(another Gloomberb window or CLI, or another program); quotes poll every minute until it is free.",
              );
            }
            this.reconnectDelay = this.connectionLimitRetryMs;
            this.closeSocket();
            this.scheduleReconnect();
          } else {
            this.log?.warn(`Alpaca stream: ${control.msg ?? "error"} (${code}).`);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private notice(message: string): void {
    if (!this.log) return;
    if (this.log.notice) this.log.notice(message);
    else this.log.warn(message);
  }

  /** Lets a later key change lift an authentication failure. */
  resetAuthFailure(): void {
    this.authFailed = false;
    this.ensureConnection();
  }

  private flushSubscriptions(): void {
    if (!this.isLive) return;
    const wanted = new Set(this.wanted.keys());
    const add = [...wanted].filter((symbol) => !this.subscribed.has(symbol));
    const remove = [...this.subscribed].filter((symbol) => !wanted.has(symbol));
    if (add.length > 0) this.send({ action: "subscribe", trades: add, quotes: add });
    if (remove.length > 0) this.send({ action: "unsubscribe", trades: remove, quotes: remove });
    // The server confirms with a "subscription" message; assume success meanwhile so a burst does not resend.
    for (const symbol of add) this.subscribed.add(symbol);
    for (const symbol of remove) this.subscribed.delete(symbol);
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      this.log?.warn(`Alpaca stream: send failed: ${String(error)}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnection();
    }, delay);
  }

  private closeSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.subscribed.clear();
    this.connecting = false;
    if (!socket) return;
    try {
      socket.onclose = null;
      socket.close();
    } catch {
      // Already closed.
    }
  }
}
