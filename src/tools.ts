#!/usr/bin/env node
/**
 * MCP server — Extra utility tools for Talon.
 * Communicates with the main bot process via HTTP bridge.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = process.env.TALON_BRIDGE_URL || "http://127.0.0.1:19876";
const CHAT_ID = process.env.TALON_CHAT_ID || "";

async function callBridge(
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const resp = await fetch(`${BRIDGE_URL}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, _chatId: CHAT_ID, ...params }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bridge error (${resp.status}): ${text}`);
  }
  return resp.json();
}

function textResult(raw: unknown) {
  const r = raw as { ok: boolean; text?: string; error?: string };
  return { content: [{ type: "text" as const, text: r.ok ? (r.text ?? "Done.") : `Error: ${r.error ?? "unknown"}` }] };
}

const server = new McpServer({ name: "extras-tools", version: "1.1.0" });

server.tool(
  "convert_currency",
  `Convert between currencies using live ECB exchange rates.

Examples:
  convert_currency(amount=100, from="USD", to="EUR")
  convert_currency(amount=1, from="BTC", to="USD")  — crypto not supported, ECB fiat only
  convert_currency(from="GBP", to="ZAR")  — defaults to amount=1

Supports all major fiat currencies: USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, SEK, NOK, DKK, PLN, CZK, HUF, RON, BGN, HRK, ISK, TRY, BRL, CNY, HKD, IDR, ILS, INR, KRW, MXN, MYR, PHP, SGD, THB, ZAR.`,
  {
    amount: z.number().optional().describe("Amount to convert (default: 1)"),
    from: z.string().describe("Source currency code (e.g. USD, EUR, GBP)"),
    to: z.string().describe("Target currency code (e.g. EUR, ZAR, JPY)"),
  },
  async (params) => textResult(await callBridge("convert_currency", {
    amount: params.amount ?? 1,
    from: params.from,
    to: params.to,
  })),
);

server.tool(
  "get_weather",
  `Get current weather and forecast for a location.

Examples:
  get_weather(location="London")
  get_weather(location="Tokyo", forecast_days=3)
  get_weather(latitude=40.7128, longitude=-74.0060)  — New York by coordinates

Provides: current conditions (temperature, humidity, wind, UV), and daily forecast up to 7 days.
Uses Open-Meteo (free, no API key). Accepts city names (auto-geocoded) or lat/lon coordinates.`,
  {
    location: z.string().optional().describe("City or place name (e.g. 'Paris', 'Cape Town')"),
    latitude: z.number().optional().describe("Latitude (use instead of location name)"),
    longitude: z.number().optional().describe("Longitude (use instead of location name)"),
    forecast_days: z.number().optional().describe("Number of forecast days (1-7, default: 1)"),
  },
  async (params) => textResult(await callBridge("get_weather", {
    location: params.location,
    latitude: params.latitude,
    longitude: params.longitude,
    forecast_days: params.forecast_days ?? 1,
  })),
);

// ── Wikipedia tools ──────────────────────────────────────────────────────

server.tool(
  "search_wikipedia",
  `Search Wikipedia articles by keyword. Returns titles, snippets, and page IDs.

Examples:
  search_wikipedia(query="quantum computing")
  search_wikipedia(query="Ireland history", limit=10)
  search_wikipedia(query="Kraków", language="pl")`,
  {
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (1-20, default: 5)"),
    language: z.string().optional().describe("Wikipedia language code (default: 'en')"),
  },
  async (params) => textResult(await callBridge("search_wikipedia", {
    query: params.query,
    limit: params.limit ?? 5,
    language: params.language ?? "en",
  })),
);

server.tool(
  "get_wikipedia_summary",
  `Get a concise summary of a Wikipedia article (intro section only).

Examples:
  get_wikipedia_summary(title="Claude (language model)")
  get_wikipedia_summary(title="Dublin", language="en")`,
  {
    title: z.string().describe("Article title (exact or close match)"),
    language: z.string().optional().describe("Wikipedia language code (default: 'en')"),
  },
  async (params) => textResult(await callBridge("get_wikipedia_summary", {
    title: params.title,
    language: params.language ?? "en",
  })),
);

server.tool(
  "get_wikipedia_article",
  `Get the full text content of a Wikipedia article.

Examples:
  get_wikipedia_article(title="Anthropic")
  get_wikipedia_article(title="Chrzanów", language="pl")`,
  {
    title: z.string().describe("Article title (exact or close match)"),
    language: z.string().optional().describe("Wikipedia language code (default: 'en')"),
  },
  async (params) => textResult(await callBridge("get_wikipedia_article", {
    title: params.title,
    language: params.language ?? "en",
  })),
);

server.tool(
  "get_wikipedia_sections",
  `Get a specific section of a Wikipedia article by section title.

Examples:
  get_wikipedia_sections(title="Python (programming language)", section="History")`,
  {
    title: z.string().describe("Article title"),
    section: z.string().describe("Section heading to extract"),
    language: z.string().optional().describe("Wikipedia language code (default: 'en')"),
  },
  async (params) => textResult(await callBridge("get_wikipedia_sections", {
    title: params.title,
    section: params.section,
    language: params.language ?? "en",
  })),
);

server.tool(
  "get_wikipedia_links",
  `Get internal links from a Wikipedia article (useful for finding related topics).

Examples:
  get_wikipedia_links(title="Machine learning", limit=20)`,
  {
    title: z.string().describe("Article title"),
    limit: z.number().optional().describe("Max links to return (default: 20)"),
    language: z.string().optional().describe("Wikipedia language code (default: 'en')"),
  },
  async (params) => textResult(await callBridge("get_wikipedia_links", {
    title: params.title,
    limit: params.limit ?? 20,
    language: params.language ?? "en",
  })),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Extras MCP server failed:", err);
  process.exit(1);
});
