/**
 * Talon Extras plugin — extra utilities for Talon.
 *
 * Currently provides:
 *   - Real-time currency conversion (ECB rates via frankfurter.app)
 *   - Weather forecasts (Open-Meteo, no API key required)
 *   - News headlines (Google News RSS, no API key required)
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ActionResult {
  ok: boolean;
  text?: string;
  error?: string;
}

// ── WMO weather code descriptions ─────────────────────────────────────────

const WMO_CODES: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Foggy", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

type GeoResult = { name: string; latitude: number; longitude: number; country?: string; admin1?: string };

async function geocode(location: string): Promise<GeoResult | null> {
  const resp = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!resp.ok) return null;
  const data = await resp.json() as { results?: GeoResult[] };
  return data.results?.[0] ?? null;
}

async function handleWeather(body: Record<string, unknown>): Promise<ActionResult> {
  const location = String(body.location ?? "").trim();
  let lat = body.latitude !== undefined ? Number(body.latitude) : undefined;
  let lon = body.longitude !== undefined ? Number(body.longitude) : undefined;
  const days = Math.min(7, Math.max(1, Number(body.forecast_days ?? 1)));
  let locationName = location;

  // Geocode if lat/lon not provided
  if ((lat === undefined || lon === undefined) && location) {
    const geo = await geocode(location);
    if (!geo) return { ok: false, error: `Could not find location: "${location}"` };
    lat = geo.latitude;
    lon = geo.longitude;
    locationName = [geo.name, geo.admin1, geo.country].filter(Boolean).join(", ");
  }
  if (lat === undefined || lon === undefined) {
    return { ok: false, error: "Provide either a location name or latitude/longitude" };
  }

  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,uv_index",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,uv_index_max,sunrise,sunset",
      forecast_days: String(days),
      timezone: "auto",
    });
    const resp = await fetch(
      `https://api.open-meteo.com/v1/forecast?${params}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { ok: false, error: `Weather API error: ${resp.status} ${errText.slice(0, 200)}` };
    }

    type CurrentData = {
      temperature_2m: number; relative_humidity_2m: number; apparent_temperature: number;
      weather_code: number; wind_speed_10m: number; wind_direction_10m: number; uv_index: number;
    };
    type DailyData = {
      time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[];
      precipitation_sum: number[]; wind_speed_10m_max: number[]; uv_index_max: number[];
      sunrise: string[]; sunset: string[];
    };
    type Units = Record<string, string>;

    const data = await resp.json() as { current: CurrentData; daily: DailyData; current_units: Units; daily_units: Units; timezone: string };
    const c = data.current;
    const cu = data.current_units;
    const d = data.daily;

    const windDir = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    const dirLabel = windDir[Math.round(c.wind_direction_10m / 22.5) % 16];

    const lines: string[] = [
      `Weather for ${locationName} (${lat.toFixed(2)}, ${lon.toFixed(2)})`,
      `Timezone: ${data.timezone}`,
      "",
      `Current: ${WMO_CODES[c.weather_code] ?? "Unknown"}`,
      `  Temperature: ${c.temperature_2m}${cu.temperature_2m} (feels like ${c.apparent_temperature}${cu.apparent_temperature})`,
      `  Humidity: ${c.relative_humidity_2m}${cu.relative_humidity_2m}`,
      `  Wind: ${c.wind_speed_10m} ${cu.wind_speed_10m} ${dirLabel}`,
      `  UV Index: ${c.uv_index}`,
    ];

    if (days > 1 || d.time.length > 0) {
      lines.push("", "Forecast:");
      for (let i = 0; i < d.time.length; i++) {
        const sunrise = d.sunrise[i]?.split("T")[1] ?? "";
        const sunset = d.sunset[i]?.split("T")[1] ?? "";
        lines.push(
          `  ${d.time[i]}: ${WMO_CODES[d.weather_code[i]] ?? "Unknown"} ${d.temperature_2m_min[i]}–${d.temperature_2m_max[i]}${cu.temperature_2m} | Rain: ${d.precipitation_sum[i]}${data.daily_units.precipitation_sum} | Wind: ${d.wind_speed_10m_max[i]} ${data.daily_units.wind_speed_10m_max} | UV: ${d.uv_index_max[i]} | ☀ ${sunrise}–${sunset}`,
        );
      }
    }

    return { ok: true, text: lines.join("\n") };
  } catch (err) {
    return { ok: false, error: `Weather fetch failed: ${err instanceof Error ? err.message : err}` };
  }
}

// ── Google News RSS ───────────────────────────────────────────────────────

const TOPIC_IDS: Record<string, string> = {
  world: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB",
  nation: "CAAqIggKIhxDQkFTRHdvSkwyMHZNRFZxYUdjU0FtVnVLQUFQAQ",
  business: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB",
  technology: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB",
  entertainment: "CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB",
  sports: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB",
  science: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FtVnVHZ0pWVXlnQVAB",
  health: "CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ",
};

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
}

function parseRssItems(xml: string, limit: number): Array<{ title: string; source: string; published: string; url: string; snippet: string }> {
  const items: Array<{ title: string; source: string; published: string; url: string; snippet: string }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const content = match[1];
    const title = content.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const link = content.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "";
    const pubDate = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "";
    const description = content.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "";
    const source = content.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "";

    // Clean title (Google News appends " - Source Name")
    const cleanTitle = title.replace(/ - [^-]+$/, "").trim();
    const sourceName = source || title.match(/ - ([^-]+)$/)?.[1]?.trim() || "Unknown";

    items.push({
      title: stripHtml(cleanTitle),
      source: stripHtml(sourceName),
      published: pubDate ? new Date(pubDate).toISOString() : "",
      url: stripHtml(link),
      snippet: stripHtml(description).slice(0, 300),
    });
  }
  return items;
}

async function handleNews(body: Record<string, unknown>): Promise<ActionResult> {
  const query = String(body.query ?? "").trim();
  const topic = String(body.topic ?? "").trim().toLowerCase();
  const country = String(body.country ?? "US").trim().toUpperCase();
  const limit = Math.min(20, Math.max(1, Number(body.limit ?? 5)));
  const lang = country === "PL" ? "pl" : country === "DE" ? "de" : country === "FR" ? "fr" : "en";

  let url: string;
  if (query) {
    url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${lang}&gl=${country}&ceid=${country}:${lang}`;
  } else if (topic && TOPIC_IDS[topic]) {
    url = `https://news.google.com/rss/topics/${TOPIC_IDS[topic]}?hl=${lang}&gl=${country}&ceid=${country}:${lang}`;
  } else {
    url = `https://news.google.com/rss?hl=${lang}&gl=${country}&ceid=${country}:${lang}`;
  }

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return { ok: false, error: `Google News RSS error: ${resp.status}` };
    const xml = await resp.text();
    const articles = parseRssItems(xml, limit);
    if (articles.length === 0) return { ok: true, text: "No articles found." };

    const lines = articles.map((a, i) =>
      `${i + 1}. **${a.title}**\n   Source: ${a.source} | ${a.published ? new Date(a.published).toLocaleDateString() : "Unknown date"}\n   ${a.url}`,
    );
    const header = query ? `News results for "${query}"` : topic ? `Top ${topic} headlines` : "Top headlines";
    return { ok: true, text: `${header} (${country}):\n\n${lines.join("\n\n")}` };
  } catch (err) {
    return { ok: false, error: `News fetch failed: ${err instanceof Error ? err.message : err}` };
  }
}

const plugin = {
  name: "extras",
  description: "Extra utilities — currency conversion, weather, news, and more",
  version: "1.2.0",

  mcpServerPath: resolve(__dirname, "tools.ts"),

  async handleAction(
    body: Record<string, unknown>,
    _chatId: string,
  ): Promise<ActionResult | null> {
    if (body.action === "get_weather") return handleWeather(body);
    if (body.action === "get_news") return handleNews(body);
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
Supports all major fiat currencies: USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, SEK, NOK, DKK, PLN, CZK, HUF, RON, BGN, HRK, ISK, TRY, BRL, CNY, HKD, IDR, ILS, INR, KRW, MXN, MYR, PHP, SGD, THB, ZAR.

## Weather
You have access to a get_weather tool for current conditions and forecasts. Requires latitude/longitude — geocode city names first using the tool's built-in geocoding.

## News
You have access to a get_news tool for fetching news headlines from Google News RSS. Search by query or browse by topic (world, nation, business, technology, entertainment, sports, science, health). Supports country filtering (IE, US, PL, etc).`;
  },
} as const;

export default plugin;
