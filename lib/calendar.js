// Builds an RFC 5545 iCalendar (.ics) feed from a list of computed breaks.
// Pure string generation, no external dependency — the same zero-dependency
// rule as the rest of the app.
//
// CONFIDENCE NOTE: iCalendar's all-day-event date handling is the one part
// of this worth double-checking if a break ever shows up a day off in a
// calendar app. All-day events use DTSTART/DTEND with VALUE=DATE (no time,
// no timezone — "floating" so every calendar app shows the same date
// regardless of the viewer's timezone, which is what we want for a break
// that's really just "these calendar days off"). DTEND for an all-day event
// is EXCLUSIVE per the spec (the event covers up to but not including
// DTEND), so a break from the 10th to the 12th needs DTEND=13th, not 12th —
// handled by addDaysToICSDate(end, 1) below. Verified against Google
// Calendar's and Apple Calendar's documented behaviour for VALUE=DATE
// events; not tested against a real subscribed feed in this sandbox (no
// network access to actually add one), so worth a quick manual check the
// first time you subscribe for real.

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Formats a local-midnight Date as YYYYMMDD using LOCAL getters (not
// toISOString/UTC) — same reasoning as lib/travelpayouts.js's
// localDateOnly: brk.start/brk.end are already local-midnight Date objects,
// and going through UTC could shift the date by one depending on server
// timezone.
function icsDate(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function addDaysLocal(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// Escapes text per RFC 5545 §3.3.11 — backslash, comma, semicolon, and
// literal newlines all need escaping in TEXT values.
function escapeText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// Folds a line to <=75 octets per RFC 5545 §3.1, continuation lines start
// with a single space. Most calendar apps tolerate unfolded long lines, but
// folding costs little and keeps this a spec-correct feed.
function foldLine(line) {
  if (line.length <= 75) return line;
  let out = line.slice(0, 75);
  let rest = line.slice(75);
  while (rest.length) {
    out += '\r\n ' + rest.slice(0, 74);
    rest = rest.slice(74);
  }
  return out;
}

function nowUTCStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

/**
 * breaks: array of { key, start, end } — local-midnight Date objects, as
 * returned by computeUpcomingBreaks() in lib/deals.js.
 * domain: used to build a stable, globally-unique UID per event (required
 * by the spec) — pass the site's own hostname, e.g. 'nextbreak.com.au'.
 */
export function buildBreaksICS(breaks, { calendarName = 'My Next Break', domain = 'nextbreak.com.au' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Next Break//Roster Breaks//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    // Re-fetch hint — most calendar apps respect this loosely, Google
    // Calendar in particular uses it to decide how often to refresh a
    // subscribed feed instead of polling constantly.
    'X-PUBLISHED-TTL:PT12H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H'
  ];

  const stamp = nowUTCStamp();

  for (const brk of breaks) {
    const dtStart = icsDate(brk.start);
    const dtEnd = icsDate(addDaysLocal(brk.end, 1)); // exclusive end, see note above
    lines.push(
      'BEGIN:VEVENT',
      `UID:${brk.key}@${domain}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      `SUMMARY:${escapeText('Break away')}`,
      `DESCRIPTION:${escapeText('Your break, from Next Break — nextbreak.com.au')}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');

  // RFC 5545 requires CRLF line endings.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
