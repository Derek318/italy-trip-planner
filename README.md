# Three Days in Italy

A 3-day trip planner built on `italy.json` (about 100 places). Describe a trip in plain English ("Rome with my two kids, good food") and get a timed itinerary where opening hours, seasons and travel time have been checked by code.

## How it works

```
request -> Haiku picks the base city -> code filters candidates to what that base can reach
        -> Opus picks + orders stops -> code assigns times and checks them
        -> errors? one repair pass -> still broken? drop the stop with a visible reason
```

The split is deliberate: LLMs handle language and soft preferences ("the Eternal City", "two kids", "not too rushed"), and code enforces hard constraints. The planner never sets a time and can only reference place IDs from the candidate list.

| File                             | Responsibility                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `lib/schemas.ts`                 | Zod schemas for every boundary: dataset, extracted facts, LLM output, API requests      |
| `lib/places.ts`                  | Merges raw places with extracted facts, labeled defaults, coordinate outlier fix        |
| `lib/geo.ts`                     | Base cities (derived from the data), day-trip reach, travel times                       |
| `lib/schedule.ts`                | Assigns times and reports errors: closed days, seasons, travel, return to base          |
| `lib/planner.ts`                 | The only runtime LLM code: base detection (Haiku), planning and repair (Opus)           |
| `lib/swap.ts`                    | Instant swap suggestions with no LLM call, each pre-checked against the scheduler       |
| `app/page.tsx`                   | UI: request, day tabs, swap, remove, regenerate a day, map                              |
| `scripts/extract-place-facts.ts` | One-off: Claude turns messy hours/notes into structured facts (`data/place-facts.json`) |
| `scripts/build-walking-times.ts` | One-off: real walking times from the free OSRM foot router (`data/walking-times.json`)  |

## Messy data: handled offline, checked by tests

- **Hours and rules** come in ~10 free-text formats, and some facts live only in descriptions ("Open until 2am", "third weekend of each month only"). Claude extracts them once into structured, Zod-validated JSON. Checked by diffing against a hand-written parser (101/103 identical; of the two differences, one was a bug in the hand parser) and by tests that pin down every tricky case.
- **Missing hours:** public spaces are open access; anything else is flagged "confirm before going".
- **Missing durations** get a default by type, labeled as an assumption.
- **Bad coordinates:** a place far from everything else in its city is moved to its neighborhood, with a note (catches a Milan market listed near Verona).
- **Low-quality places:** below 3.0 stars are excluded.

## Run it

```bash
npm install
echo "ANTHROPIC_API_KEY=..." > .env.local
npm run dev
npm test
```
