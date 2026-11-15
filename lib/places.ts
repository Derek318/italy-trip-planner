// Builds clean Place records from two files:
//   data/italy.json        the raw dataset (source of truth for places)
//   data/place-facts.json  hours and rules that Claude extracted offline from the messy text
//                          (scripts/extract-place-facts.ts), so no text parsing happens here.
// Every default or fix we apply is recorded in `place.notes`, which the UI shows.

import { z } from "zod";
import raw from "@/data/italy.json";
import factsFile from "@/data/place-facts.json";
import { PlaceFactsFileSchema, RawPlaceSchema, type PlaceFacts, type RawPlace } from "@/lib/schemas";

/** Minutes from midnight. `close` can exceed 1440 when a place closes after midnight. */
export interface Window {
  open: number;
  close: number;
}

export type Hours =
  | { kind: "fixed"; byDay: Window[][] } // index 0 = Sunday, like Date.getDay()
  | { kind: "approximate"; byDay: Window[][] } // the source was vague, e.g. "Evenings"
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
  /** Months (1-12) the place operates. null = year-round. */
  openMonths: number[] | null;
  /** e.g. 3 = only on the third weekend of the month. */
  nthWeekendOnly: number | null;
  /** What we inferred, defaulted or fixed. Shown to the traveler. */
  notes: string[];
  /** Why we refuse to recommend this place at all, or null. */
  excludedReason: string | null;
}

/** Public spaces with no listed hours are treated as always accessible. */
const OPEN_ACCESS_TYPES = new Set(["neighborhood", "viewpoint", "park", "historic_site"]);

/** Typical visit length when the dataset leaves it blank. */
const DEFAULT_DURATION: Record<string, number> = {
  viewpoint: 30,
  historic_site: 30,
  neighborhood: 90,
  park: 90,
  museum: 90,
  restaurant: 90,
  cafe: 30,
  market: 60,
  experience: 120,
  shop: 45,
};

const MIN_RATING = 3.0;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const; // index = Date.getDay()

function toMinutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + m;
}

function toHours(facts: PlaceFacts | undefined): Hours {
  if (!facts?.weekly_hours) {
    return { kind: "unknown" };
  }
  const week = facts.weekly_hours;
  const byDay = DAY_KEYS.map((day) =>
    week[day].map((w) => {
      const open = toMinutes(w.open);
      let close = toMinutes(w.close);
      if (close <= open) {
        close += 24 * 60; // "01:00" closing means after midnight
      }
      return { open, close };
    }),
  );
  return { kind: facts.hours_approximate ? "approximate" : "fixed", byDay };
}

function normalizePlace(r: RawPlace, facts: PlaceFacts | undefined): Place {
  const notes: string[] = [];
  if (facts?.inference_note) {
    notes.push(facts.inference_note);
  }

  let hours = toHours(facts);
  let hoursText = r.hours ?? "Not listed";
  if (hours.kind === "unknown") {
    if (OPEN_ACCESS_TYPES.has(r.type)) {
      hours = { kind: "always" };
      hoursText = "Open access (public space)";
    } else {
      notes.push("Hours not listed: confirm with the operator before going.");
    }
  } else if (hours.kind === "approximate") {
    notes.push(`Vague hours ("${r.hours ?? "see notes"}"): times are approximate.`);
  }

  let duration = r.duration_minutes;
  if (!duration) {
    duration = DEFAULT_DURATION[r.type] ?? 60;
    notes.push(`Visit length not listed: assumed ${duration} min.`);
  }
  if (r.booking_required === null) {
    notes.push("Booking info missing: reserve to be safe.");
  }

  return {
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
    openMonths: facts?.open_months ?? null,
    nthWeekendOnly: facts?.nth_weekend_only ?? null,
    notes,
    excludedReason:
      r.rating !== null && r.rating < MIN_RATING ? `Rated ${r.rating}: below our ${MIN_RATING} bar.` : null,
  };
}

function loadPlaces(): Place[] {
  // Validate both files at load time: malformed data fails loudly instead of leaking through.
  const rawPlaces = z.array(RawPlaceSchema).parse(raw);
  const facts = new Map(PlaceFactsFileSchema.parse(factsFile).places.map((f) => [f.id, f]));
  return rawPlaces.map((r) => normalizePlace(r, facts.get(r.id)));
}

export const PLACES: Place[] = loadPlaces();
export const PLACES_BY_ID = new Map(PLACES.map((p) => [p.id, p]));

export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
