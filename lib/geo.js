// Great-circle distance + rough timezone context between the user's home
// airport and each curated destination. Both are pure, static computations
// — no external API calls, unlike weather.js/travelpayouts.js/fx.js — so
// this never fails or needs caching.
//
// Coordinates are approximate (city/airport-centre precision, not
// navigation-grade) — same standard already used in lib/weather.js's
// DESTINATION_COORDS, which this file reuses for the destination side.
//
// Timezone offsets are STANDARD time only — daylight saving is deliberately
// NOT modelled. Australia alone runs 3 different DST rules depending on
// state (WA/QLD/NT: none, NSW/VIC/ACT/TAS/SA: Oct-Apr), and most
// international destinations add their own DST rules on top of that.
// Modelling all of that correctly for every route/date combination isn't
// worth the complexity for a "roughly how far ahead are they" stat — this
// is disclosed to the user via a tooltip rather than silently pretending
// to be exact to the hour year-round.

import { DESTINATION_COORDS } from './weather.js';

// One entry per code in AIRPORT_OPTIONS (public/index.html) — the home
// airports a user can select in Setup. All of WA is UTC+8 (no DST); QLD is
// UTC+10 (no DST); NSW/VIC/ACT/TAS are UTC+10 standard; SA/NT are UTC+9.5
// standard. (Again: standard time only, DST not modelled — see file note.)
export const ORIGIN_AIRPORT_GEO = {
  // NSW / ACT
  SYD: { lat: -33.9399, lon: 151.1753, utcOffset: 10 },
  NTL: { lat: -32.7952, lon: 151.8344, utcOffset: 10 },
  WGA: { lat: -35.1653, lon: 147.4661, utcOffset: 10 },
  ABX: { lat: -36.0678, lon: 146.9581, utcOffset: 10 },
  DBO: { lat: -32.2167, lon: 148.5750, utcOffset: 10 },
  TMW: { lat: -31.0839, lon: 150.8467, utcOffset: 10 },
  OAG: { lat: -33.3819, lon: 149.1308, utcOffset: 10 },
  BHS: { lat: -33.4094, lon: 149.6519, utcOffset: 10 },
  CFS: { lat: -30.3206, lon: 153.1156, utcOffset: 10 },
  PQQ: { lat: -31.4331, lon: 152.8636, utcOffset: 10 },
  BHQ: { lat: -32.0011, lon: 141.4714, utcOffset: 10 },
  ARM: { lat: -30.5281, lon: 151.6169, utcOffset: 10 },
  GFF: { lat: -34.2506, lon: 146.0669, utcOffset: 10 },
  BNK: { lat: -28.8339, lon: 153.5619, utcOffset: 10 },
  CBR: { lat: -35.3084, lon: 149.1244, utcOffset: 10 },
  // VIC
  MEL: { lat: -37.6690, lon: 144.8410, utcOffset: 10 },
  AVV: { lat: -38.0394, lon: 144.4694, utcOffset: 10 },
  BLT: { lat: -37.5115, lon: 143.7900, utcOffset: 10 },
  BDG: { lat: -36.7394, lon: 144.3294, utcOffset: 10 },
  MQL: { lat: -34.2358, lon: 142.0861, utcOffset: 10 },
  // QLD (no DST)
  BNE: { lat: -27.3942, lon: 153.1218, utcOffset: 10 },
  OOL: { lat: -28.1644, lon: 153.5047, utcOffset: 10 },
  MCY: { lat: -26.6033, lon: 153.0914, utcOffset: 10 },
  TSV: { lat: -19.2525, lon: 146.7653, utcOffset: 10 },
  CNS: { lat: -16.8858, lon: 145.7553, utcOffset: 10 },
  TWB: { lat: -27.5581, lon: 151.7931, utcOffset: 10 },
  MKY: { lat: -21.1717, lon: 149.1803, utcOffset: 10 },
  ROK: { lat: -23.3819, lon: 150.4753, utcOffset: 10 },
  GLT: { lat: -23.8697, lon: 151.2233, utcOffset: 10 },
  BDB: { lat: -24.9036, lon: 152.3194, utcOffset: 10 },
  HVB: { lat: -25.3186, lon: 152.8800, utcOffset: 10 },
  ISA: { lat: -20.6639, lon: 139.4889, utcOffset: 10 },
  EMD: { lat: -23.5678, lon: 148.1794, utcOffset: 10 },
  RMA: { lat: -26.5478, lon: 148.7847, utcOffset: 10 },
  // WA (no DST)
  PER: { lat: -31.9403, lon: 115.9669, utcOffset: 8 },
  KTA: { lat: -20.7122, lon: 116.7733, utcOffset: 8 },
  PHE: { lat: -20.3778, lon: 118.6264, utcOffset: 8 },
  NWM: { lat: -23.4172, lon: 119.8036, utcOffset: 8 },
  BME: { lat: -17.9447, lon: 122.2317, utcOffset: 8 },
  KGI: { lat: -30.7894, lon: 121.4617, utcOffset: 8 },
  GET: { lat: -28.7961, lon: 114.7047, utcOffset: 8 },
  BQB: { lat: -33.6883, lon: 115.3986, utcOffset: 8 },
  ALH: { lat: -34.9433, lon: 117.8092, utcOffset: 8 },
  EPR: { lat: -33.6828, lon: 121.8228, utcOffset: 8 },
  DRB: { lat: -17.3697, lon: 123.6597, utcOffset: 8 },
  LEA: { lat: -22.2361, lon: 114.0883, utcOffset: 8 },
  PBO: { lat: -23.1719, lon: 117.7461, utcOffset: 8 },
  TPR: { lat: -22.1497, lon: 117.7669, utcOffset: 8 },
  // SA
  ADL: { lat: -34.9461, lon: 138.5306, utcOffset: 9.5 },
  WYA: { lat: -33.0589, lon: 137.5139, utcOffset: 9.5 },
  PLO: { lat: -34.6053, lon: 135.8803, utcOffset: 9.5 },
  MGB: { lat: -37.7458, lon: 140.7844, utcOffset: 9.5 },
  PUG: { lat: -32.5069, lon: 137.7169, utcOffset: 9.5 },
  // TAS
  HBA: { lat: -42.8361, lon: 147.5103, utcOffset: 10 },
  LST: { lat: -41.5453, lon: 147.2143, utcOffset: 10 },
  DPO: { lat: -41.1697, lon: 146.4300, utcOffset: 10 },
  BWT: { lat: -40.9989, lon: 145.7317, utcOffset: 10 },
  // NT (no DST)
  DRW: { lat: -12.4083, lon: 130.8726, utcOffset: 9.5 },
  ASP: { lat: -23.8067, lon: 133.9018, utcOffset: 9.5 },
  KTR: { lat: -14.4653, lon: 132.2708, utcOffset: 9.5 },
  TCA: { lat: -19.6339, lon: 134.1831, utcOffset: 9.5 },
  GOV: { lat: -12.2794, lon: 136.8181, utcOffset: 9.5 }
};

