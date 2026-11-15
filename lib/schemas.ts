// Zod schemas for every boundary where untrusted data enters the app:
// the dataset file, the LLM's output, and API request bodies.

import { z } from "zod";

/** One record in italy.json. Nullable wherever the real data has gaps. */
export const RawPlaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  city: z.string(),
  region: z.string(),
  neighborhood: z.string().nullable(),
  description: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  hours: z.string().nullable(),
  duration_minutes: z.number().int().positive().nullable(),
  price_range: z.string().nullable(),
  rating: z.number().min(0).max(5).nullable(),
  tags: z.array(z.string()).nullable(),
  seasonal_notes: z.string().nullable(),
  booking_required: z.boolean().nullable(),
});
export type RawPlace = z.infer<typeof RawPlaceSchema>;

// ---------- Facts extracted offline from messy text (scripts/extract-place-facts.ts) ----------

const Clock = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .describe("24h time, e.g. 09:30. Use 01:00 for 1am closing");
const OpenWindow = z.object({ open: Clock, close: Clock });
const DayHours = z.array(OpenWindow).describe("Empty array = closed that day");

export const PlaceFactsSchema = z.object({
  id: z.string(),
  weekly_hours: z
    .object({
      mon: DayHours,
      tue: DayHours,
      wed: DayHours,
      thu: DayHours,
      fri: DayHours,
      sat: DayHours,
      sun: DayHours,
    })
    .nullable()
    .describe("null when no hours can be determined from the text"),
  hours_approximate: z.boolean().describe("true when the source is vague, e.g. 'Evenings' or 'Morning only'"),
  open_months: z
    .array(z.number().int().min(1).max(12))
    .nullable()
    .describe("Months it operates, only for hard rules like 'April-October only'. null = year-round"),
  nth_weekend_only: z
    .number()
    .int()
    .min(1)
    .max(5)
    .nullable()
    .describe("e.g. 3 for 'third weekend of each month only'"),
  inference_note: z
    .string()
    .nullable()
    .describe("Short note when a fact came from the description or notes rather than the hours field"),
});
export const PlaceFactsFileSchema = z.object({ places: z.array(PlaceFactsSchema) });
export type PlaceFacts = z.infer<typeof PlaceFactsSchema>;

// ---------- What the LLM returns ----------
// The LLM only chooses and orders places. Code assigns all times (see lib/schedule.ts).

export const PlannedStopSchema = z.object({
  place_id: z.string().describe("An id from the candidate list, e.g. place_001"),
  why: z.string().describe("One short sentence on why this fits this traveler"),
});

export const PlannedDaySchema = z.object({
  theme: z.string().describe("Short title for the day, e.g. 'Ancient Rome and Monti'"),
  stops: z.array(PlannedStopSchema).describe("Stops in visiting order, including meals"),
});

export const PlanSchema = z.object({
  title: z.string(),
  summary: z.string().describe("Two sentences max: the shape of the trip and why"),
  bases: z.array(z.string()).describe("Base city or cities, from the allowed list"),
  preferred_tags: z.array(z.string()).describe("Dataset tags this traveler would like"),
  avoid_tags: z.array(z.string()).describe("Dataset tags this traveler would dislike"),
  assumptions: z.array(z.string()).describe("Anything assumed or not possible with this data"),
  days: z.array(PlannedDaySchema).describe("Exactly 3 days, in order"),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlannedDay = z.infer<typeof PlannedDaySchema>;

/** Response shape when regenerating a single day. */
export const DayResponseSchema = z.object({ day: PlannedDaySchema });

// ---------- API request bodies ----------

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PlanRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("trip"),
    request: z.string().trim().min(3).max(600),
    startDate: DateString,
  }),
  z.object({
    mode: z.literal("day"),
    request: z.string().trim().max(600),
    startDate: DateString,
    plan: PlanSchema,
    dayIndex: z.number().int().min(0).max(2),
    instruction: z.string().trim().max(300).default(""),
  }),
]);
export type PlanRequest = z.infer<typeof PlanRequestSchema>;
