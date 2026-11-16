// Turns an ordered list of stops into a timed day, and reports every problem it finds.
// The LLM never sets times: this code does, from visit lengths, travel time and opening hours.
// The same issues it reports are sent back to the LLM to repair a plan.

import { PLACES_BY_ID, formatMinutes, type Place, type Window } from "@/lib/places";
import { isBaseCity, isReachable, travelBetween, type BaseCity } from "@/lib/geo";
import type { Plan, PlannedDay } from "@/lib/schemas";

export type Severity = "error" | "warning" | "info";
export interface Issue {
  severity: Severity;
  message: string;
}

export interface ScheduledStop {
  place: Place;
  why: string;
  start: number; // minutes from midnight
  end: number;
  travelBefore: number; // minutes from the previous stop
  issues: Issue[];
}

export interface ScheduledDay {
  date: string;
  theme: string;
  stops: ScheduledStop[];
  issues: Issue[]; // problems with the day as a whole
}

export interface ScheduledTrip {
  bases: BaseCity[];
  days: ScheduledDay[];
  issues: Issue[];
}

const DAY_START = 9 * 60;
const DAY_END = 24 * 60;
const LUNCH_FROM = 12 * 60;
const DINNER_FROM = 19 * 60;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- Dates ----------

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dateParts(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  return { weekday: d.getUTCDay(), month: d.getUTCMonth() + 1, dayOfMonth: d.getUTCDate() };
}

export function weekdayName(date: string): string {
  return WEEKDAYS[dateParts(date).weekday];
}

/** The nth Saturday of a month falls on days 7n-6 to 7n; its Sunday is the day after. */
function isNthWeekend(date: string, n: number): boolean {
  const { weekday, dayOfMonth } = dateParts(date);
  const saturday = weekday === 6 ? dayOfMonth : weekday === 0 ? dayOfMonth - 1 : null;
  return saturday !== null && saturday >= 7 * n - 6 && saturday <= 7 * n;
}

const ORDINALS = ["", "first", "second", "third", "fourth", "fifth"];

// ---------- Fitting a stop into opening hours ----------

/** null means "no constraint we can check" (public space or unknown hours). */
function windowsOn(place: Place, weekday: number): Window[] | null {
  const h = place.hours;
  return h.kind === "fixed" || h.kind === "approximate" ? h.byDay[weekday] : null;
}

/**
 * Earliest start at or after `arrive`.
 * Restaurants: lunch from 12:00, dinner from 19:00, and you must sit down 30 min before closing.
 * Vague hours ("Evenings", "weekday mornings"): you only need to arrive 30 min before they end,
 * because there is no real closing time to finish before.
 * Everything else: the whole visit must finish before closing.
 *
 * | Kind                         | Must start by    |
 * | ---------------------------- | ---------------- |
 * | Restaurant                   | close - 30       |
 * | Vague hours ("Evenings")     | close - 30       |
 * | Everything else, fixed hours | close - duration |
 *
 * Example: restaurant open 12:00-15:00 and 19:00-22:30, arrive 14:40.
 *   Meal shift: 14:40 is before 15:00, so `from` stays 14:40 (it does not jump to 19:00).
 *   Lunch window: start 14:40, latest 14:30. Doesn't fit, try the next window.
 *   Dinner window: start max(14:40, 19:00) = 19:00, latest 22:00. Fits, returns 19:00.
 * A museum open 12:00-15:00 with a 90 min visit must start by 13:30, so arriving at 14:40 returns null.
 * Any wait before the returned start shows in the UI as "Free time".
 */
function earliestStart(place: Place, arrive: number, weekday: number): number | null {
  const isMeal = place.type === "restaurant";
  const mustFinish = !isMeal && place.hours.kind === "fixed";
  let from = arrive;
  if (isMeal) {
    // Arriving before 15:00 counts as lunch (not before 12:00); later counts as dinner (not before 19:00).
    from = Math.max(from, from < 15 * 60 ? LUNCH_FROM : DINNER_FROM);
  }

  const windows = windowsOn(place, weekday);
  if (!windows) {
    return from;
  }
  // Try each opening window in order. If one is too late, fall through to the next one.
  for (const w of [...windows].sort((a, b) => a.open - b.open)) {
    // If we arrive before this window opens, wait until it opens.
    const start = Math.max(from, w.open);
    const latestOk = mustFinish ? w.close - place.durationMinutes : w.close - 30;
    if (start <= latestOk) {
      return start;
    }
  }
  return null;
}

/** Facts about a place the traveler should see regardless of scheduling. */
function placeIssues(place: Place): Issue[] {
  const issues: Issue[] = place.notes.map((message) => ({ severity: "warning" as const, message }));
  if (place.bookingRequired) {
    issues.push({ severity: "info", message: "Book ahead." });
  }
  if (place.seasonalNote) {
    issues.push({ severity: "info", message: place.seasonalNote });
  }
  return issues;
}

// ---------- Days and trips ----------

