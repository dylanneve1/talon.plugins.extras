/**
 * Talon Extras plugin — extra utilities for Talon.
 *
 * Currently provides:
 *   - Real-time currency conversion (ECB rates via frankfurter.app)
 *   - Weather forecasts (Open-Meteo, no API key required)
 *   - Wikipedia search, articles, summaries, sections, and links (MediaWiki API)
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

// ── Wikipedia helpers (MediaWiki API) ─────────────────────────────────────

function wikiApi(lang: string): string {
  return `https://${lang}.wikipedia.org/w/api.php`;
}

async function wikiQuery(
  lang: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(wikiApi(lang));
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Wikipedia API error: ${resp.status}`);
  return resp.json() as Promise<Record<string, unknown>>;
}

async function handleSearchWikipedia(body: Record<string, unknown>): Promise<ActionResult> {
  const query = String(body.query ?? "").trim();
  if (!query) return { ok: false, error: "Missing query" };
  const limit = Math.min(20, Math.max(1, Number(body.limit ?? 5)));
  const lang = String(body.language ?? "en");

  try {
    const data = await wikiQuery(lang, {
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: String(limit),
      srprop: "snippet|size|wordcount",
    });
    const search = (data.query as Record<string, unknown>)?.search as Array<{
      title: string; pageid: number; snippet: string; size: number; wordcount: number;
    }> ?? [];
    if (search.length === 0) return { ok: true, text: `No Wikipedia results for "${query}".` };

    const results = search.map((r, i) => {
      const snippet = r.snippet.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      return `${i + 1}. **${r.title}** (${r.wordcount.toLocaleString()} words)\n   ${snippet}\n   https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`;
    }).join("\n\n");
    return { ok: true, text: `Wikipedia results for "${query}":\n\n${results}` };
  } catch (err) {
    return { ok: false, error: `Wikipedia search failed: ${err instanceof Error ? err.message : err}` };
  }
}

async function handleGetWikipediaSummary(body: Record<string, unknown>): Promise<ActionResult> {
  const title = String(body.title ?? "").trim();
  if (!title) return { ok: false, error: "Missing title" };
  const lang = String(body.language ?? "en");

  try {
    const data = await wikiQuery(lang, {
      action: "query",
      titles: title,
      prop: "extracts|info",
      exintro: "true",
      explaintext: "true",
      inprop: "url",
      redirects: "1",
    });
    const pages = (data.query as Record<string, unknown>)?.pages as Record<string, {
      title: string; extract?: string; fullurl?: string; missing?: string;
    }>;
    const page = Object.values(pages ?? {})[0];
    if (!page || page.missing !== undefined) return { ok: false, error: `Article not found: "${title}"` };
    if (!page.extract?.trim()) return { ok: true, text: `Article "${page.title}" exists but has no summary text.` };

    return { ok: true, text: `**${page.title}**\n${page.fullurl ?? ""}\n\n${page.extract}` };
  } catch (err) {
    return { ok: false, error: `Wikipedia summary failed: ${err instanceof Error ? err.message : err}` };
  }
}

async function handleGetWikipediaArticle(body: Record<string, unknown>): Promise<ActionResult> {
  const title = String(body.title ?? "").trim();
  if (!title) return { ok: false, error: "Missing title" };
  const lang = String(body.language ?? "en");

  try {
    const data = await wikiQuery(lang, {
      action: "query",
      titles: title,
      prop: "extracts|info",
      explaintext: "true",
      inprop: "url",
      redirects: "1",
    });
    const pages = (data.query as Record<string, unknown>)?.pages as Record<string, {
      title: string; extract?: string; fullurl?: string; missing?: string;
    }>;
    const page = Object.values(pages ?? {})[0];
    if (!page || page.missing !== undefined) return { ok: false, error: `Article not found: "${title}"` };
    if (!page.extract?.trim()) return { ok: true, text: `Article "${page.title}" exists but has no text content.` };

    // Truncate very long articles to avoid token overflow
    const MAX_LENGTH = 15_000;
    const text = page.extract.length > MAX_LENGTH
      ? page.extract.slice(0, MAX_LENGTH) + "\n\n[... truncated — article is too long. Use get_wikipedia_sections to read specific sections.]"
      : page.extract;

    return { ok: true, text: `**${page.title}**\n${page.fullurl ?? ""}\n\n${text}` };
  } catch (err) {
    return { ok: false, error: `Wikipedia article failed: ${err instanceof Error ? err.message : err}` };
  }
}

async function handleGetWikipediaSections(body: Record<string, unknown>): Promise<ActionResult> {
  const title = String(body.title ?? "").trim();
  const sectionName = String(body.section ?? "").trim();
  if (!title) return { ok: false, error: "Missing title" };
  if (!sectionName) return { ok: false, error: "Missing section name" };
  const lang = String(body.language ?? "en");

  try {
    // First get the section list
    const tocData = await wikiQuery(lang, {
      action: "parse",
      page: title,
      prop: "sections",
      redirects: "1",
    });
    const sections = (tocData.parse as Record<string, unknown>)?.sections as Array<{
      toclevel: number; number: string; line: string; index: string;
    }> ?? [];

    // Find matching section (case-insensitive)
    const target = sectionName.toLowerCase();
    const match = sections.find(s => s.line.toLowerCase() === target);
    if (!match) {
      const available = sections.map(s => `  - ${s.line}`).join("\n");
      return { ok: false, error: `Section "${sectionName}" not found in "${title}".\n\nAvailable sections:\n${available}` };
    }

    // Get section content
    const data = await wikiQuery(lang, {
      action: "parse",
      page: title,
      prop: "wikitext",
      section: match.index,
      redirects: "1",
    });
    const wikitext = (data.parse as Record<string, unknown>)?.wikitext as Record<string, string> | undefined;
    const raw = wikitext?.["*"] ?? "";

    // Strip basic wikitext markup for readability
    const cleaned = raw
      .replace(/\{\{[^}]*\}\}/g, "")          // remove templates
      .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1") // [[link|text]] → text
      .replace(/<ref[^>]*>.*?<\/ref>/gs, "")   // remove references
      .replace(/<ref[^/]*\/>/g, "")             // self-closing refs
      .replace(/<\/?[^>]+>/g, "")               // HTML tags
      .replace(/'{2,3}/g, "")                   // bold/italic markers
      .replace(/\n{3,}/g, "\n\n")              // collapse blank lines
      .trim();

    if (!cleaned) return { ok: true, text: `Section "${match.line}" exists but has no readable content.` };
    return { ok: true, text: `**${title} — ${match.line}**\n\n${cleaned}` };
  } catch (err) {
    return { ok: false, error: `Wikipedia sections failed: ${err instanceof Error ? err.message : err}` };
  }
}

async function handleGetWikipediaLinks(body: Record<string, unknown>): Promise<ActionResult> {
  const title = String(body.title ?? "").trim();
  if (!title) return { ok: false, error: "Missing title" };
  const limit = Math.min(500, Math.max(1, Number(body.limit ?? 20)));
  const lang = String(body.language ?? "en");

  try {
    const data = await wikiQuery(lang, {
      action: "query",
      titles: title,
      prop: "links",
      pllimit: String(limit),
      plnamespace: "0", // main namespace only
      redirects: "1",
    });
    const pages = (data.query as Record<string, unknown>)?.pages as Record<string, {
      title: string; links?: Array<{ title: string }>; missing?: string;
    }>;
    const page = Object.values(pages ?? {})[0];
    if (!page || page.missing !== undefined) return { ok: false, error: `Article not found: "${title}"` };
    const links = page.links ?? [];
    if (links.length === 0) return { ok: true, text: `No internal links found in "${page.title}".` };

    const formatted = links.map(l => `- ${l.title}`).join("\n");
    return { ok: true, text: `Internal links from "${page.title}" (${links.length}):\n\n${formatted}` };
  } catch (err) {
    return { ok: false, error: `Wikipedia links failed: ${err instanceof Error ? err.message : err}` };
  }
}

const plugin = {
  name: "extras",
  description: "Extra utilities — currency conversion, weather, Wikipedia, and more",
  version: "1.4.0",

  mcpServerPath: resolve(__dirname, "tools.ts"),

  async handleAction(
    body: Record<string, unknown>,
    _chatId: string,
  ): Promise<ActionResult | null> {
    if (body.action === "get_weather") return handleWeather(body);
    if (body.action === "search_wikipedia") return handleSearchWikipedia(body);
    if (body.action === "get_wikipedia_summary") return handleGetWikipediaSummary(body);
    if (body.action === "get_wikipedia_article") return handleGetWikipediaArticle(body);
    if (body.action === "get_wikipedia_sections") return handleGetWikipediaSections(body);
    if (body.action === "get_wikipedia_links") return handleGetWikipediaLinks(body);
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

## Wikipedia
You have access to Wikipedia tools for searching and reading articles:
- \`search_wikipedia\` — search articles by keyword
- \`get_wikipedia_summary\` — get a concise intro summary
- \`get_wikipedia_article\` — get full article text (truncated at 15k chars for long articles)
- \`get_wikipedia_sections\` — extract a specific section by heading
- \`get_wikipedia_links\` — list internal links (related topics)
All tools support a \`language\` parameter for non-English Wikipedias (e.g. "pl", "ja", "de").`;
  },
} as const;

export default plugin;
