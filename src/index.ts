/**
 * Currency Converter plugin for Talon.
 *
 * Provides real-time currency conversion using ECB exchange rates
 * via the frankfurter.app API.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ActionResult {
  ok: boolean;
  text?: string;
  error?: string;
}

const plugin = {
  name: "currency-converter",
  description: "Real-time currency conversion using ECB exchange rates",
  version: "1.0.0",

  mcpServerPath: resolve(__dirname, "tools.ts"),

  async handleAction(
    body: Record<string, unknown>,
    _chatId: string,
  ): Promise<ActionResult | null> {
    if (body.action !== "convert_currency") return null;

    const amount = Number(body.amount ?? 1);
    const from = String(body.from ?? "").toUpperCase();
    const to = String(body.to ?? "").toUpperCase();
    if (!from) return { ok: false, error: "Missing 'from' currency code (e.g. USD)" };
    if (!to) return { ok: false, error: "Missing 'to' currency code (e.g. EUR)" };
    if (isNaN(amount) || amount <= 0) return { ok: false, error: "Invalid amount" };

    try {
      // frankfurter.app — free, no API key, ECB rates, reliable
      const resp = await fetch(
        `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        return { ok: false, error: `Currency API error: ${resp.status} ${errBody.slice(0, 200)}` };
      }
      const data = await resp.json() as { base: string; date: string; rates: Record<string, number> };
      const rate = data.rates[to];
      if (rate === undefined) return { ok: false, error: `Unknown currency: ${to}` };
      const converted = amount * rate;
      return {
        ok: true,
        text: `${amount.toLocaleString()} ${from} = ${converted.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${to}\nRate: 1 ${from} = ${rate} ${to} (ECB, ${data.date})`,
      };
    } catch (err) {
      return { ok: false, error: `Currency conversion failed: ${err instanceof Error ? err.message : err}` };
    }
  },

  getSystemPromptAddition(): string {
    return `## Currency Converter
You have access to a convert_currency tool for real-time currency conversion using ECB exchange rates.
Supports all major fiat currencies: USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, SEK, NOK, DKK, PLN, CZK, HUF, RON, BGN, HRK, ISK, TRY, BRL, CNY, HKD, IDR, ILS, INR, KRW, MXN, MYR, PHP, SGD, THB, ZAR.`;
  },
} as const;

export default plugin;
