// Weather for deals, via Open-Meteo (https://open-meteo.com) — free, no API
// key/signup required, zero dependencies (plain fetch, same pattern as
// lib/travelpayouts.js and lib/viator.js).
//
// CONFIDENCE NOTE (read before relying on this in production): Open-Meteo's
// endpoints, parameters, and the { daily: { time, temperature_2m_max,
// temperature_2m_min, weathercode } } response shape are all confirmed
// against Open-Meteo's published docs (https://open-meteo.com/en/docs and
// .../en/docs/historical-weather-api) — this is a long-stable, widely-used
// public API, not a guess. What's NOT independently verified here is a live
// response, since this sandbox couldn't complete a JSON fetch against the
// API host to sanity-check it end-to-end (the docs page itself fetched
// fine, just not the JSON endpoint) — worth a quick check once deployed.
//
// Two different questions get answered differently, honestly:
//   - Break starts within ~2 weeks: a real short-range forecast for that
//     exact day (Open-Meteo's free tier is reliable to ~16 days out).
//   - Break is further away (the common case for FIFO rosters projected
//     weeks/months ahead): a real forecast that far out doesn't exist, so
//     we show the typical high/low for that time of year instead, averaged
//     from the last 3 years of actual historical data — never a made-up
//     number, and the frontend labels it "typical", not "forecast".

const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_API = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_HORIZON_DAYS = 14; // stay a little inside Open-Meteo's ~16-day free forecast window

// Approximate city-centre coordinates for each of the 22 curated
// destinations in lib/travelpayouts.js (REAL_DESTINATIONS) — enough
// precision for a "what's it like there" temperature, not navigation.
export const DESTINATION_COORDS = {
  DPS: { lat: -8.6705, lon: 115.2126 },   // Bali (Denpasar)
  HKT: { lat: 7.8804, lon: 98.3923 },     // Phuket
  ZQN: { lat: -45.0312, lon: 168.6626 },  // Queenstown
  OOL: { lat: -28.1667, lon: 153.5000 },  // Gold Coast
  NAN: { lat: -17.7765, lon: 177.4356 },  // Fiji (Nadi)
  TYO: { lat: 35.6762, lon: 139.6503 },   // Tokyo
  SIN: { lat: 1.3521, lon: 103.8198 },    // Singapore
  CNS: { lat: -16.9203, lon: 145.7710 },  // Cairns
  YYJ: { lat: 48.4284, lon: -123.3656 },  // Vancouver Island (Victoria)
  PSP: { lat: 33.8303, lon: -116.5453 },  // Palm Springs
  MEL: { lat: -37.8136, lon: 144.9631 },  // Melbourne
  AKL: { lat: -36.8485, lon: 174.7633 },  // Auckland
  HNL: { lat: 21.3069, lon: -157.8583 },  // Honolulu
  LAX: { lat: 34.0522, lon: -118.2437 },  // Los Angeles
  BKK: { lat: 13.7563, lon: 100.5018 },   // Bangkok
  SGN: { lat: 10.8231, lon: 106.6297 },   // Ho Chi Minh City
  VLI: { lat: -17.7333, lon: 168.3273 },  // Vanuatu (Port Vila)
  RAR: { lat: -21.2367, lon: -159.7777 }, // Rarotonga
  SYD: { lat: -33.8688, lon: 151.2093 },  // Sydney
  ADL: { lat: -34.9285, lon: 138.6007 },  // Adelaide
  BME: { lat: -17.9614, lon: 122.2359 },  // Broome
  HKG: { lat: 22.3193, lon: 114.1694 }    // Hong Kong
};

// WMO weather interpretation codes (the standard table Open-Meteo's `daily`
// weathercode values come from) — condensed to what's plausible for these
// destinations, with a sane fallback for anything unmapped.
const WEATHER_CODES = {
  0: { icon: '☀️', label: 'Clear' },
  1: { icon: '🌤️', label: 'Mostly clear' },
  2: { icon: '⛅', label: 'Partly cloudy' },
  3: { icon: '☁️', label: 'Overcast' },
  45: { icon: '🌫️', label: 'Foggy' },
  48: { icon: '🌫️', label: 'Foggy' },
  51: { icon: '🌦️', label: 'Light drizzle' },
  53: { icon: '🌦️', label: 'Drizzle' },
  55: { icon: '🌦️', label: 'Heavy drizzle' },
  61: { icon: '🌧️', label: 'Light rain' },
  63: { icon: '🌧️', label: 'Rain' },
  65: { icon: '🌧️', label: 'Heavy rain' },
  71: { icon: '🌨️', label: 'Light snow' },
  73: { icon: '🌨️', label: 'Snow' },
  75: { icon: '🌨️', label: 'Heavy snow' },
  80: { icon: '🌦️', label: 'Rain showers' },
  81: { icon: '🌧️', label: 'Rain showers' },
  82: { icon: '⛈️', label: 'Heavy showers' },
  95: { icon: '⛈️', label: 'Thunderstorms' },
  96: { icon: '⛈️', label: 'Thunderstorms' },
  99: { icon: '⛈️', label: 'Thunderstorms' }
};

