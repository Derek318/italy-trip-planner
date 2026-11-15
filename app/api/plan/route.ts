import Anthropic from "@anthropic-ai/sdk";
import { planTrip, replanDay } from "@/lib/planner";
import { PlanRequestSchema } from "@/lib/schemas";

export const maxDuration = 120;

export async function POST(req: Request) {
  const body = PlanRequestSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const input = body.data;
    const result =
      input.mode === "trip"
        ? await planTrip(input.request, input.startDate)
        : await replanDay(input.request, input.startDate, input.plan, input.dayIndex, input.instruction);
    return Response.json(result);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return Response.json({ error: "Busy right now, try again in a minute." }, { status: 429 });
    }
    console.error(err);
    const message =
      err instanceof Anthropic.APIError
        ? "The planner service had a problem."
        : String((err as Error).message);
    return Response.json({ error: message }, { status: 502 });
  }
}
