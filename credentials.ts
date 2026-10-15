/**
 * Where the Alpaca key pair comes from.
 *
 * In the terminal and desktop app the plugin's `setup()` reads the pair the
 * user entered in the Plugins pane and hands it here. A CLI command such as
 * `gloomberb quote` registers the plugin's capabilities without running
 * `setup()`, so the store also reads the saved config file itself, and the
 * environment for people who keep the pair in a shell profile.
 */

export type AlpacaKeyType = "paper" | "live";

export interface AlpacaCredentials {
  keyId: string;
  secretKey: string;
  keyType: AlpacaKeyType;
}

export const PLUGIN_ID = "alpaca-data";

const FILE_CACHE_TTL_MS = 30_000;

declare const Bun: { file(path: string): { text(): Promise<string> } } | undefined;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function keyType(value: unknown): AlpacaKeyType {
  return text(value).toLowerCase() === "live" ? "live" : "paper";
}

/** The pair a record of config values holds, or null when it is incomplete. */
export function credentialsFromValues(values: Record<string, unknown> | null | undefined): AlpacaCredentials | null {
  const keyId = text(values?.keyId);
  const secretKey = text(values?.secretKey);
  if (!keyId || !secretKey) return null;
  return { keyId, secretKey, keyType: keyType(values?.keyType) };
}

function environment(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/** The pair the environment holds: Alpaca's own variable names, or the ones its SDK examples use. */
export function credentialsFromEnvironment(env: Record<string, string | undefined> = environment()): AlpacaCredentials | null {
  const keyId = text(env.APCA_API_KEY_ID) || text(env.ALPACA_API_KEY) || text(env.ALPACA_API_KEY_ID);
  const secretKey = text(env.APCA_API_SECRET_KEY) || text(env.ALPACA_SECRET_KEY) || text(env.ALPACA_API_SECRET_KEY);
  if (!keyId || !secretKey) return null;
  const paperFlag = text(env.ALPACA_PAPER).toLowerCase();
  const live = paperFlag === "false" || paperFlag === "0" || paperFlag === "no"
    || (!paperFlag && /^https:\/\/api\.alpaca\.markets/.test(text(env.APCA_API_BASE_URL)));
  return { keyId, secretKey, keyType: live ? "live" : "paper" };
}

/** Candidate config files, most specific first: the override, the classic folder, the Linux XDG folder. */
export function configFileCandidates(env: Record<string, string | undefined> = environment()): string[] {
  const home = text(env.HOME) || text(env.USERPROFILE);
  const override = text(env.GLOOMBERB_HOME);
  const candidates: string[] = [];
  if (override) candidates.push(`${override.replace(/\/+$/, "")}/config.json`);
  if (home) {
    candidates.push(`${home}/.gloomberb/config.json`);
    const xdg = text(env.XDG_CONFIG_HOME) || `${home}/.config`;
    candidates.push(`${xdg}/gloomberb/config.json`);
  }
  return candidates;
}

async function readConfigFile(path: string): Promise<Record<string, unknown> | null> {
  if (typeof Bun === "undefined" || typeof Bun?.file !== "function") return null;
  try {
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as { pluginConfig?: Record<string, Record<string, unknown>> };
    return parsed.pluginConfig?.[PLUGIN_ID] ?? null;
  } catch {
    return null;
  }
}

export class CredentialStore {
  private configured: AlpacaCredentials | null | undefined;
  private fileCache: { at: number; value: AlpacaCredentials | null } | null = null;

  /** Values from the plugin's config form; `null` or an incomplete record clears them. */
  setConfigured(values: Record<string, unknown> | null | undefined): void {
    this.configured = credentialsFromValues(values);
  }

  /** Whether `setup()` has handed over a usable pair. */
  hasConfigured(): boolean {
    return this.configured != null;
  }

  hasEnvironmentKeys(): boolean {
    return credentialsFromEnvironment() != null;
  }

  /** The pair to use now: the form's, else the environment's, else the saved config file's. */
  async resolve(): Promise<AlpacaCredentials | null> {
    if (this.configured) return this.configured;
    const fromEnvironment = credentialsFromEnvironment();
    if (fromEnvironment) return fromEnvironment;
    return this.fromConfigFile();
  }

  private async fromConfigFile(): Promise<AlpacaCredentials | null> {
    const now = Date.now();
    if (this.fileCache && now - this.fileCache.at < FILE_CACHE_TTL_MS) return this.fileCache.value;
    let value: AlpacaCredentials | null = null;
    for (const path of configFileCandidates()) {
      value = credentialsFromValues(await readConfigFile(path));
      if (value) break;
    }
    this.fileCache = { at: now, value };
    return value;
  }
}
