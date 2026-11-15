import { describe, expect, test } from "vitest";
import raw from "@/data/italy.json";
import { PLACES, PLACES_BY_ID, type Hours } from "@/lib/places";
import { BASE_CITIES, baseCenter, candidatesFor, distanceKm, travelBetween, travelMinutes } from "@/lib/geo";
import { dropInvalidStops, errorReport, scheduleDay, scheduleTrip } from "@/lib/schedule";
import { alternativesFor } from "@/lib/swap";
import type { Plan } from "@/lib/schemas";

// 2026-11-16 is a Monday, 2026-11-17 a Tuesday.
const MONDAY = "2026-11-16";
const TUESDAY = "2026-11-17";
const [SUN, MON, TUE, WED] = [0, 1, 2, 3];

const day = (ids: string[]) => ({ theme: "t", stops: ids.map((place_id) => ({ place_id, why: "" })) });
const errors = (d: ReturnType<typeof scheduleDay>) =>
  [...d.issues, ...d.stops.flatMap((s) => s.issues)]
    .filter((i) => i.severity === "error")
    .map((i) => i.message);
const place = (id: string) => PLACES_BY_ID.get(id)!;
const week = (id: string) => {
  const h: Hours = place(id).hours;
  if (h.kind !== "fixed" && h.kind !== "approximate") {
    throw new Error(`${id} has ${h.kind} hours`);
  }
  return h.byDay;
};

// The hours and rules come from an LLM extraction (scripts/extract-place-facts.ts).
// These tests pin down the tricky cases it must get right, so a bad re-run fails loudly.
describe("extracted place facts", () => {
  test("every place with listed hours got structured hours", () => {
    const missing = (raw as { id: string; hours: string | null }[])
      .filter((r) => r.hours && place(r.id).hours.kind === "unknown")
      .map((r) => r.id);
    expect(missing).toEqual([]);
  });
  test("closed days", () => {
    expect(week("place_026")[MON]).toEqual([]); // Uffizi: "Tues-Sun 8:15-18:50"
    expect(week("place_062")[TUE]).toEqual([]); // "Wed-Mon 10:00-19:00" wraps around the week
    expect(week("place_064")[WED]).toEqual([]); // "Tues, Thurs-Sun 10:00-18:00"
    expect(week("place_064")[TUE]).toHaveLength(1);
  });
  test("split service and closing after midnight", () => {
    expect(week("place_003")[TUE]).toHaveLength(2); // lunch and dinner
    expect(week("place_020")[SUN][0].close).toBe(25 * 60); // "8:00-01:00"
  });
  test("facts that only exist in the description or notes", () => {
    expect(week("place_079")[TUE][0].close).toBe(26 * 60); // "Evenings" + "Open until 2am"
    expect(week("place_053")[SUN]).toEqual([]); // "Tours run weekday mornings only"
    expect(place("place_059").nthWeekendOnly).toBe(3); // Brera: third weekend only
  });
  test("seasonal rules versus seasonal advice", () => {
    expect(place("place_063").openMonths).toEqual([4, 5, 6, 7, 8, 9, 10]); // "Open April-October only"
    expect(place("place_090").openMonths).toEqual([10]); // "October only"
    expect(place("place_021").openMonths).toBeNull(); // "Best April-October... Sundays only" is advice
  });
});

describe("data cleanup", () => {
  test("a location far from the rest of its city is moved back, with a note", () => {
    const brera = place("place_059");
    expect(distanceKm(brera, baseCenter("Milan"))).toBeLessThan(5);
    expect(brera.notes.join()).toMatch(/km from anything else in Milan/);
  });
  test("the low-rated tourist trap is excluded", () => {
    expect(place("place_025").excludedReason).toMatch(/2.1/);
  });
  test("every place ends up with a usable duration", () => {
    expect(PLACES.every((p) => p.durationMinutes > 0)).toBe(true);
  });
});

