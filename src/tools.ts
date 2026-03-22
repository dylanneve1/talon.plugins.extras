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

const server = new McpServer({ name: "extras-tools", version: "1.0.0" });

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

server.tool(
  "get_news",
  `Fetch news headlines from Google News RSS. Search by query or browse by topic.

Examples:
  get_news(query="Iran war")  — search for specific news
  get_news(topic="technology")  — browse tech headlines
  get_news(topic="world", country="IE")  — world news for Ireland
  get_news(query="oil prices", limit=10)  — more results

Topics: world, nation, business, technology, entertainment, sports, science, health.
Countries: any 2-letter code (US, IE, PL, GB, IN, etc). Default: US.`,
  {
    query: z.string().optional().describe("Search query (e.g. 'AI regulation', 'Ukraine')"),
    topic: z.string().optional().describe("Topic category: world, nation, business, technology, entertainment, sports, science, health"),
    country: z.string().optional().describe("Country code (e.g. IE, US, PL). Default: US"),
    limit: z.number().optional().describe("Number of articles to return (1-20, default: 5)"),
  },
  async (params) => textResult(await callBridge("get_news", {
    query: params.query,
    topic: params.topic,
    country: params.country,
    limit: params.limit ?? 5,
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
