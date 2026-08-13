/**
 * The decision matrix, as one pure function. Reads the signals a quotation yields
 * and recommends a mode on two independent axes:
 *
 *   • multi-stop vs single  — driven by how many delivery addresses were found.
 *   • hubs vs dedicated van  — driven by whether the load fills a van. A part-load
 *                              (a small load rattling around an otherwise empty van)
 *                              is the classic reason to share a truck through hubs.
 *
 * It NEVER decides on its own — it recommends, records the reasons, and reports how
 * confident it is. The caller surfaces that and lets the operator override.
 *
 * No I/O, no HTTP, no UI: thresholds come in as `rules`, signals as `signals`.
 */
import type { Direction, ModeRecommendation, ModeRules, ModeSignals } from "./mode.types";

export function selectMode(signals: ModeSignals, rules: ModeRules): ModeRecommendation {
  const reasons: string[] = [];

  // ── Direction: delivery (pickup → drops) vs collection (pickups → depot) ──
  // Declared, not guessed — a bare address list is ambiguous. The count that drives
  // the multi-stop axis is the drops when delivering, the pickups when collecting.
  const direction: Direction = signals.direction ?? "deliver";
  const stopCount = direction === "collect" ? signals.pickupCount ?? 0 : signals.dropCount;

  // ── Axis 1: multi-stop vs single (same threshold both directions) ─────────
  const multiStop = stopCount >= rules.minDropsForMultiStop;
  if (direction === "collect") {
    if (multiStop) {
      reasons.push(
        `${stopCount} pickup addresses were read — routing this as a collection round into one depot.`,
      );
    } else if (stopCount === 1) {
      reasons.push("One pickup address — a single collection.");
    }
  } else {
    if (multiStop) {
      reasons.push(
        `${stopCount} delivery addresses were read from the quotation — routing this as a multi-stop run.`,
      );
    } else if (stopCount === 1) {
      reasons.push("One delivery address in the quotation — a single drop.");
    }
  }

  // ── Axis 2: hubs (shared truck) vs dedicated van ──────────────────────────
  // Only judgeable once the load plan exists — before that the fill is unknown.
  const havePlan = signals.vanFillFraction !== null && signals.packableUnits > 0;
  const fill = signals.vanFillFraction ?? 0;
  const partLoad =
    havePlan &&
    signals.fitsInSingleVan &&
    signals.unplacedCount === 0 &&
    fill < rules.partLoadFillThreshold;

  // NOTE (endorsed pattern): the operator singled this groupage nudge out as exactly
  // the kind of suggestion to keep making — a recommendation grounded in a logical,
  // measurable requirement (here: low van fill ⇒ sharing a truck is genuinely cheaper),
  // stated with the reason, never auto-applied. Model future suggestions on this shape:
  // real signal → plain-language "why" → operator still decides.
  const loadSharing: ModeRecommendation["loadSharing"] = partLoad ? "shared" : "dedicated";
  if (partLoad) {
    reasons.push(
      `The load fills only about ${Math.round(fill * 100)}% of a van — sharing space on a pooled ` +
        `truck is usually cheaper than a dedicated van for a part-load like this.`,
    );
  } else if (havePlan && signals.fitsInSingleVan) {
    reasons.push(
      `The load fills about ${Math.round(fill * 100)}% of a van — a dedicated van is efficient here.`,
    );
  } else if (havePlan && !signals.fitsInSingleVan) {
    reasons.push("The load needs more than one van — a dedicated fleet run, not a shared truck.");
  }

  // Routing (hub vs direct) is an independent axis: no signal currently forces a hub cross-dock,
  // so the recommendation is always "direct" and the operator opts into a hub per quote.
  const routing: ModeRecommendation["routing"] = "direct";

  const confidence: ModeRecommendation["confidence"] = havePlan ? "high" : "low";
  if (!havePlan) {
    reasons.push("Waiting on the load plan before judging shared-truck vs dedicated van.");
  }

  return { loadSharing, routing, hubs: loadSharing === "shared", multiStop, direction, reasons, confidence };
}
