/**
 * Talon Extras plugin — extra utilities for Talon.
 *
 * Currently provides:
 *   - Real-time currency conversion (ECB rates via frankfurter.app)
 *   - Weather forecasts (Open-Meteo, no API key required)
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

const plugin = {
  name: "extras",
  description: "Extra utilities — currency conversion, weather, and more",
  version: "1.1.0",

  mcpServerPath: resolve(__dirname, "tools.ts"),

  async handleAction(
    body: Record<string, unknown>,
    _chatId: string,
  ): Promise<ActionResult | null> {
    if (body.action === "get_weather") return handleWeather(body);
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
You have access to a get_weather tool for current conditions and forecasts. Requires latitude/longitude — geocode city names first using the tool's built-in geocoding.`;
  },
} as const;

export default plugin;