function describeCode(code) {
  return WEATHER_CODES[code] || { icon: '🌤️', label: 'Mixed' };
}

function monthName(dateISO) {
  return new Date(`${dateISO}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

function daysFromToday(dateISO) {
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const target = new Date(`${dateISO}T00:00:00Z`);
  return Math.round((target - today) / 86400000);
}

/** Real short-range forecast for one exact day, for a destination we have
 * coordinates for. Returns null (not a guess) on any failure — a missing
 * forecast should show as "no weather data," never a made-up one. */
export async function fetchForecast({ iata, dateISO, fetchImpl = fetch }) {
  const coords = DESTINATION_COORDS[iata];
  if (!coords) return null;

  const url = `${FORECAST_API}?latitude=${coords.lat}&longitude=${coords.lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${dateISO}&end_date=${dateISO}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const json = await res.json();
    const high = json.daily?.temperature_2m_max?.[0];
    const low = json.daily?.temperature_2m_min?.[0];
    if (high == null || low == null) return null;
    const { icon, label } = describeCode(json.daily?.weathercode?.[0]);
    return { type: 'forecast', high: Math.round(high), low: Math.round(low), icon, label, month: monthName(dateISO) };
  } catch (e) {
    console.error(`[weather] forecast fetch for ${iata} threw:`, e.message);
    return null;
  }
}

/** "Typical for this time of year" — averages actual historical highs/lows
 * from a 7-day window centred on the target date, across each of the last
 * 3 years. Real historical data, not a formula — just not a forecast. */
export async function fetchTypicalWeather({ iata, dateISO, fetchImpl = fetch }) {
  const coords = DESTINATION_COORDS[iata];
  if (!coords) return null;

  const target = new Date(`${dateISO}T00:00:00Z`);
  const years = [1, 2, 3].map(n => target.getUTCFullYear() - n);
  const windows = years.map(y => {
    const start = new Date(Date.UTC(y, target.getUTCMonth(), target.getUTCDate() - 3));
    const end = new Date(Date.UTC(y, target.getUTCMonth(), target.getUTCDate() + 3));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  });

  try {
    const results = await Promise.all(windows.map(async w => {
      const url = `${ARCHIVE_API}?latitude=${coords.lat}&longitude=${coords.lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${w.start}&end_date=${w.end}`;
      const res = await fetchImpl(url);
      if (!res.ok) return null;
      const json = await res.json();
      return json.daily || null;
    }));

    const highs = [];
    const lows = [];
    for (const d of results) {
      if (!d) continue;
      (d.temperature_2m_max || []).forEach(v => { if (v != null) highs.push(v); });
      (d.temperature_2m_min || []).forEach(v => { if (v != null) lows.push(v); });
    }
    if (!highs.length || !lows.length) return null;

    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    return { type: 'typical', high: Math.round(avg(highs)), low: Math.round(avg(lows)), icon: '🌡️', label: null, month: monthName(dateISO) };
  } catch (e) {
    console.error(`[weather] archive fetch for ${iata} threw:`, e.message);
    return null;
  }
}

/** Picks forecast vs typical based on how far out the date is, and returns
 * whichever real data is available — or null if neither could be fetched
 * (no weather shown for that card, rather than a guess). */
export async function getWeatherForDate({ iata, dateISO, fetchImpl = fetch }) {
  if (!DESTINATION_COORDS[iata] || !dateISO) return null;

  const daysAway = daysFromToday(dateISO);
  if (daysAway >= 0 && daysAway <= FORECAST_HORIZON_DAYS) {
    const forecast = await fetchForecast({ iata, dateISO, fetchImpl });
    if (forecast) return forecast;
  }
  return await fetchTypicalWeather({ iata, dateISO, fetchImpl });
}
