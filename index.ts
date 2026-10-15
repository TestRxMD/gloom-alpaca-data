/**
 * Alpaca Market Data for Gloomberb.
 *
 * Registers one `asset-data` capability, ahead of Gloom Cloud, that answers
 * US equity quotes, streamed trades, bars and options chains from Alpaca's
 * free IEX feed. Fundamentals, filings, news, FX and non-US listings stay with
 * Gloom Cloud.
 */
import { assetDataProvider } from "gloomberb/capabilities";
import type { GloomPlugin } from "gloomberb/types/plugin";
import { CredentialStore, credentialsFromValues, PLUGIN_ID } from "./credentials";
import { AlpacaProvider } from "./provider";

export const credentials = new CredentialStore();
export const alpacaProvider = new AlpacaProvider(credentials);

export const alpacaDataPlugin = {
  id: PLUGIN_ID,
  name: "Alpaca Market Data",
  version: "0.1.0",
  description: "Real-time US equity quotes, charts and options chains from Alpaca's free IEX feed",
  toggleable: true,
  hosts: ["data.alpaca.markets", "stream.data.alpaca.markets", "paper-api.alpaca.markets", "api.alpaca.markets"],
  configSchema: [
    {
      key: "keyId",
      label: "API key ID",
      type: "password",
      description: "From app.alpaca.markets: a paper or live key pair; the free Market Data plan comes with either.",
    },
    {
      key: "secretKey",
      label: "API secret key",
      type: "password",
      description: "Shown once when the key pair is generated.",
    },
    {
      key: "keyType",
      label: "Key type",
      type: "select",
      required: false,
      defaultValue: "paper",
      options: [
        { label: "Paper trading keys", value: "paper" },
        { label: "Live trading keys", value: "live" },
      ],
      description: "Which Alpaca account the pair belongs to; market data is the same for both.",
    },
  ],
  isConfigured(values) {
    return credentialsFromValues(values) != null || credentials.hasEnvironmentKeys();
  },
  capabilities: [assetDataProvider(alpacaProvider)],

  setup(ctx) {
    const apply = (values: Record<string, unknown> | null | undefined) => {
      credentials.setConfigured(values);
      alpacaProvider.credentialsChanged();
    };
    apply({
      keyId: ctx.configState.get("keyId"),
      secretKey: ctx.configState.get("secretKey"),
      keyType: ctx.configState.get("keyType"),
    });
    ctx.on("config:changed", ({ config }) => apply(config.pluginConfig?.[PLUGIN_ID]));
    alpacaProvider.setLogger({
      warn: (message) => ctx.log.warn(message),
      error: (message) => ctx.log.error(message),
    });
  },

  dispose() {
    alpacaProvider.dispose();
  },
} satisfies GloomPlugin;

export default alpacaDataPlugin;
