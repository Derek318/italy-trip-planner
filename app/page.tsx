"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { IssueList, StopRow, TravelLine } from "@/components/StopRow";
import { addDays, scheduleTrip, weekdayName } from "@/lib/schedule";
import { alternativesFor, removeStop, replaceStop } from "@/lib/swap";
import type { Plan } from "@/lib/schemas";

const DayMap = dynamic(() => import("@/components/DayMap"), { ssr: false });

const EXAMPLES = [
  "Rome with my two kids (8 and 11), we care about good food",
  "Florence for a couple who love art and wine, not too rushed",
  "Venice, quiet spots away from the crowds, mid budget",
];

interface PlanResponse {
  plan: Plan;
  fixed: string[];
  removed: string[];
}

function defaultStartDate() {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

async function callPlanner(body: object): Promise<PlanResponse> {
  const res = await fetch("/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? "Something went wrong.");
  }
  return data;
}

export default function Home() {
  const [request, setRequest] = useState("");
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [result, setResult] = useState<PlanResponse | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null); // the live, user-edited plan
  const [activeDay, setActiveDay] = useState(0);
  const [swapping, setSwapping] = useState<number | null>(null);
  const [dayInstruction, setDayInstruction] = useState("");
  const [loading, setLoading] = useState<"trip" | "day" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Times are always recomputed from the current plan, so every edit is re-checked instantly.
  const trip = useMemo(() => (plan ? scheduleTrip(plan, startDate) : null), [plan, startDate]);
  const day = trip?.days[activeDay];

  async function planTrip(text = request) {
    setLoading("trip");
    setError(null);
    try {
      const data = await callPlanner({ mode: "trip", request: text, startDate });
      setResult(data);
      setPlan(data.plan);
      setActiveDay(0);
      setSwapping(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  async function regenerateDay() {
    if (!plan) {
      return;
    }
    setLoading("day");
    setError(null);
    try {
      const data = await callPlanner({
        mode: "day",
        request,
        startDate,
        plan,
        dayIndex: activeDay,
        instruction: dayInstruction,
      });
      setResult(data);
      setPlan(data.plan);
      setSwapping(null);
      setDayInstruction("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <header className="mb-6">
        <h1 className="font-serif text-3xl text-stone-900 sm:text-4xl">Three days in Italy</h1>
        <p className="mt-1 text-stone-600">
          Describe your trip. You get a 3-day plan built only from our place list, with opening hours, seasons
          and travel time checked.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          planTrip();
        }}
        className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
      >
        <Textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder="e.g. Build me a Rome trip for my two kids, with good food"
          maxLength={600}
          rows={3}
          className="resize-none"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                setRequest(ex);
                planTrip(ex);
              }}
              disabled={loading !== null}
              className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:border-amber-600 hover:text-amber-800 disabled:opacity-50"
            >
              {ex}
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm text-stone-600">
            Arriving
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 w-44"
              required
            />
          </label>
          <Button
            type="submit"
            disabled={loading !== null || request.trim().length < 3}
            className="bg-amber-700 hover:bg-amber-800"
          >
            {loading === "trip" ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Planning…
              </>
            ) : (
              "Plan my trip"
            )}
          </Button>
          {loading === "trip" && (
            <span className="text-sm text-stone-500">
              Picking places, then checking hours and travel times. ~30s.
            </span>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </form>

      {plan && trip && result && (
        <section className="mt-8">
          <div className="mb-4">
            <h2 className="font-serif text-2xl text-stone-900">{plan.title}</h2>
            <p className="mt-1 max-w-3xl text-stone-600">{plan.summary}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded-full bg-stone-900 px-3 py-0.5 text-white">
                Base: {trip.bases.join(" + ")}
              </span>
              <span className="flex items-center gap-1 text-emerald-700">
                <CheckCircle2 className="size-4" /> Checked against hours, seasons and travel time
              </span>
            </div>
            {(result.fixed.length > 0 || result.removed.length > 0 || plan.assumptions.length > 0) && (
              <details className="mt-3 max-w-3xl text-sm text-stone-600">
                <summary className="cursor-pointer select-none">
                  How this plan was checked
                  {result.fixed.length > 0 &&
                    ` (${result.fixed.length} problem${result.fixed.length > 1 ? "s" : ""} fixed)`}
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {result.fixed.map((f) => (
                    <li key={f}>Fixed in the first draft: {f}</li>
                  ))}
                  {result.removed.map((r) => (
                    <li key={r}>Removed: {r}</li>
                  ))}
                  {plan.assumptions.map((a) => (
                    <li key={a}>Assumption: {a}</li>
                  ))}
                </ul>
              </details>
            )}
            <IssueList issues={trip.issues} />
          </div>

          <div className="mb-4 flex gap-2 overflow-x-auto">
            {trip.days.map((d, i) => (
              <button
                key={d.date}
                onClick={() => {
                  setActiveDay(i);
                  setSwapping(null);
                }}
                className={`shrink-0 rounded-lg border px-4 py-2 text-left ${
                  i === activeDay
                    ? "border-amber-700 bg-amber-50"
                    : "border-stone-200 bg-white hover:border-stone-400"
                }`}
              >
                <div className="text-xs uppercase tracking-wide text-stone-500">
                  Day {i + 1} · {weekdayName(addDays(startDate, i)).slice(0, 3)}
                </div>
                <div className="text-sm font-medium text-stone-900">{d.theme}</div>
              </button>
            ))}
          </div>

          {day && (
            <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
              <div>
                <IssueList issues={day.issues} />
                <div className="mt-2 space-y-0">
                  {day.stops.map((s, i) => (
                    <div key={`${s.place.id}-${i}`}>
                      <TravelLine
                        minutes={s.travelBefore}
                        freeMinutes={i === 0 ? 0 : s.start - day.stops[i - 1].end - s.travelBefore}
                      />
                      <StopRow
                        index={i}
                        stop={s}
                        swapOpen={swapping === i}
                        alternatives={
                          swapping === i ? alternativesFor(plan, startDate, activeDay, i, s.place) : []
                        }
                        onToggleSwap={() => setSwapping(swapping === i ? null : i)}
                        onSwap={(alt) => {
                          const why = alt.matchedTags.length
                            ? `Your pick. Matches: ${alt.matchedTags.join(", ")}.`
                            : "Your pick.";
                          setPlan(replaceStop(plan, activeDay, i, alt.place.id, why));
                          setSwapping(null);
                        }}
                        onRemove={() => {
                          setPlan(removeStop(plan, activeDay, i));
                          setSwapping(null);
                        }}
                      />
                    </div>
                  ))}
                  {day.stops.length === 0 && (
                    <p className="text-sm text-stone-500">No stops left for this day.</p>
                  )}
                </div>

                <div className="mt-6 flex flex-wrap gap-2 rounded-lg border border-dashed border-stone-300 p-3">
                  <Input
                    value={dayInstruction}
                    onChange={(e) => setDayInstruction(e.target.value)}
                    placeholder={`Change day ${activeDay + 1}: e.g. "more relaxed" or "add a cooking class"`}
                    maxLength={300}
                    className="min-w-0 flex-1"
                  />
                  <Button variant="outline" onClick={regenerateDay} disabled={loading !== null}>
                    {loading === "day" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                    Regenerate day {activeDay + 1}
                  </Button>
                </div>
              </div>

              <div className="h-80 overflow-hidden rounded-xl border border-stone-200 lg:sticky lg:top-6 lg:h-[560px]">
                <DayMap stops={day.stops} />
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