// Standard-time UTC offset per destination in lib/travelpayouts.js
// (REAL_DESTINATIONS) — kept separate from weather.js's DESTINATION_COORDS
// since that file only ever needed lat/lon, not timezone.
export const DEST_UTC_OFFSET = {
  DPS: 8, HKT: 7, ZQN: 12, OOL: 10, NAN: 12, TYO: 9, SIN: 8, CNS: 10,
  YYJ: -8, PSP: -8, MEL: 10, AKL: 12, HNL: -10, LAX: -8, BKK: 7, SGN: 7,
  VLI: 11, RAR: -10, SYD: 10, ADL: 9.5, BME: 8, HKG: 8, CBR: 10, NTL: 10,
  HBA: 10, BNE: 10, PER: 8, DRW: 9.5, ASP: 9.5, LST: 10, MCY: 10, PPP: 10,
  KUL: 8, MNL: 8, ICN: 9, DXB: 4, LON: 0, CHC: 12
};

function toRad(deg) { return (deg * Math.PI) / 180; }

/** Great-circle (haversine) distance in km between two {lat, lon} points. */
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.asin(Math.sqrt(h)));
}

/** Distance + rough standard-time timezone difference between a home
 * airport and a curated destination. Fields come back null (not zero, not
 * a guess) when either side isn't in our coordinate tables, so the caller
 * can just omit that stat rather than show a wrong one. */
export function routeContext(originCode, destIata) {
  const origin = ORIGIN_AIRPORT_GEO[(originCode || '').toUpperCase()];
  const dest = DESTINATION_COORDS[destIata];
  const distanceKm = (origin && dest) ? haversineKm(origin, dest) : null;

  const destOffset = DEST_UTC_OFFSET[destIata];
  const tzDiffHours = (origin && destOffset != null)
    ? Math.round((destOffset - origin.utcOffset) * 2) / 2
    : null;

  return { distanceKm, tzDiffHours };
}
