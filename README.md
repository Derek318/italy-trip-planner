# Three Days in Italy

A 3-day trip planner built on `italy.json` (about 100 places). Describe a trip in plain English ("Rome with my two kids, good food") and get a timed itinerary where opening hours, seasons and travel time have been checked by code.

## How it works

```
request -> detect base city (code) -> filter candidates (code) -> LLM picks + orders stops
        -> scheduler assigns times and checks them (code) -> errors? one LLM repair pass
        -> still broken? drop the stop with a visible reason
```

The split is deliberate: the LLM handles soft preferences ("two kids", "not too rushed"), and code handles hard constraints. The LLM never sets a time and can only reference place IDs from the candidate list.

| File | Responsibility |
|---|---|
| `lib/schemas.ts` | Zod schemas for the dataset, the LLM's output and API requests |
| `lib/places.ts` | Normalizes the messy data: parses every hours format, fills gaps with labeled defaults, documented corrections, excludes the 2.1-rated tourist trap |
| `lib/geo.ts` | Base city detection, day-trip reach (120 km), travel-time estimates |
| `lib/schedule.ts` | Assigns times and reports errors: closed days, seasons, travel, getting back to base, repeats |
| `lib/planner.ts` | The only file that calls the LLM (plan, repair, regenerate one day) |
| `lib/swap.ts` | Instant swap suggestions with no LLM call, each pre-checked against the scheduler |
| `app/page.tsx` | UI: request, day tabs, swap, remove, regenerate a day, map |

## Data issues handled

- 38 places with no hours. Public spaces are treated as open access; anything else is flagged "confirm before going".
- About 10 different hours formats (`Tues, Thurs-Sun 10:00-18:00`, `8am-7pm`, `8:00-01:00`, `Evenings`...). A test asserts every value in the file parses.
- Missing visit durations get a default by type, labeled as an assumption.
- Seasonal rules from free text (`Open April-October only`), the Brera market's third-weekend rule, a longitude that put a Milan market near Verona, a bar whose real hours were only in its description, and inconsistent tags.

## Run it

```bash
npm install
echo "ANTHROPIC_API_KEY=..." > .env.local
npm run dev
npm test
```
