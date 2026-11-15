// The only file that talks to the LLM.
// Flow: filter candidates in code -> LLM picks and orders stops -> code schedules and checks
// -> if there are errors, send them back once for repair -> drop anything still invalid.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { PLACES, type Place } from "@/lib/places";
import { BASE_CITIES, candidatesFor, detectBases, isBaseCity, type BaseCity } from "@/lib/geo";
import { DayResponseSchema, PlanSchema, type Plan, type PlannedDay } from "@/lib/schemas";
import { addDays, dropInvalidStops, errorReport, scheduleTrip, weekdayName } from "@/lib/schedule";

const MODEL = "claude-opus-5-5";
let client: Anthropic | null = null; // created on first use so builds don't need the API key

const TAG_VOCABULARY = [...new Set(PLACES.flatMap((p) => p.tags))].sort();

const RULES = `You plan 3-day trips in Italy from a fixed list of candidate places.

Hard rules:
- Use only place_id values from the candidate list. Never invent places.
- Each day: stops in visiting order, including lunch and dinner where the list allows.
- You choose WHICH places and in WHAT ORDER. Code assigns the times from visit length,
  travel time and opening hours, so order things sensibly: morning-tagged and early-opening
  places first, evening-tagged places and dinner last. A restaurant placed before the
  afternoon sights is scheduled as lunch; put dinner after them so it lands in the evening.
- Check each place's hours against the weekday of that date. Do not schedule a place on a day it is closed.
- Keep each day geographically tight: cluster by neighborhood and avoid backtracking.
- A place in another town is a day trip: give it the whole day (plus nearby meals). At most one other town per day.
- Pace: about 4-6 stops a day including meals. Fewer for kids, older travelers or "relaxed"; more for "packed".
- Never repeat a place across days.

Personalize:
- "why" must be specific to this traveler (their kids, food interests, budget), not generic praise.
- preferred_tags / avoid_tags must come from the tag vocabulary.
- If the request cannot be fully met with this data, plan the closest sensible trip and say so in assumptions.`;

function placeLine(p: Place): string {
  return [
    p.id, p.name, p.type, `${p.city}${p.neighborhood ? `, ${p.neighborhood}` : ""}`,
    `hours: ${p.hoursText}`, `${p.durationMinutes} min`, p.priceRange ?? "price ?",
    p.rating ? `rating ${p.rating}` : "unrated", `tags: ${p.tags.join(", ")}`,
    p.bookingRequired ? "book ahead" : "", p.seasonalNote ? `season: ${p.seasonalNote}` : "",
    p.thirdWeekendOnly ? "third weekend of the month only" : "",
    p.description,
  ].filter(Boolean).join(" | ");
}

