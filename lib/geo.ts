// Geography: distances, travel-time estimates, and which places are reachable from a base city.

import { PLACES, type Place } from "@/lib/places";

/** Cities with enough places to stay in for 3 days. Everything else is a day trip. */
export const BASE_CITIES = ["Rome", "Florence", "Venice", "Milan", "Bologna"] as const;
export type BaseCity = (typeof BASE_CITIES)[number];

/** Furthest a day trip can be (straight line). ~1-1.5h by train. */
const DAY_TRIP_KM = 120;

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Rough door-to-door minutes. Deliberately conservative: better a loose plan than a missed train. */
export function travelMinutes(km: number): number {
  if (km <= 1.5) return Math.ceil((km * 1.3 / 4.5) * 60); // walk, with a detour factor
  if (km <= 25) return Math.ceil(10 + (km / 20) * 60); // metro, bus, taxi or vaporetto
  return Math.ceil(30 + (km / 90) * 60); // regional train plus getting to the station
}

function centroid(places: Place[]) {
  return {
    lat: places.reduce((s, p) => s + p.lat, 0) / places.length,
    lon: places.reduce((s, p) => s + p.lon, 0) / places.length,
  };
}

const CITY_CENTERS = new Map<string, { lat: number; lon: number }>();
for (const city of new Set(PLACES.map((p) => p.city))) {
  CITY_CENTERS.set(city, centroid(PLACES.filter((p) => p.city === city)));
}

export function baseCenter(base: BaseCity) {
  return CITY_CENTERS.get(base)!;
}

export function isBaseCity(city: string): city is BaseCity {
  return (BASE_CITIES as readonly string[]).includes(city);
}

/** The base city closest to a point, used to decide where a day trip returns to. */
export function nearestBase(point: { lat: number; lon: number }, bases: BaseCity[]): BaseCity {
  return bases.reduce((best, b) =>
    distanceKm(baseCenter(b), point) < distanceKm(baseCenter(best), point) ? b : best,
  );
}

/** Words a user might type, mapped to the base city they imply. */
const ALIASES: Record<string, BaseCity> = {
  rome: "Rome", roma: "Rome", lazio: "Rome", vatican: "Rome",
  florence: "Florence", firenze: "Florence", tuscany: "Florence", siena: "Florence", chianti: "Florence",
  venice: "Venice", venezia: "Venice", veneto: "Venice", burano: "Venice",
  milan: "Milan", milano: "Milan", lombardy: "Milan", como: "Milan", "lake como": "Milan", bellagio: "Milan",
  bologna: "Bologna", "emilia-romagna": "Bologna", modena: "Bologna", parma: "Bologna",
};

/** Finds the base cities a request mentions, e.g. "3 days in Rome with kids" -> ["Rome"]. */
export function detectBases(request: string): BaseCity[] {
  const text = request.toLowerCase();
  const found = new Set<BaseCity>();
  for (const [word, base] of Object.entries(ALIASES)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) found.add(base);
  }
  return [...found];
}

/** True if the place is in the base city or close enough for a day trip. */
export function isReachable(place: Place, base: BaseCity): boolean {
  if (place.city === base) return true;
  const center = CITY_CENTERS.get(base)!;
  return distanceKm(center, place) <= DAY_TRIP_KM;
}

/** The candidate set the LLM is allowed to plan from. */
export function candidatesFor(bases: BaseCity[]): Place[] {
  return PLACES.filter(
    (p) => !p.excludedReason && (bases.length === 0 || bases.some((b) => isReachable(p, b))),
  );
}
