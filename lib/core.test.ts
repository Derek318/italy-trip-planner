import { describe, expect, test } from "vitest";
import raw from "@/data/italy.json";
import { PLACES, PLACES_BY_ID, parseHours, parseOpenMonths, type Hours } from "@/lib/places";
import { candidatesFor, detectBases, distanceKm, travelBetween, travelMinutes } from "@/lib/geo";
import { dropInvalidStops, errorReport, scheduleDay, scheduleTrip } from "@/lib/schedule";
import { alternativesFor } from "@/lib/swap";
import type { Plan } from "@/lib/schemas";

// 2026-11-16 is a Monday, 2026-11-17 a Tuesday.
const MONDAY = "2026-11-16";
const TUESDAY = "2026-11-17";

const day = (ids: string[]) => ({ theme: "t", stops: ids.map((place_id) => ({ place_id, why: "" })) });
const errors = (d: ReturnType<typeof scheduleDay>) =>
  [...d.issues, ...d.stops.flatMap((s) => s.issues)].filter((i) => i.severity === "error").map((i) => i.message);
const fixed = (h: Hours) => {
  if (h.kind !== "fixed") throw new Error(`expected fixed hours, got ${h.kind}`);
  return h.byDay;
};

describe("parseHours", () => {
  test("day lists with gaps", () => {
    const week = fixed(parseHours("Tues, Thurs-Sun 10:00-18:00"));
    expect(week[2]).toEqual([{ open: 600, close: 1080 }]); // Tue
    expect(week[3]).toEqual([]); // Wed closed
    expect(week[0]).toHaveLength(1); // Sun open
  });
  test("ranges that wrap around the week", () => {
    const week = fixed(parseHours("Wed-Mon 10:00-19:00"));
    expect(week[2]).toEqual([]); // Tue closed
    expect(week[1]).toHaveLength(1); // Mon open
  });
  test("closing after midnight", () => {
    expect(fixed(parseHours("8:00-01:00"))[3]).toEqual([{ open: 480, close: 1500 }]);
  });
  test("am/pm", () => {
    expect(fixed(parseHours("9am-12:30pm"))[1]).toEqual([{ open: 540, close: 750 }]);
  });
  test("different hours on different days", () => {
    const week = fixed(parseHours("Mon-Fri 7:00-14:00, Sat 7:00-17:00"));
    expect(week[1]).toEqual([{ open: 420, close: 840 }]);
    expect(week[6]).toEqual([{ open: 420, close: 1020 }]);
    expect(week[0]).toEqual([]);
  });
  test("split lunch and dinner service", () => {
    expect(fixed(parseHours("Mon-Sat 12:30-14:30, 19:30-22:30"))[5]).toHaveLength(2);
  });
  test("vague and unparseable values", () => {
    expect(parseHours("Evenings").kind).toBe("approximate");
    expect(parseHours("by appointment").kind).toBe("unknown");
    expect(parseHours(null).kind).toBe("unknown");
  });
  test("every non-empty hours value in the dataset parses", () => {
    const failures = (raw as { id: string; hours: string | null }[])
      .filter((r) => r.hours && parseHours(r.hours).kind === "unknown")
      .map((r) => `${r.id}: ${r.hours}`);
    expect(failures).toEqual([]);
  });
});

describe("data normalization", () => {
  test("seasonal months", () => {
    expect(parseOpenMonths("Open April-October only.")).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(parseOpenMonths("October only, check exact dates")).toEqual([10]);
    expect(parseOpenMonths("Best May-September")).toBeNull(); // advice, not a rule
  });
  test("bad coordinates are corrected and the low-rated tourist trap is excluded", () => {
    expect(PLACES_BY_ID.get("place_059")!.lon).toBeCloseTo(9.19, 1);
    expect(PLACES_BY_ID.get("place_025")!.excludedReason).toMatch(/2.1/);
  });
  test("every place ends up with a usable duration", () => {
    expect(PLACES.every((p) => p.durationMinutes > 0)).toBe(true);
  });
});

describe("anchoring", () => {
  test("detects the base city from the request", () => {
    expect(detectBases("build me a rome trip for my two kids")).toEqual(["Rome"]);
    expect(detectBases("wine in Tuscany")).toEqual(["Florence"]);
    expect(detectBases("surprise me")).toEqual([]);
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
      title: "", summary: "", bases: ["Rome"], preferred_tags: [], avoid_tags: [], assumptions: [],
      days: [day(["place_001"]), day(["place_001"]), day([])],
    };
    expect(errorReport(scheduleTrip(plan, TUESDAY)).join()).toMatch(/Already visited/);
  });
});

describe("fallback and swaps", () => {
  const plan: Plan = {
    title: "", summary: "", bases: ["Florence"], preferred_tags: ["art"], avoid_tags: [], assumptions: [],
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
  const p = (id: string) => PLACES_BY_ID.get(id)!;
  test("uses the routed walking time within a city", () => {
    expect(travelBetween(p("place_001"), p("place_018"))).toBe(25); // Colosseum -> Trevi on foot
  });
  test("falls back to the distance estimate between cities", () => {
    const florenceToSiena = travelBetween(p("place_026"), p("place_038"));
    expect(florenceToSiena).toBe(travelMinutes(distanceKm(p("place_026"), p("place_038"))));
  });
});
