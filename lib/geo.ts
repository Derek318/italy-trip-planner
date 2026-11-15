// Geography: base cities, travel times, and which places are reachable from a base.
// Everything here is derived from the data; nothing is a hand-typed list of cities.

import walkingTimes from "@/data/walking-times.json";
import { distanceKm } from "@/lib/distance";
import { PLACES, type Place } from "@/lib/places";

export { distanceKm };
export type BaseCity = string;

/** A city needs this many places to fill 3 days. Smaller towns are day trips. */
const MIN_PLACES_FOR_BASE = 8;

/** Furthest a day trip can be (straight line). ~1-1.5h by train. */
const DAY_TRIP_KM = 120;

/** Longest walk we schedule before considering transit. */
const MAX_WALK_MIN = 25;

const placesIn = (city: string) => PLACES.filter((p) => p.city === city);

export const BASE_CITIES: BaseCity[] = [...new Set(PLACES.map((p) => p.city))]
  .filter((city) => placesIn(city).length >= MIN_PLACES_FOR_BASE)
  .sort((a, b) => placesIn(b).length - placesIn(a).length);

const CITY_CENTERS = new Map(
  [...new Set(PLACES.map((p) => p.city))].map((city) => {
    const ps = placesIn(city);
    return [
      city,
      {
        lat: ps.reduce((s, p) => s + p.lat, 0) / ps.length,
        lon: ps.reduce((s, p) => s + p.lon, 0) / ps.length,
      },
    ];
  }),
);

function baseCenter(base: BaseCity) {
  return CITY_CENTERS.get(base)!;
}

export function isBaseCity(city: string): boolean {
  return BASE_CITIES.includes(city);
}

/** True if the place is in the base city or close enough for a day trip. */
export function isReachable(place: Place, base: BaseCity): boolean {
  return place.city === base || distanceKm(baseCenter(base), place) <= DAY_TRIP_KM;
}

/** The candidate set the LLM is allowed to plan from. */
export function candidatesFor(bases: BaseCity[]): Place[] {
  return PLACES.filter(
    (p) => !p.excludedReason && (bases.length === 0 || bases.some((b) => isReachable(p, b))),
  );
}

// ---------- Travel time ----------

/** Rough door-to-door minutes from straight-line distance. Used when we have no routed time. */
export function travelMinutes(km: number): number {
  if (km <= 1.5) {
    return Math.ceil(((km * 1.3) / 4.5) * 60); // walk, with a detour factor
  }
  if (km <= 25) {
    return Math.ceil(10 + (km / 20) * 60); // metro, bus, taxi or vaporetto
  }
  return Math.ceil(30 + (km / 90) * 60); // regional train plus getting to the station
}

/** Real walking minutes between places in the same city, precomputed by scripts/build-walking-times.ts. */
const WALKING: Record<string, Record<string, number>> = walkingTimes.minutes;

/**
 * Minutes from one place to the next: the routed walking time when it is a reasonable walk,
 * otherwise whichever is faster of walking or taking transit. Different cities use the estimate.
 */
export function travelBetween(a: Place, b: Place): number {
  const walk = WALKING[a.id]?.[b.id];
  const estimate = travelMinutes(distanceKm(a, b));
  if (walk === undefined) {
    return estimate;
  }
  return walk <= MAX_WALK_MIN ? walk : Math.min(walk, estimate);
}