describe("anchoring", () => {
  test("base cities come from the data: cities with enough places for 3 days", () => {
    expect(new Set(BASE_CITIES)).toEqual(new Set(["Rome", "Florence", "Venice", "Milan", "Bologna"]));
  });
  test("Rome candidates are all in Rome (nothing is a day trip away)", () => {
    expect(new Set(candidatesFor(["Rome"]).map((p) => p.city))).toEqual(new Set(["Rome"]));
  });
  test("Florence candidates include nearby day trips but not Venice", () => {
    const cities = new Set(candidatesFor(["Florence"]).map((p) => p.city));
    expect(cities.has("Siena")).toBe(true);
    expect(cities.has("Venice")).toBe(false);
  });
});

describe("scheduler", () => {
  test("assigns sequential times with travel in between", () => {
    const d = scheduleDay(day(["place_001", "place_018"]), TUESDAY, ["Rome"]); // Colosseum, Trevi
    const [colosseum, trevi] = d.stops;
    expect(colosseum.start).toBe(9 * 60);
    expect(trevi.travelBefore).toBeGreaterThan(0);
    expect(trevi.start).toBe(colosseum.end + trevi.travelBefore);
  });
  test("restaurants wait for lunch service", () => {
    const d = scheduleDay(day(["place_003"]), TUESDAY, ["Rome"]);
    expect(d.stops[0].start).toBeGreaterThanOrEqual(12 * 60 + 30);
  });
  test("flags a museum on its closed day", () => {
    const d = scheduleDay(day(["place_026"]), MONDAY, ["Florence"]); // Uffizi, closed Mondays
    expect(errors(d).join()).toMatch(/Closed or no time left on Monday/);
  });
  test("flags seasonal closures", () => {
    const d = scheduleDay(day(["place_063"]), TUESDAY, ["Milan"]); // Bellagio, Apr-Oct only
    expect(errors(d).join()).toMatch(/Closed in Nov/);
  });
  test("flags places too far from the base", () => {
    const d = scheduleDay(day(["place_067"]), TUESDAY, ["Rome"]);
    expect(errors(d).join()).toMatch(/too far/);
  });
  test("flags repeats across days", () => {
    const plan: Plan = {
      title: "",
      summary: "",
      bases: ["Rome"],
      preferred_tags: [],
      avoid_tags: [],
      assumptions: [],
      days: [day(["place_001"]), day(["place_001"]), day([])],
    };
    expect(errorReport(scheduleTrip(plan, TUESDAY)).join()).toMatch(/Already visited/);
  });
});

describe("fallback and swaps", () => {
  const plan: Plan = {
    title: "",
    summary: "",
    bases: ["Florence"],
    preferred_tags: ["art"],
    avoid_tags: [],
    assumptions: [],
    days: [day(["place_026", "place_084"]), day([]), day([])], // Uffizi on a Monday, then Ponte Vecchio
  };
  test("drops only the invalid stop and explains why", () => {
    const { plan: cleaned, removed } = dropInvalidStops(plan, MONDAY);
    expect(cleaned.days[0].stops.map((s) => s.place_id)).toEqual(["place_084"]);
    expect(removed[0]).toMatch(/Uffizi/);
  });
  test("swap suggestions never introduce an error", () => {
    const alts = alternativesFor(plan, TUESDAY, 0, 1, PLACES_BY_ID.get("place_084")!);
    expect(alts.length).toBeGreaterThan(0);
    for (const alt of alts) {
      const swapped = structuredClone(plan);
      swapped.days[0].stops[1].place_id = alt.place.id;
      expect(errors(scheduleDay(swapped.days[0], TUESDAY, ["Florence"]))).toEqual([]);
    }
  });
});

describe("travel times", () => {
  const p = place;
  test("uses the routed walking time within a city", () => {
    expect(travelBetween(p("place_001"), p("place_018"))).toBe(25); // Colosseum -> Trevi on foot
  });
  test("falls back to the distance estimate between cities", () => {
    const florenceToSiena = travelBetween(p("place_026"), p("place_038"));
    expect(florenceToSiena).toBe(travelMinutes(distanceKm(p("place_026"), p("place_038"))));
  });
});
