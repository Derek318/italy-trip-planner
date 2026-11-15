"use client";

import { Footprints, Repeat2, TrainFront, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMinutes } from "@/lib/places";
import type { Issue, ScheduledStop } from "@/lib/schedule";
import type { Alternative } from "@/lib/swap";

const TYPE_LABEL: Record<string, string> = {
  historic_site: "Historic site",
  restaurant: "Restaurant",
  museum: "Museum",
  cafe: "Café",
  viewpoint: "Viewpoint",
  experience: "Experience",
  neighborhood: "Neighborhood",
  market: "Market",
  park: "Park",
  shop: "Shop",
};

const ISSUE_STYLE: Record<Issue["severity"], string> = {
  error: "border-red-300 bg-red-50 text-red-800",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  info: "border-stone-200 bg-stone-50 text-stone-600",
};

export function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) {
    return null;
  }
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {issues.map((i, k) => (
        <li key={k} className={`rounded border px-2 py-0.5 text-xs ${ISSUE_STYLE[i.severity]}`}>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function duration(min: number) {
  const h = Math.floor(min / 60);
  return h ? `${h}h ${String(min % 60).padStart(2, "0")}m` : `${min} min`;
}

/** Travel time to this stop, plus any free time spent waiting for it to open. */
export function TravelLine({ minutes, freeMinutes }: { minutes: number; freeMinutes: number }) {
  if (!minutes && freeMinutes < 15) {
    return null;
  }
  const Icon = minutes > 25 ? TrainFront : Footprints;
  return (
    <div className="flex items-center gap-3 py-1 pl-[4.5rem] text-xs text-stone-500">
      {minutes > 0 && (
        <span className="flex items-center gap-1.5">
          <Icon className="size-3.5" /> ~{minutes} min
        </span>
      )}
      {freeMinutes >= 15 && <span className="text-emerald-700">Free time · {duration(freeMinutes)}</span>}
    </div>
  );
}

interface Props {
  index: number;
  stop: ScheduledStop;
  swapOpen: boolean;
  alternatives: Alternative[];
  onToggleSwap: () => void;
  onSwap: (alt: Alternative) => void;
  onRemove: () => void;
}

export function StopRow({ index, stop, swapOpen, alternatives, onToggleSwap, onSwap, onRemove }: Props) {
  const p = stop.place;
  return (
    <div className="flex gap-3">
      <div className="w-[3.75rem] shrink-0 pt-0.5 text-right text-sm tabular-nums text-stone-500">
        {formatMinutes(stop.start)}
        <div className="text-xs text-stone-400">{formatMinutes(stop.end)}</div>
      </div>
      <div className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium text-stone-900">
              <span className="mr-2 inline-flex size-5 items-center justify-center rounded-full bg-amber-700 text-xs text-white">
                {index + 1}
              </span>
              {p.name}
            </div>
            <div className="mt-0.5 text-xs text-stone-500">
              {[
                TYPE_LABEL[p.type] ?? p.type,
                p.neighborhood ?? p.city,
                p.priceRange,
                p.rating && `★ ${p.rating}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              variant={swapOpen ? "secondary" : "ghost"}
              size="sm"
              onClick={onToggleSwap}
              aria-label="Swap stop"
            >
              <Repeat2 className="size-4" /> Swap
            </Button>
            <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove stop">
              <X className="size-4" />
            </Button>
          </div>
        </div>
        {stop.why && <p className="mt-2 text-sm text-stone-700">{stop.why}</p>}
        <IssueList issues={stop.issues} />

        {swapOpen && (
          <div className="mt-3 border-t border-stone-100 pt-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">
              Alternatives that fit this slot
            </div>
            {alternatives.length === 0 ? (
              <p className="text-sm text-stone-500">Nothing else fits here without breaking the schedule.</p>
            ) : (
              <ul className="space-y-1.5">
                {alternatives.map((alt) => (
                  <li key={alt.place.id}>
                    <button
                      onClick={() => onSwap(alt)}
                      className="w-full rounded-md border border-stone-200 px-3 py-2 text-left hover:border-amber-600 hover:bg-amber-50"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-stone-900">{alt.place.name}</span>
                        <span className="shrink-0 text-xs tabular-nums text-stone-500">
                          {formatMinutes(alt.start)} · {alt.km.toFixed(1)} km away
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-stone-500">
                        {[
                          TYPE_LABEL[alt.place.type],
                          alt.place.priceRange,
                          alt.place.rating && `★ ${alt.place.rating}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        {alt.matchedTags.map((t) => (
                          <Badge key={t} variant="secondary" className="text-[10px]">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