export function scheduleDay(planned: PlannedDay, date: string, bases: BaseCity[]): ScheduledDay {
  const { weekday, month } = dateParts(date);
  const stops: ScheduledStop[] = [];
  const dayIssues: Issue[] = [];
  let clock = DAY_START;
  let prev: Place | null = null;

  for (const { place_id, why } of planned.stops) {
    const place = PLACES_BY_ID.get(place_id);
    if (!place) {
      dayIssues.push({ severity: "error", message: `Unknown place id "${place_id}".` });
      continue;
    }
    const issues = placeIssues(place);
    // unshift puts each error at the front, so errors come before warnings and the LAST failed check
    // ends up first. Example: Uffizi on a Monday from a Rome base gets
    // ["Closed or no time left on Monday...", "Florence is too far from Rome...", ...warnings and info].
    const fail = (message: string) => issues.unshift({ severity: "error", message });

    if (place.excludedReason) {
      fail(`Not recommended: ${place.excludedReason}`);
    }
    if (bases.length && !bases.some((b) => isReachable(place, b))) {
      fail(`${place.city} is too far from ${bases.join(" / ")} for a day trip.`);
    }
    if (place.openMonths && !place.openMonths.includes(month)) {
      const range = `${MONTHS[place.openMonths[0] - 1]}-${MONTHS[place.openMonths.at(-1)! - 1]}`;
      fail(`Closed in ${MONTHS[month - 1]} (open ${range} only).`);
    }
    if (place.nthWeekendOnly && !isNthWeekend(date, place.nthWeekendOnly)) {
      fail(`Only runs on the ${ORDINALS[place.nthWeekendOnly]} weekend of the month.`);
    }

    const travelBefore = prev ? travelBetween(prev, place) : 0;
    const arrive = clock + travelBefore;
    let start = earliestStart(place, arrive, weekday);
    if (start === null) {
      fail(`Closed or no time left on ${WEEKDAYS[weekday]} (hours: ${place.hoursText}).`);
      start = arrive;
    }
    const end = start + place.durationMinutes;
    stops.push({ place, why, start, end, travelBefore, issues });
    clock = end;
    prev = place;
  }

  // Whole-day checks.
  // Base cities are left out, so a Rome-base day with a Florence stop does not trigger this
  // (that stop already fails the "too far" check above).
  const awayCities = new Set(stops.map((s) => s.place.city).filter((c) => !isBaseCity(c)));
  if (awayCities.size > 1) {
    dayIssues.push({
      severity: "error",
      message: `Too many towns in one day: ${[...awayCities].join(", ")}.`,
    });
  }
  const last = stops.at(-1);
  if (last && last.end > DAY_END) {
    dayIssues.push({
      severity: "warning",
      message: `Day runs past midnight (ends ${formatMinutes(last.end)}).`,
    });
  }
  const isFoodStop = (s: ScheduledStop) =>
    ["restaurant", "cafe", "market"].includes(s.place.type) || s.place.tags.includes("food");
  if (stops.length && !stops.some((s) => isFoodStop(s) && s.start >= 18 * 60)) {
    dayIssues.push({ severity: "warning", message: "No dinner planned." });
  }

  return { date, theme: planned.theme, stops, issues: dayIssues };
}

export function scheduleTrip(plan: Plan, startDate: string): ScheduledTrip {
  const bases = plan.bases.filter(isBaseCity);
  const issues: Issue[] = [];
  if (bases.length === 0) {
    issues.push({ severity: "error", message: "No valid base city." });
  }
  if (plan.days.length !== 3) {
    issues.push({ severity: "error", message: `Plan has ${plan.days.length} days, not 3.` });
  }

  const days = plan.days.map((d, i) => scheduleDay(d, addDays(startDate, i), bases));

  const seen = new Set<string>();
  for (const day of days) {
    for (const stop of day.stops) {
      if (seen.has(stop.place.id)) {
        stop.issues.unshift({ severity: "error", message: "Already visited earlier in the trip." });
      }
      seen.add(stop.place.id);
    }
  }
  return { bases, days, issues };
}

// ---------- Helpers for the repair loop and the UI ----------

/**
 * Plain-language list of errors, phrased for the LLM to fix. One line per error, with the place id
 * so the LLM knows exactly which stop to replace:
 *   "Day 1, Uffizi Gallery (place_026): Closed or no time left on Monday (hours: Tues-Sun 8:15-18:50)."
 */
export function errorReport(trip: ScheduledTrip): string[] {
  const out = trip.issues.filter((i) => i.severity === "error").map((i) => i.message);
  trip.days.forEach((day, d) => {
    for (const i of day.issues) {
      if (i.severity === "error") {
        out.push(`Day ${d + 1}: ${i.message}`);
      }
    }
    day.stops.forEach((s) => {
      for (const i of s.issues) {
        if (i.severity === "error") {
          out.push(`Day ${d + 1}, ${s.place.name} (${s.place.id}): ${i.message}`);
        }
      }
    });
  });
  return out;
}

/**
 * Last resort after the LLM's repair attempt: drop every stop that still has an error, and say why.
 * Removing a stop only makes later stops earlier, so one pass is enough.
 * Day-level problems stay visible as issues on the day.
 */
export function dropInvalidStops(plan: Plan, startDate: string): { plan: Plan; removed: string[] } {
  const trip = scheduleTrip(plan, startDate);
  const removed: string[] = [];

  const days = plan.days.map((day, d) => {
    for (const s of day.stops) {
      if (!PLACES_BY_ID.has(s.place_id)) {
        removed.push(`${s.place_id}: not in the dataset`);
      }
    }
    const valid = trip.days[d].stops.filter((stop) => {
      // find() keeps only the first error, which is the last check that failed (see `fail` above).
      // So a stop with two errors is listed once, e.g. "Uffizi Gallery: Closed or no time left on Monday...".
      const error = stop.issues.find((i) => i.severity === "error");
      if (error) {
        removed.push(`${stop.place.name}: ${error.message}`);
      }
      return !error;
    });
    return { ...day, stops: valid.map((stop) => ({ place_id: stop.place.id, why: stop.why })) };
  });

  return { plan: { ...plan, days }, removed };
}