function system(candidates: Place[]): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    { type: "text", text: RULES },
    {
      type: "text",
      text: `Tag vocabulary: ${TAG_VOCABULARY.join(", ")}\n\nCandidate places:\n${candidates.map(placeLine).join("\n")}`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

function tripContext(request: string, startDate: string, bases: BaseCity[]): string {
  const dates = [0, 1, 2].map((i) => {
    const d = addDays(startDate, i);
    return `Day ${i + 1}: ${weekdayName(d)} ${d}`;
  });
  const baseLine = bases.length
    ? `Base city (detected from the request, use exactly): ${bases.join(", ")}`
    : `No city mentioned. Choose one base (two only if the request implies it) from: ${BASE_CITIES.join(", ")}.`;
  return `Traveler request: """${request}"""\n\n${dates.join("\n")}\n${baseLine}`;
}

async function ask<S extends z.ZodType>(
  schema: S,
  candidates: Place[],
  messages: Anthropic.Beta.BetaMessageParam[],
): Promise<z.infer<S>> {
  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // if the model declines, the API retries on a fallback model
    // "low" measured ~14s vs ~21-43s at "medium" with equal or better plans on sample requests;
    // the scheduler and repair loop catch the mistakes that matter.
    output_config: { effort: "low", format: zodOutputFormat(schema) },
    system: system(candidates),
    messages,
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  if (!response.parsed_output) throw new Error(`No valid plan returned (stop: ${response.stop_reason}).`);
  return response.parsed_output;
}

export interface PlanResult {
  plan: Plan;
  /** Errors in the first draft that the repair pass fixed. Shown to the user for transparency. */
  fixed: string[];
  /** Stops removed by code because they were still invalid after repair. */
  removed: string[];
}

/** Repair once, then fall back to dropping invalid stops. */
async function checkAndRepair(
  draft: Plan,
  startDate: string,
  candidates: Place[],
  messages: Anthropic.Beta.BetaMessageParam[],
  repair: (errors: string[]) => Promise<Plan>,
): Promise<PlanResult> {
  const firstErrors = errorReport(scheduleTrip(draft, startDate));
  if (firstErrors.length === 0) return { plan: draft, fixed: [], removed: [] };

  const repaired = await repair(firstErrors);
  const stillBroken = new Set(errorReport(scheduleTrip(repaired, startDate)));
  const { plan, removed } = dropInvalidStops(repaired, startDate);
  return { plan, fixed: firstErrors.filter((e) => !stillBroken.has(e)), removed };
}

function repairMessage(errors: string[]): string {
  return `The scheduler checked your plan against opening hours, seasons and travel times and found:\n- ${errors.join("\n- ")}\n\nReturn the corrected version. Keep everything that had no problem.`;
}

export async function planTrip(request: string, startDate: string): Promise<PlanResult> {
  const bases = detectBases(request);
  const candidates = candidatesFor(bases);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: tripContext(request, startDate, bases) },
  ];
  const draft = await ask(PlanSchema, candidates, messages);
  if (bases.length) draft.bases = bases; // the detected anchor is not negotiable

  return checkAndRepair(draft, startDate, candidates, messages, async (errors) => {
    const fixed = await ask(PlanSchema, candidates, [
      ...messages,
      { role: "assistant", content: JSON.stringify(draft) },
      { role: "user", content: repairMessage(errors) },
    ]);
    if (bases.length) fixed.bases = bases;
    return fixed;
  });
}

/** Regenerates one day; the other two days stay exactly as they are. */
export async function replanDay(
  request: string,
  startDate: string,
  plan: Plan,
  dayIndex: number,
  instruction: string,
): Promise<PlanResult> {
  const bases = plan.bases.filter(isBaseCity);
  const usedElsewhere = new Set(
    plan.days.flatMap((d, i) => (i === dayIndex ? [] : d.stops.map((s) => s.place_id))),
  );
  const candidates = candidatesFor(bases).filter((p) => !usedElsewhere.has(p.id));
  const current = plan.days[dayIndex];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `${tripContext(request, startDate, bases)}

Regenerate only Day ${dayIndex + 1}. The other days are fixed and their places are not in the candidate list.
Current Day ${dayIndex + 1}: ${current.theme}: ${current.stops.map((s) => s.place_id).join(", ")}
${instruction ? `Traveler's change request for this day: """${instruction}"""` : "Give a fresh alternative for this day."}`,
    },
  ];

  const withDay = (day: PlannedDay): Plan => ({
    ...plan,
    days: plan.days.map((d, i) => (i === dayIndex ? day : d)),
  });
  const draft = withDay((await ask(DayResponseSchema, candidates, messages)).day);

  return checkAndRepair(draft, startDate, candidates, messages, async (errors) => {
    const dayErrors = errors.filter((e) => e.startsWith(`Day ${dayIndex + 1}`));
    const fixed = await ask(DayResponseSchema, candidates, [
      ...messages,
      { role: "assistant", content: JSON.stringify({ day: draft.days[dayIndex] }) },
      { role: "user", content: repairMessage(dayErrors.length ? dayErrors : errors) },
    ]);
    return withDay(fixed.day);
  });
}
