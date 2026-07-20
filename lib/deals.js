// Pure logic: roster -> upcoming breaks -> deterministic mock deals.
// No external dependencies on purpose (keeps `npm install` unnecessary).

export function toDate(str) {
  if (!str) return null;
  const d = new Date(str + 'T00:00:00');
  return isNaN(d) ? null : d;
}

// Formats a local-midnight Date (as produced by toDate() above) as
// YYYY-MM-DD using LOCAL getters, NOT toISOString()/UTC. brk.start/brk.end
// are local-midnight Date objects — going through UTC can shift the
// displayed date by a day depending on the server's timezone (e.g. a break
// starting local midnight Aug 1 in a UTC+8 zone is still July 31 in UTC).
// Same bug class, and same fix, as localDateOnly() in lib/travelpayouts.js.
export function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

function startOfToday() {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

/**
 * settings = {
 *   rosterMode: 'pattern' | 'manual',
 *   pattern: { daysOn, daysOff, nextBreakStart },
 *   manualBreaks: [{ id, start, end }]
 * }
 * Returns up to 6 upcoming breaks, each with a stable `key` (used for
 * unlock lookups) derived from its actual dates — not array index — so
 * unlocks survive re-generation of the schedule.
 */
export function computeUpcomingBreaks(settings) {
  const today = startOfToday();
  const breaks = [];

  if (settings.rosterMode === 'manual') {
    (settings.manualBreaks || [])
      .map(r => ({ start: toDate(r.start), end: toDate(r.end) }))
      .filter(b => b.start && b.end && b.end >= today)
      .forEach(b => {
        breaks.push({
          key: `${toISO(b.start)}_${toISO(b.end)}`,
          start: b.start,
          end: b.end,
          duration: daysBetween(b.start, b.end) + 1
        });
      });
    breaks.sort((a, b) => a.start - b.start);
    return breaks;
  }

  // pattern mode
  const daysOn = parseInt(settings.pattern?.daysOn, 10) || 0;
  const daysOff = parseInt(settings.pattern?.daysOff, 10) || 0;
  const cycleLen = daysOn + daysOff;
  let start = toDate(settings.pattern?.nextBreakStart);
  if (!start || cycleLen <= 0 || daysOff <= 0) return breaks;

  while (addDays(start, daysOff - 1) < today) {
    start = addDays(start, cycleLen);
  }
  for (let i = 0; i < 6; i++) {
    const end = addDays(start, daysOff - 1);
    breaks.push({
      key: `${toISO(start)}_${toISO(end)}`,
      start,
      end,
      duration: daysOff
    });
    start = addDays(start, cycleLen);
  }
  return breaks;
}

/**
 * The mirror image of computeUpcomingBreaks above: breaks whose end date
 * has already passed, most-recent-first. Used for the account "past
 * breaks" history — never fabricates a longer history than the app
 * actually knows about, so pattern mode is deliberately bounded (see
 * MAX_CYCLES_BACK) rather than projecting the recurring pattern
 * indefinitely far into the past.
 */
export function computePastBreaks(settings, { limit = 6 } = {}) {
  const today = startOfToday();
  const breaks = [];

  if (settings.rosterMode === 'manual') {
    (settings.manualBreaks || [])
      .map(r => ({ start: toDate(r.start), end: toDate(r.end) }))
      .filter(b => b.start && b.end && b.end < today)
      .forEach(b => {
        breaks.push({
          key: `${toISO(b.start)}_${toISO(b.end)}`,
          start: b.start,
          end: b.end,
          duration: daysBetween(b.start, b.end) + 1
        });
      });
    breaks.sort((a, b) => b.start - a.start);
    return breaks.slice(0, limit);
  }

  // pattern mode: find the same anchor computeUpcomingBreaks would start
  // from (the first cycle whose break hasn't fully finished yet), then
  // step backward one cycle at a time.
  const daysOn = parseInt(settings.pattern?.daysOn, 10) || 0;
  const daysOff = parseInt(settings.pattern?.daysOff, 10) || 0;
  const cycleLen = daysOn + daysOff;
  let start = toDate(settings.pattern?.nextBreakStart);
  if (!start || cycleLen <= 0 || daysOff <= 0) return breaks;

  // If the pattern's own anchor break hasn't finished yet, there's nothing
  // "past" to report — the app only knows about this pattern starting at
  // nextBreakStart, so mechanically extrapolating backward past that point
  // would show breaks the app never actually surfaced as upcoming.
  if (addDays(start, daysOff - 1) >= today) return breaks;

  while (addDays(start, daysOff - 1) < today) {
    start = addDays(start, cycleLen);
  }
  start = addDays(start, -cycleLen);

  // Bounded lookback — a pattern set up only recently shouldn't imply a
  // longer history than the app has actually been tracking.
  const MAX_CYCLES_BACK = 12;
  for (let i = 0; i < MAX_CYCLES_BACK && breaks.length < limit; i++) {
    const end = addDays(start, daysOff - 1);
    if (end < today) {
      breaks.push({ key: `${toISO(start)}_${toISO(end)}`, start, end, duration: daysOff });
    }
    start = addDays(start, -cycleLen);
  }
  return breaks;
}

export function breakStatus(brk) {
  const today = startOfToday();
  const daysUntil = daysBetween(today, brk.start);
  return {
    daysUntil,
    isOngoing: today >= brk.start && today <= brk.end,
    isSoon: daysUntil >= 0 && daysUntil <= 14
  };
}

// ---------- deterministic pseudo-random (mulberry32) ----------
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
function seededRand(seed) {
  let t = seed + 0x6d2b79f5;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export const DESTINATIONS = [
  { name: 'Bali, Indonesia', type: 'Flight + Resort package', base: 95, flight: '6-9 hr flight', minNights: 4, blurb: 'Beaches, surf breaks and cheap luxury villas.' },
  { name: 'Phuket, Thailand', type: 'Flight + Hotel package', base: 80, flight: '7-10 hr flight', minNights: 4, blurb: 'Island hopping, street food, warm water year-round.' },
  { name: 'Queenstown, NZ', type: 'Flight + Lodge package', base: 150, flight: '3-5 hr flight', minNights: 3, blurb: 'Adventure sports, hiking and epic scenery.' },
  { name: 'Gold Coast, AUS', type: 'Flight + Hotel package', base: 110, flight: '2-4 hr flight', minNights: 2, blurb: 'Surf beaches, theme parks, easy short break.' },
  { name: 'Byron Bay, AUS', type: 'Road trip + Stay', base: 130, flight: 'Drive or 2 hr flight', minNights: 2, blurb: 'Laid-back beach town, cafes, coastal walks.' },
  { name: 'Fiji', type: 'Flight + Resort package', base: 140, flight: '4-6 hr flight', minNights: 4, blurb: 'Overwater bungalows and reef diving.' },
  { name: 'Tokyo, Japan', type: 'Flight + Hotel package', base: 160, flight: '8-10 hr flight', minNights: 5, blurb: 'City break — food, culture, neon nights.' },
  { name: 'Singapore', type: 'Flight + Hotel package', base: 150, flight: '5-8 hr flight', minNights: 3, blurb: 'Easy stopover city with great food scene.' },
  { name: 'Whitsundays, AUS', type: 'Sailing + Island package', base: 180, flight: '2-4 hr flight', minNights: 3, blurb: 'Sail the reef, white-sand island days.' },
  { name: 'Port Douglas, AUS', type: 'Flight + Resort package', base: 145, flight: '3-5 hr flight', minNights: 3, blurb: 'Reef, rainforest, relaxed tropical pace.' },
  { name: 'Vancouver Island, CAN', type: 'Flight + Lodge package', base: 135, flight: '2-5 hr flight', minNights: 3, blurb: 'Coastal hikes, whale watching, cabins.' },
  { name: 'Palm Springs, USA', type: 'Flight + Resort package', base: 120, flight: '2-4 hr flight', minNights: 2, blurb: 'Desert sun, pools, easy weekend reset.' },
  { name: 'Nearby coastal town', type: 'Weekend getaway', base: 70, flight: 'Short drive', minNights: 1, blurb: 'Quick reset without the travel time.' },
  { name: 'Mountain retreat', type: 'Weekend getaway', base: 90, flight: 'Short drive', minNights: 1, blurb: 'Fresh air, hiking trails, no crowds.' },
  { name: 'Melbourne, AUS', type: 'Flight + City hotel', base: 100, flight: '2-4 hr flight', minNights: 2, blurb: 'Laneways, coffee culture, live sport.' }
];

/**
 * Deterministic (same brk.key always yields the same deals) so results
 * don't shuffle every request, but nothing is precomputed/stored — it's
 * cheap to regenerate, which is what makes gating it behind payment
 * meaningful (nothing sensitive sits in a database).
 */
export function generateDeals(brk) {
  const availableNights = Math.max(1, brk.duration - 1);
  const eligible = DESTINATIONS.filter(d => d.minNights <= availableNights);
  const pool = eligible.length ? eligible : DESTINATIONS.filter(d => d.minNights === 1);
  const rand = seededRand(hashStr(brk.key));

  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picks = shuffled.slice(0, 3);
  return picks.map(d => {
    const nights = Math.min(availableNights, d.minNights + Math.floor(rand() * 3));
    const factor = 0.85 + rand() * 0.3;
    const discount = Math.round(10 + rand() * 25);
    const discounted = Math.round(d.base * nights * factor);
    const original = Math.round(discounted / (1 - discount / 100));
    return { ...d, nights, discounted, original, discount };
  });
}

export const CURRENCY_SYMBOLS = { USD: '$', AUD: 'A$', CAD: 'C$', GBP: '£', EUR: '€' };
