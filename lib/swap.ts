// Swap suggestions, computed instantly in the browser with no LLM call.
// Every suggestion is pre-checked: swapping it in must not create a scheduling error.

import { distanceKm, candidatesFor, isBaseCity } from "@/lib/geo";
import type { Place } from "@/lib/places";
import { addDays, scheduleDay } from "@/lib/schedule";
import type { Plan } from "@/lib/schemas";

export interface Alternative {
  place: Place;
  km: number; // from the stop it would replace
  start: number; // when it would start
  matchedTags: string[];
}

const isFood = (p: Place) => p.type === "restaurant" || p.type === "cafe";

export function replaceStop(
  plan: Plan,
  dayIndex: number,
  stopIndex: number,
  placeId: string,
  why: string,
): Plan {
  const days = plan.days.map((d, i) =>
    i !== dayIndex
      ? d
      : { ...d, stops: d.stops.map((s, j) => (j === stopIndex ? { place_id: placeId, why } : s)) },
  );
  return { ...plan, days };
}

export function removeStop(plan: Plan, dayIndex: number, stopIndex: number): Plan {
  const days = plan.days.map((d, i) =>
    i !== dayIndex ? d : { ...d, stops: d.stops.filter((_, j) => j !== stopIndex) },
  );
  return { ...plan, days };
}

/** Up to `limit` alternatives of the same kind (meal for meal, sight for sight), best first. */
export function alternativesFor(
  plan: Plan,
  startDate: string,
  dayIndex: number,
  stopIndex: number,
  current: Place,
  limit = 4,
): Alternative[] {
  const used = new Set(plan.days.flatMap((d) => d.stops.map((s) => s.place_id)));
  const date = addDays(startDate, dayIndex);
  const bases = plan.bases.filter(isBaseCity);
  const preferred = new Set(plan.preferred_tags);
  const avoid = new Set(plan.avoid_tags);

  const options: (Alternative & { score: number })[] = [];
  for (const place of candidatesFor(bases)) {
    if (used.has(place.id) || isFood(place) !== isFood(current)) {
      continue;
    }

    const trial = replaceStop(plan, dayIndex, stopIndex, place.id, "");
    const day = scheduleDay(trial.days[dayIndex], date, bases);
    const hasError =
      day.issues.some((i) => i.severity === "error") ||
      day.stops.some((s) => s.issues.some((i) => i.severity === "error"));
    if (hasError) {
      continue;
    }

    const km = distanceKm(current, place);
    const matchedTags = place.tags.filter((t) => preferred.has(t));
    const avoided = place.tags.filter((t) => avoid.has(t)).length;
    // Simple, explainable ranking: quality + fit with the traveler, minus distance from the original stop.
    const score = (place.rating ?? 4) + matchedTags.length * 0.5 - avoided - km * 0.3;
    options.push({ place, km, start: day.stops[stopIndex].start, matchedTags, score });
  }
  return options.sort((a, b) => b.score - a.score).slice(0, limit);
}
