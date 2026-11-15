// One-off script: has Claude read each place's free-text hours, seasonal notes and description,
// and turn them into structured facts (weekly hours, months open, special rules).
// Output: data/place-facts.json, validated with Zod. The app reads that file, so no text
// parsing happens at runtime. Re-run only when italy.json changes, then review the diff.
//
// Run: npm run build:facts

import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import raw from "@/data/italy.json";
import { PlaceFactsSchema, RawPlaceSchema, type RawPlace } from "@/lib/schemas";

const client = new Anthropic();
const BATCH = 20;

const INSTRUCTIONS = `Extract structured opening facts for each place. Use only what the text says.

- weekly_hours: hours per day. A day not covered by a day range is closed (empty array).
  Split service like "12:30-14:30, 19:30-22:30" becomes two windows. "8am-7pm" is 08:00-19:00.
  A closing time after midnight is written as-is ("01:00", "02:00").
- Vague hours: "Evenings" = 18:00-24:00 every day, "Morning only" = 08:00-12:00 every day; set hours_approximate.
- If the description or seasonal note states hours more precisely than the hours field
  (e.g. "Open until 2am", "Tours run weekday mornings only"), use them, set hours_approximate if still vague,
  and explain in inference_note.
- If hours are missing and the text gives no hours, weekly_hours is null. Do not guess.
- open_months only for hard rules ("April-October only", "October only", "Rooftop open May-September only").
  "Best April-October" is advice, not a rule: null.
- nth_weekend_only for rules like "third weekend of each month only".`;

function placeText(r: RawPlace): string {
  return JSON.stringify({
    id: r.id,
    name: r.name,
    type: r.type,
    hours: r.hours,
    seasonal_notes: r.seasonal_notes,
    description: r.description,
  });
}

async function extract(batch: RawPlace[]) {
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: {
      effort: "medium",
      format: zodOutputFormat(z.object({ places: z.array(PlaceFactsSchema) })),
    },
    system: INSTRUCTIONS,
    messages: [{ role: "user", content: batch.map(placeText).join("\n") }],
  });
  if (!response.parsed_output) {
    throw new Error(`Extraction failed (stop: ${response.stop_reason})`);
  }
  return response.parsed_output.places;
}

async function main() {
  const places = z.array(RawPlaceSchema).parse(raw);
  const batches = [];
  for (let i = 0; i < places.length; i += BATCH) {
    batches.push(places.slice(i, i + BATCH));
  }

  const results = (await Promise.all(batches.map(extract))).flat();
  const missing = places.filter((p) => !results.some((r) => r.id === p.id)).map((p) => p.id);
  if (missing.length) {
    throw new Error(`No facts returned for: ${missing.join(", ")}`);
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync("data/place-facts.json", JSON.stringify({ places: results }, null, 1));
  console.log(`Wrote facts for ${results.length} places.`);
}

main();
