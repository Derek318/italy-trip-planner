// Turns the raw, messy italy.json into clean Place records the rest of the app can trust.
// Every guess or correction we make is recorded in `place.notes`, so the UI and the LLM
// can see exactly what is verified and what is not.

import { z } from "zod";
import raw from "@/data/italy.json";
import { RawPlaceSchema, type RawPlace } from "@/lib/schemas";

/** Minutes from midnight. `close` can exceed 1440 when a place closes after midnight. */
export interface Window {
  open: number;
  close: number;
}

export type Hours =
  | { kind: "fixed"; byDay: Window[][] } // index 0 = Sunday, like Date.getDay()
  | { kind: "approximate"; byDay: Window[][] } // e.g. "Evenings"
  | { kind: "always" } // public squares, viewpoints, neighborhoods
  | { kind: "unknown" };

export interface Place {
  id: string;
  name: string;
  type: string;
  city: string;
  region: string;
  neighborhood: string | null;
  description: string;
  lat: number;
  lon: number;
  hours: Hours;
  hoursText: string;
  durationMinutes: number;
  priceRange: string | null;
  rating: number | null;
  tags: string[];
  bookingRequired: boolean;
  seasonalNote: string | null;
  /** Months (1-12) the place operates. null = year-round. Hard constraint. */
  openMonths: number[] | null;
  /** Only open on the third weekend of the month (Brera market). Hard constraint. */
  thirdWeekendOnly: boolean;
  isDayTrip: boolean;
  /** Data-quality notes: what we inferred, corrected, or could not verify. */
  notes: string[];
  /** Why we refuse to recommend this place at all, or null. */
  excludedReason: string | null;
}

// ---------- Hours parsing ----------

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
const TIME_RANGE =
  /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g;

function emptyWeek(): Window[][] {
  return ALL_DAYS.map(() => []);
}

/** "mon-sat" -> [1..6], "wed-mon" wraps around the week, "daily" -> all days. */
function expandDays(spec: string): number[] | null {
  if (spec === "daily") return ALL_DAYS;
  const [from, to] = spec.split("-");
  const start = DAY_INDEX[from];
  if (start === undefined) return null;
  if (to === undefined) return [start];
  const end = DAY_INDEX[to];
  if (end === undefined) return null;
  const days: number[] = [];
  for (let d = start; ; d = (d + 1) % 7) {
    days.push(d);
    if (d === end) break;
  }
  return days;
}

function toMinutes(hour: string, min: string | undefined, ampm: string | undefined): number {
  let h = Number(hour);
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h * 60 + Number(min ?? 0);
}

function sameEveryDay(open: number, close: number): Window[][] {
  return ALL_DAYS.map(() => [{ open, close }]);
}

/**
 * Handles every format in the dataset, e.g.
 * "9:00-19:00", "8am-7pm", "8:00-01:00", "Daily 10:00-24:00", "Wed-Mon 10:00-19:00",
 * "Mon-Sat 12:30-14:30, 19:30-22:30", "Mon-Fri 7:00-14:00, Sat 7:00-17:00",
 * "Tues, Thurs-Sun 10:00-18:00", "Evenings", "Morning only".
 */
export function parseHours(text: string | null): Hours {
  if (!text) return { kind: "unknown" };
  const t = text.trim().toLowerCase();
  if (t === "evenings") return { kind: "approximate", byDay: sameEveryDay(18 * 60, 24 * 60) };
  if (t === "morning only") return { kind: "approximate", byDay: sameEveryDay(8 * 60, 12 * 60) };

  const byDay = emptyWeek();
  let days = ALL_DAYS; // segments without a day prefix inherit the previous days
  let pendingDays: number[] = []; // "Tues, Thurs-Sun ..." -> "Tues" has no times yet

  for (const segment of t.split(",").map((s) => s.trim()).filter(Boolean)) {
    const match = segment.match(/^([a-z]+(?:-[a-z]+)?)?\s*(.*)$/);
    const daySpec = match?.[1];
    const times = match?.[2] ?? "";

    if (daySpec) {
      const parsed = expandDays(daySpec);
      if (!parsed) return { kind: "unknown" };
      days = [...pendingDays, ...parsed];
      pendingDays = [];
      if (!times) {
        pendingDays = parsed;
        continue;
      }
    }

    const ranges = [...times.matchAll(TIME_RANGE)];
    if (ranges.length === 0) return { kind: "unknown" };
    for (const r of ranges) {
      const open = toMinutes(r[1], r[2], r[3]);
      let close = toMinutes(r[4], r[5], r[6]);
      if (close <= open) close += 24 * 60; // "8:00-01:00" closes after midnight
      for (const d of days) byDay[d].push({ open, close });
    }
  }
  return { kind: "fixed", byDay };
}

