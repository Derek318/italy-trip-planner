// One-off script: fetches real walking times between every pair of places in the same city
// from the free OSRM foot router (OpenStreetMap data, run by FOSSGIS) and saves them to
// data/walking-times.json. The app reads that file, so it makes no routing calls at runtime.
//
// Run: npm run build:walking   (re-run only if places or coordinates change)

import { writeFileSync } from "node:fs";
import { PLACES, type Place } from "@/lib/places";

const ROUTER = "https://routing.openstreetmap.de/routed-foot/table/v1/driving";

async function walkingTable(places: Place[]): Promise<number[][]> {
  const coords = places.map((p) => `${p.lon},${p.lat}`).join(";");
  const res = await fetch(`${ROUTER}/${coords}?annotations=duration`, {
    headers: { "User-Agent": "trip-planner-precompute/1.0" },
  });
  const body = await res.json();
  if (body.code !== "Ok") {
    throw new Error(`Router error: ${body.code} ${body.message ?? ""}`);
  }
  return body.durations; // seconds, durations[i][j] = from place i to place j
}

async function main() {
  const byCity = new Map<string, Place[]>();
  for (const p of PLACES) {
    byCity.set(p.city, [...(byCity.get(p.city) ?? []), p]);
  }

  const minutes: Record<string, Record<string, number>> = {};
  for (const [city, places] of byCity) {
    if (places.length < 2) {
      continue;
    }
    const table = await walkingTable(places);
    places.forEach((from, i) => {
      minutes[from.id] = {};
      places.forEach((to, j) => {
        if (i !== j && table[i][j] !== null) {
          minutes[from.id][to.id] = Math.ceil(table[i][j] / 60);
        }
      });
    });
    console.log(`${city}: ${places.length} places`);
    await new Promise((r) => setTimeout(r, 1100)); // stay under the router's 1 request/second policy
  }

  writeFileSync(
    "data/walking-times.json",
    JSON.stringify(
      { source: "OSRM foot router, routing.openstreetmap.de (OpenStreetMap)", minutes },
      null,
      1,
    ),
  );
}

main();
