// Turns an ordered list of stops into a timed day, and reports every problem it finds.
// The LLM never sets times: this code does, from visit lengths, travel time and opening hours.
// The same issues it reports are sent back to the LLM to repair a plan.

import { PLACES_BY_ID, formatMinutes, type Place, type Window } from "@/lib/places";
import {
  baseCenter, distanceKm, isBaseCity, isReachable, nearestBase, travelMinutes, type BaseCity,
} from "@/lib/geo";
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
const HEAVY_TRAVEL_MIN = 180;
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

/** Third Saturday falls on the 15th-21st; the Sunday after it on the 16th-22nd. */
function isThirdWeekend(date: string): boolean {
  const { weekday, dayOfMonth } = dateParts(date);
  return (weekday === 6 && dayOfMonth >= 15 && dayOfMonth <= 21) ||
    (weekday === 0 && dayOfMonth >= 16 && dayOfMonth <= 22);
}

// ---------- Fitting a stop into opening hours ----------

/** null means "no constraint we can check" (public space or unknown hours). */
function windowsOn(place: Place, weekday: number): Window[] | null {
  const h = place.hours;
  return h.kind === "fixed" || h.kind === "approximate" ? h.byDay[weekday] : null;
}

/**
 * Earliest start at or after `arrive`.
 * Restaurants: lunch from 12:00, dinner from 19:00, and you must sit down 30 min before closing.
 * Everything else: the whole visit must finish before closing.
 */
function earliestStart(place: Place, arrive: number, weekday: number): number | null {
  const isMeal = place.type === "restaurant";
  let from = arrive;
  if (isMeal) from = Math.max(from, from < 15 * 60 ? LUNCH_FROM : DINNER_FROM);

  const windows = windowsOn(place, weekday);
  if (!windows) return from;
  for (const w of [...windows].sort((a, b) => a.open - b.open)) {
    const start = Math.max(from, w.open);
    const latestOk = isMeal ? w.close - 30 : w.close - place.durationMinutes;
    if (start <= latestOk) return start;
  }
  return null;
}

/** Facts about a place the traveler should see regardless of scheduling. */
function placeIssues(place: Place): Issue[] {
  const issues: Issue[] = place.notes.map((message) => ({ severity: "warning" as const, message }));
  if (place.bookingRequired) issues.push({ severity: "info", message: "Book ahead." });
  if (place.seasonalNote) issues.push({ severity: "info", message: place.seasonalNote });
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
    const fail = (message: string) => issues.unshift({ severity: "error", message });

    if (place.excludedReason) fail(`Not recommended: ${place.excludedReason}`);
    if (bases.length && !bases.some((b) => isReachable(place, b))) {
      fail(`${place.city} is too far from ${bases.join(" / ")} for a day trip.`);
    }
    if (place.openMonths && !place.openMonths.includes(month)) {
      const range = `${MONTHS[place.openMonths[0] - 1]}-${MONTHS[place.openMonths.at(-1)! - 1]}`;
      fail(`Closed in ${MONTHS[month - 1]} (open ${range} only).`);
    }
    if (place.thirdWeekendOnly && !isThirdWeekend(date)) {
      fail("Only runs on the third weekend of the month.");
    }

    const travelBefore = prev ? travelMinutes(distanceKm(prev, place)) : 0;
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

  // Whole-day checks
  const awayCities = new Set(stops.map((s) => s.place.city).filter((c) => !isBaseCity(c)));
  if (awayCities.size > 1) {
    dayIssues.push({ severity: "error", message: `Too many towns in one day: ${[...awayCities].join(", ")}.` });
  }
  const last = stops.at(-1);
  if (last && bases.length) {
    const home = nearestBase(last.place, bases);
    const back = last.place.city === home ? 0 : travelMinutes(distanceKm(last.place, baseCenter(home)));
    if (last.end + back > DAY_END) {
      dayIssues.push({
        severity: "error",
        message: back
          ? `Back in ${home} after midnight (ends ${formatMinutes(last.end)}, ~${back} min return).`
          : `Day runs past midnight (ends ${formatMinutes(last.end)}).`,
      });
    }
  }
  const travelTotal = stops.reduce((sum, s) => sum + s.travelBefore, 0);
  if (travelTotal > HEAVY_TRAVEL_MIN) {
    dayIssues.push({ severity: "warning", message: `About ${Math.round(travelTotal / 60)}h of travel today.` });
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
  if (bases.length === 0) issues.push({ severity: "error", message: "No valid base city." });
  if (plan.days.length !== 3) issues.push({ severity: "error", message: `Plan has ${plan.days.length} days, not 3.` });

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

/** Plain-language list of errors, phrased for the LLM to fix. */
export function errorReport(trip: ScheduledTrip): string[] {
  const out = trip.issues.filter((i) => i.severity === "error").map((i) => i.message);
  trip.days.forEach((day, d) => {
    for (const i of day.issues) if (i.severity === "error") out.push(`Day ${d + 1}: ${i.message}`);
    day.stops.forEach((s) => {
      for (const i of s.issues) {
        if (i.severity === "error") out.push(`Day ${d + 1}, ${s.place.name} (${s.place.id}): ${i.message}`);
      }
    });
  });
  return out;
}

export function errorCount(trip: ScheduledTrip): number {
  return errorReport(trip).length;
}

/**
 * Last resort after the LLM's repair attempt: drop stops with errors, then trim days that
 * still run too late. Guarantees the user never sees an impossible plan.
 * Returns the cleaned plan and a human-readable list of what was removed.
 */
export function dropInvalidStops(plan: Plan, startDate: string): { plan: Plan; removed: string[] } {
  const removed: string[] = [];
  const current: Plan = structuredClone(plan);

  for (let guard = 0; guard < 20; guard++) {
    const trip = scheduleTrip(current, startDate);
    let changed = false;
    current.days = current.days.map((day, d) => {
      const scheduled = trip.days[d];
      const bad = new Set(
        scheduled.stops
          .filter((s) => s.issues.some((i) => i.severity === "error"))
          .map((s) => s.place.id),
      );
      let stops = day.stops.filter((s) => {
        if (bad.has(s.place_id) || !PLACES_BY_ID.has(s.place_id)) {
          const stop = scheduled.stops.find((x) => x.place.id === s.place_id);
          const reason = stop?.issues.find((i) => i.severity === "error")?.message ?? "unknown place";
          removed.push(`${stop?.place.name ?? s.place_id}: ${reason}`);
          bad.delete(s.place_id); // only drop the first occurrence of a duplicate
          return false;
        }
        return true;
      });
      if (stops.length === day.stops.length && scheduled.issues.some((i) => i.severity === "error") && stops.length) {
        const last = scheduled.stops.at(-1)!;
        removed.push(`${last.place.name}: ${scheduled.issues.find((i) => i.severity === "error")!.message}`);
        stops = stops.slice(0, -1);
      }
      if (stops.length !== day.stops.length) changed = true;
      return { ...day, stops };
    });
    if (!changed) break;
  }
  return { plan: current, removed };
}