export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// ---------- Seasonality ----------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];
const MONTH_RE = MONTHS.join("|");

/** "Open April-October only" -> [4..10]; "October only" -> [10]. "Best May-September" is advice, not a rule. */
export function parseOpenMonths(note: string | null): number[] | null {
  if (!note || !/\bonly\b/i.test(note)) return null;
  const range = note.match(new RegExp(`(${MONTH_RE})\\s*-\\s*(${MONTH_RE})`, "i"));
  if (range) {
    const start = MONTHS.indexOf(range[1].toLowerCase()) + 1;
    const end = MONTHS.indexOf(range[2].toLowerCase()) + 1;
    const out: number[] = [];
    for (let m = start; ; m = (m % 12) + 1) {
      out.push(m);
      if (m === end) break;
    }
    return out;
  }
  const single = note.match(new RegExp(`\\b(${MONTH_RE})\\s+only`, "i"));
  return single ? [MONTHS.indexOf(single[1].toLowerCase()) + 1] : null;
}

// ---------- Defaults and corrections ----------

/** Public spaces with no listed hours are treated as always accessible. */
const OPEN_ACCESS_TYPES = new Set(["neighborhood", "viewpoint", "park", "historic_site"]);

/** Typical visit length when the dataset leaves it blank. */
const DEFAULT_DURATION: Record<string, number> = {
  viewpoint: 30, historic_site: 30, neighborhood: 90, park: 90, museum: 90,
  restaurant: 90, cafe: 30, market: 60, experience: 120, shop: 45,
};

const MIN_RATING = 3.0;

/**
 * Facts that only exist in free text, or values that are clearly wrong.
 * Each one is a deliberate, documented decision rather than a silent fix.
 */
function applyCorrections(p: Place): void {
  switch (p.id) {
    case "place_059": // Brera Antique Market
      p.lon = 9.191;
      p.notes.push("Coordinates corrected: listed longitude put it ~156 km from Milan.");
      p.thirdWeekendOnly = true;
      break;
    case "place_079": // Cremeria Mascareta: hours say "Evenings", description says "Open until 2am"
      p.hours = { kind: "approximate", byDay: sameEveryDay(18 * 60, 26 * 60) };
      p.hoursText = "Evenings until 2am (from description)";
      break;
    case "place_053": // Parma tour: "Tours run weekday mornings only"
      p.hours = { kind: "approximate", byDay: ALL_DAYS.map((d) => (d >= 1 && d <= 5 ? [{ open: 8 * 60, close: 15 * 60 }] : [])) };
      p.hoursText = "Weekday mornings (from seasonal note)";
      break;
  }
}

export function normalizePlace(r: RawPlace): Place {
  const notes: string[] = [];
  let hours = parseHours(r.hours);
  let hoursText = r.hours ?? "Not listed";

  if (hours.kind === "unknown") {
    if (OPEN_ACCESS_TYPES.has(r.type)) {
      hours = { kind: "always" };
      hoursText = "Open access (public space)";
    } else {
      notes.push("Hours not listed: confirm with the operator before going.");
    }
  } else if (hours.kind === "approximate") {
    notes.push(`Vague hours ("${r.hours}"): times are approximate.`);
  }

  let duration = r.duration_minutes;
  if (!duration) {
    duration = DEFAULT_DURATION[r.type] ?? 60;
    notes.push(`Visit length not listed: assumed ${duration} min.`);
  }

  if (r.booking_required === null) notes.push("Booking info missing: reserve to be safe.");

  const place: Place = {
    id: r.id,
    name: r.name,
    type: r.type,
    city: r.city,
    region: r.region,
    neighborhood: r.neighborhood,
    description: r.description,
    lat: r.latitude,
    lon: r.longitude,
    hours,
    hoursText,
    durationMinutes: duration,
    priceRange: r.price_range,
    rating: r.rating,
    tags: (r.tags ?? []).map((t) => t.replace(/_/g, "-")), // "local_favorite" -> "local-favorite"
    bookingRequired: r.booking_required ?? true,
    seasonalNote: r.seasonal_notes,
    openMonths: parseOpenMonths(r.seasonal_notes),
    thirdWeekendOnly: false,
    isDayTrip: duration >= 300,
    notes,
    excludedReason:
      r.rating !== null && r.rating < MIN_RATING ? `Rated ${r.rating}: below our ${MIN_RATING} bar.` : null,
  };
  applyCorrections(place);
  return place;
}

// Validate the file at load time: a malformed record fails loudly instead of leaking through.
export const PLACES: Place[] = z.array(RawPlaceSchema).parse(raw).map(normalizePlace);
export const PLACES_BY_ID = new Map(PLACES.map((p) => [p.id, p]));
