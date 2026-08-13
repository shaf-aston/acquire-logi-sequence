"use client";

import { useEffect, useMemo, useState } from "react";
import { color, font, radius, sectionLabel, spacing } from "@/styles/tokens";
import { PlacesInput, type PlaceSuggestion } from "@/components/PlacesInput";
import { ErrorBanner } from "@/components/common/ErrorBanner";
import { GroupageRouteMap } from "@/components/groupage/GroupageRouteMap";
import { RouteMap, type RoutePoint } from "@/components/maps/RouteMap";
import { publicEnv } from "@/config/public-env";
import { hubCentroid } from "@/lib/geo/area-centroids";
import { GroupageJourneyStrip } from "@/components/groupage/GroupageJourneyStrip";
import { GroupagePalletBuilder } from "@/components/groupage/GroupagePalletBuilder";
import { TruckStackPlanner } from "@/components/groupage/TruckStackPlanner";
import { StepSection } from "@/components/groupage/StepSection";
import { TrunkStopsEditor } from "@/components/groupage/TrunkStopsEditor";
import { labelWrap, labelText, inputStyle, baseBtn, secondaryBtn } from "@/components/groupage/field-styles";
import { resolveHubOrNull } from "@/lib/groupage/hub-resolver";
import { PalletTallyBar } from "@/components/groupage/PalletTallyBar";
import { FOOTPRINT_META_LIST } from "@/lib/groupage/footprint-meta";
import { SendQuoteButton } from "@/components/results/SendQuoteButton";
import type { GroupagePallet, GroupageQuote, Hub, PalletFootprintClass } from "@/lib/groupage/groupage.types";
import type { PackedItem, SessionHub, UnplacedItem } from "@/types/api";
import type { StructuredDocument } from "@/lib/conversion/types";
import {
  readPanelSnapshot,
  writePanelSnapshot,
  PANEL_SNAPSHOT_KEYS,
} from "@/lib/session-cache/panel-snapshots";

interface PalletLine {
  footprint: PalletFootprintClass;
  weightKg: string;
  quantity: string;
  /** Hub id this line joins the trunk at. "" ⇒ the origin hub (rides from the start). */
  joinAtHubId?: string;
  /** Hub id this line leaves the trunk at. "" ⇒ the destination hub (rides all the way). */
  leaveAtHubId?: string;
}

const emptyLine = (): PalletLine => ({ footprint: "full", weightKg: "", quantity: "1" });

function parsePallets(lines: PalletLine[]): GroupagePallet[] {
  return lines.map((l) => ({
    footprint: l.footprint,
    weightKg: Number(l.weightKg),
    quantity: Number(l.quantity),
    // Omit the key when the line rides the default end-to-end — never send "" or null.
    ...(l.joinAtHubId ? { joinAtHubId: l.joinAtHubId } : {}),
    ...(l.leaveAtHubId ? { leaveAtHubId: l.leaveAtHubId } : {}),
  }));
}

/** Wire shape the quote/pack/book routes accept for `sessionHubs` — exactly these 4 fields. */
function toWireHub(h: SessionHub): { id: string; name: string; catchment: string[]; address?: string } {
  return { id: h.id, name: h.name, catchment: h.catchment, ...(h.address ? { address: h.address } : {}) };
}

/**
 * What the shared-truck hand-off had to discard when the operator switched to groupage
 * from a multi-drop / multi-van quotation. Shared truck is single-origin → single-
 * destination, so a job with several drops (or one too big for one truck) can't be
 * represented faithfully — this drives a heads-up banner so the loss is never silent.
 */
export interface GroupageHandoff {
  /** Delivery addresses the source quotation carried (before the collapse to one). */
  readonly dropCount: number;
  /** The single destination postcode that survived (null if none was parseable). */
  readonly keptDestinationPostcode: string | null;
  /** Vans the full load needs, from packing — >1 means one shared truck can't hold it. */
  readonly fleetVanCount: number;
  /** What the decision matrix actually recommended for this job (null if none). */
  readonly recommendedModeLabel: string | null;
  /** The plain-language "why" behind that recommendation (first line shown). */
  readonly reasons: readonly string[];
}

/** What we remember about a shared-truck quote so switching modes and returning shows it instantly,
 *  without re-pricing. Held in memory for the session only (see panel-snapshots). */
interface GroupageSnapshot {
  originPostcode: string;
  destinationPostcode: string;
  originValid: boolean;
  destinationValid: boolean;
  originNoPostcode: boolean;
  destinationNoPostcode: boolean;
  eta: string;
  customerName: string;
  routing: "direct" | "via-hub";
  lines: PalletLine[];
  quote: GroupageQuote | null;
  /** Ordered intermediate trunk stops (hub ids) — [] ⇒ a straight point-to-point trunk. */
  trunkStopHubIds: string[];
}

export function GroupagePanel({
  prefill,
  handoff,
  unplaced = [],
  items = [],
  palletMaxHeightM,
  embedded = false,
  uploadedDocument,
  onOpenHubs,
  onBooked,
}: {
  /** Postcodes carried over from the planner's detected/typed addresses — applied only
   *  to fields the operator hasn't filled yet (never overwrite a typed value). */
  prefill?: { originPostcode?: string; destinationPostcode?: string; fromCollectionHub?: boolean };
  /** Context the shared-truck hand-off dropped (multi-drop / multi-van) — drives a
   *  dismissible heads-up banner. Null/undefined when nothing was dropped. */
  handoff?: GroupageHandoff | null;
  /** Items from the read order that the main-van pack could NOT place. Only these may be
   *  palletised here (the pallet builder's tray, M4) — never items already on a van. */
  unplaced?: UnplacedItem[];
  /** The full packed-item set, for dimension lookup by id (an unplaced item carries no
   *  dimensions of its own). Keyed into `itemById` below. */
  items?: PackedItem[];
  /** Cap for the 3D pallet builder's stack height (m) — the interior height of the vehicle
   *  that will carry the pallets. Undefined ⇒ the builder falls back to the pallet's own
   *  usable height. */
  palletMaxHeightM?: number;
  /** True when hosted inside another card (Route & Price) — drops the panel's own
   *  card chrome and header so the host's heading does the talking. */
  embedded?: boolean;
  /** The manifest already ingested at the start of the quote flow, if any. Lets the
   *  shared-truck planner's fast path read a company roster off it WITHOUT re-uploading
   *  or re-OCR'ing. Null when nothing was ingested (a from-scratch groupage quote). */
  uploadedDocument?: StructuredDocument | null;
  /** When set, a failed quote offers a jump straight to the depot/hub setup card. An optional prefill
   *  seeds the Add-hub form (e.g. the uncovered catchment area) so a gap is fixable in one click. */
  onOpenHubs?: (prefill?: { catchment?: string[]; address?: string }) => void;
  /** Fired after a successful booking so the host can refresh its shipments view. */
  onBooked?: () => void;
} = {}) {
  const gSnap0 = readPanelSnapshot<GroupageSnapshot>(PANEL_SNAPSHOT_KEYS.groupage);

  const [originPostcode, setOriginPostcode] = useState(() => gSnap0?.originPostcode ?? "");
  const [destinationPostcode, setDestinationPostcode] = useState(() => gSnap0?.destinationPostcode ?? "");
  // True once the operator picks a suggestion (confirmed spelling) — drives the green ✓.
  const [originValid, setOriginValid] = useState(() => gSnap0?.originValid ?? false);
  const [destinationValid, setDestinationValid] = useState(() => gSnap0?.destinationValid ?? false);
  // Set when a picked suggestion has no postcode — the field stays invalid and this
  // guidance shows instead of the green ✓ (never silently accept an unresolvable place).
  const [originNoPostcode, setOriginNoPostcode] = useState(() => gSnap0?.originNoPostcode ?? false);
  const [destinationNoPostcode, setDestinationNoPostcode] = useState(() => gSnap0?.destinationNoPostcode ?? false);
  const [eta, setEta] = useState(() => gSnap0?.eta ?? "");
  // Optional company/customer label. Captured here so a priced quote is remembered against a
  // name and can later be picked from "recent quotes" in the shared-truck planner.
  const [customerName, setCustomerName] = useState(() => gSnap0?.customerName ?? "");
  // Routing choice: via our hubs (cross-dock, needs catchment coverage) vs direct (hubless, another carrier,
  // quotable for any postcode). Default via-hub preserves the prior behaviour.
  const [routing, setRouting] = useState<"direct" | "via-hub">(() => gSnap0?.routing ?? "via-hub");
  const [lines, setLines] = useState<PalletLine[]>(() => gSnap0?.lines ?? [emptyLine()]);
  // Ordered hubs the trunk calls at on the way ("train stops"). [] ⇒ today's straight trunk.
  const [trunkStopHubIds, setTrunkStopHubIds] = useState<string[]>(() => gSnap0?.trunkStopHubIds ?? []);
  // The saved hub network, for the stop picker's options. Fetched once; a failure just leaves the
  // picker offering only this manifest's session hubs — it never blocks quoting.
  const [savedHubs, setSavedHubs] = useState<Hub[]>([]);
  // Load state of the fetch above — the stop picker's "Add a stop" reads this to show a visible
  // "Loading hubs…" / error message instead of a silently-disabled button.
  const [hubsState, setHubsState] = useState<"loading" | "ready" | "error">("loading");
  // Set whenever removing/pruning a trunk stop resets a pallet line's join/leave choice, or
  // changing one of those choices invalidates the other — never let that price-moving change
  // happen silently. Dismissible; cleared on the next stop change.
  const [stopResetNotice, setStopResetNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<GroupageQuote | null>(() => gSnap0?.quote ?? null);
  // The hand quote form sits collapsed at the bottom (secondary path). Controlled so folding a
  // built pallet in from Step 1 can auto-open it — otherwise its "added ✓" note would point at a
  // closed section. Still user-toggleable via onToggle below.
  const [handFormOpen, setHandFormOpen] = useState(false);
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [bookedId, setBookedId] = useState<string | null>(null);
  // The server-confirmed booked total — compared against the on-screen quote so a
  // price that moved between quoting and booking is surfaced, never silent.
  const [bookedTotal, setBookedTotal] = useState<{ total: number; currencySymbol: string } | null>(null);
  // The hand-off warning is dismissible and per-switch — reset when a new hand-off arrives.
  const [handoffDismissed, setHandoffDismissed] = useState(false);
  // Hubs read off the uploaded manifest for THIS session (see manifest-hub-reader) — layered over
  // the saved network on every quote/pack/book request below. A "never-guess" surface: shown, not
  // silently trusted, and the operator can drop one before it's sent.
  const [sessionHubs, setSessionHubs] = useState<SessionHub[]>(
    () => readPanelSnapshot<SessionHub[]>(PANEL_SNAPSHOT_KEYS.manifestHubs) ?? [],
  );
  const removeSessionHub = (id: string) => {
    setSessionHubs((prev) => {
      const next = prev.filter((h) => h.id !== id);
      writePanelSnapshot(PANEL_SNAPSHOT_KEYS.manifestHubs, next);
      return next;
    });
  };

  // Per-session-hub save feedback, keyed by hub id (several hubs can be on screen at once).
  // `conflict` is set only for a disjoint-catchment clash — it powers the "take the area over" retry
  // button below instead of leaving the operator stuck on a raw error.
  const [hubSaveState, setHubSaveState] = useState<
    Record<string, { status: "saving" | "error" | "resolving"; message?: string; conflict?: { area: string; owner: string } }>
  >({});
  // Confirmation after a session hub is promoted to the permanent network — it leaves the list on
  // success, so without this note it looks like the hub vanished ("can't see the added").
  const [savedHubNote, setSavedHubNote] = useState<string | null>(null);

  // Promote a hub the manifest named for itself into the SAVED network — the manifest reader already
  // captured its name, address, and derived its catchment from the postcode, so there's nothing to
  // retype. On success it becomes permanent and drops out of the session list; a disjoint-catchment
  // clash (its area already belongs to another hub) is surfaced plainly, never swallowed.
  const saveSessionHubToNetwork = async (h: SessionHub) => {
    setHubSaveState((s) => ({ ...s, [h.id]: { status: "saving" } }));
    try {
      const res = await fetch("/api/hubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: h.id, name: h.name, catchment: h.catchment, ...(h.address ? { address: h.address } : {}) }),
      });
      const data = (await res.json()) as { success: boolean; error?: string; conflict?: { area: string; owner: string } };
      if (data.success) {
        setHubSaveState((s) => { const { [h.id]: _drop, ...rest } = s; return rest; });
        removeSessionHub(h.id); // now permanent — no longer a session-only overlay
        setSavedHubNote(`Saved ${h.name} to your hub network — find it under Depots & hubs.`);
      } else {
        setHubSaveState((s) => ({
          ...s,
          [h.id]: { status: "error", message: data.error ?? "Couldn't save this hub.", conflict: data.conflict },
        }));
      }
    } catch (err) {
      setHubSaveState((s) => ({ ...s, [h.id]: { status: "error", message: err instanceof Error ? err.message : "Couldn't save this hub." } }));
    }
  };

  // A save failed because this hub's area is already claimed by an existing network hub. Rather than
  // leaving the operator stuck (they'd otherwise have to go edit that other hub manually on the Hubs
  // screen), strip the contested area from the existing owner — same "reassign one area" move as the
  // dot-map editor in HubConfigPanel — then retry the original save. Explicit click, never silent.
  const takeOverAreaAndRetry = async (h: SessionHub, conflict: { area: string; owner: string }) => {
    setHubSaveState((s) => ({ ...s, [h.id]: { status: "resolving" } }));
    try {
      const listRes = await fetch("/api/hubs");
      const listData = (await listRes.json()) as { hubs?: Hub[]; error?: string };
      const owner = listData.hubs?.find((o) => o.id === conflict.owner);
      if (!owner) {
        setHubSaveState((s) => ({
          ...s,
          [h.id]: { status: "error", message: `Couldn't find "${conflict.owner}" to free up ${conflict.area}.` },
        }));
        return;
      }
      const releaseRes = await fetch("/api/hubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: owner.id,
          name: owner.name,
          catchment: owner.catchment.filter((a) => a !== conflict.area),
          ...(owner.address ? { address: owner.address } : {}),
        }),
      });
      const releaseData = (await releaseRes.json()) as { success: boolean; error?: string };
      if (!releaseData.success) {
        setHubSaveState((s) => ({
          ...s,
          [h.id]: { status: "error", message: releaseData.error ?? `Couldn't free up ${conflict.area} from ${owner.name}.` },
        }));
        return;
      }
      await saveSessionHubToNetwork(h);
    } catch (err) {
      setHubSaveState((s) => ({
        ...s,
        [h.id]: { status: "error", message: err instanceof Error ? err.message : "Couldn't resolve the catchment conflict." },
      }));
    }
  };

  // Apply carried-over postcodes to still-empty fields only.
  useEffect(() => {
    if (prefill?.originPostcode) setOriginPostcode((cur) => (cur === "" ? prefill.originPostcode! : cur));
    if (prefill?.destinationPostcode)
      setDestinationPostcode((cur) => (cur === "" ? prefill.destinationPostcode! : cur));
  }, [prefill?.originPostcode, prefill?.destinationPostcode]);

  // A fresh hand-off (operator re-entered groupage from a different quotation) un-dismisses.
  useEffect(() => setHandoffDismissed(false), [handoff]);

  // Remember the shared-truck inputs + priced quote for the session, so switching modes and coming
  // back shows the quote instantly instead of re-pricing. A hub-to-hub hand-off clears this first
  // (page.tsx) so its fresh origin isn't blocked by a remembered one.
  useEffect(() => {
    writePanelSnapshot<GroupageSnapshot>(PANEL_SNAPSHOT_KEYS.groupage, {
      originPostcode,
      destinationPostcode,
      originValid,
      destinationValid,
      originNoPostcode,
      destinationNoPostcode,
      eta,
      customerName,
      routing,
      lines,
      quote,
      trunkStopHubIds,
    });
  }, [
    originPostcode,
    destinationPostcode,
    originValid,
    destinationValid,
    originNoPostcode,
    destinationNoPostcode,
    eta,
    customerName,
    routing,
    lines,
    quote,
    trunkStopHubIds,
  ]);

  // Hub network for the stop picker. Fail-soft for QUOTING (no hubs ⇒ no stops offered), but the
  // load state is still surfaced to the picker so a failure/in-flight fetch never looks like a
  // plain disabled button with no explanation.
  useEffect(() => {
    let cancelled = false;
    setHubsState("loading");
    void (async () => {
      try {
        const res = await fetch("/api/hubs");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { hubs?: Hub[] };
        if (cancelled) return;
        setSavedHubs(Array.isArray(data.hubs) ? data.hubs : []);
        setHubsState("ready");
      } catch {
        // Leave savedHubs empty — the picker falls back to this manifest's session hubs, but
        // says so rather than staying silently disabled.
        if (!cancelled) setHubsState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Everything routable: the saved network plus any hub lifted off this manifest. Session hubs win
   *  on id, since those are the ones this quote actually carries to the server. */
  const stoppableHubs = useMemo<Hub[]>(() => {
    const byId = new Map<string, Hub>(savedHubs.map((h) => [h.id, h]));
    for (const s of sessionHubs) byId.set(s.id, { id: s.id, name: s.name, catchment: s.catchment });
    return [...byId.values()];
  }, [savedHubs, sessionHubs]);

  /** The two end hubs, resolved from the typed postcodes — never offerable as an intermediate stop.
   *  Best-effort: a half-typed or uncovered postcode simply yields no end hub yet, and the server's
   *  own guard still catches a stop that turns out to be an end. */
  const originDestHubIds = useMemo<string[]>(() => {
    const idFor = (postcode: string): string | null => {
      if (postcode.trim() === "") return null;
      try {
        return resolveHubOrNull(postcode, stoppableHubs)?.id ?? null;
      } catch {
        return null; // not postcode-shaped yet
      }
    };
    return [idFor(originPostcode), idFor(destinationPostcode)].filter((id): id is string => id !== null);
  }, [originPostcode, destinationPostcode, stoppableHubs]);

  const hubNameOf = (id: string) => stoppableHubs.find((h) => h.id === id)?.name ?? id;
  /** Per-line join/leave pickers only make sense once the trunk actually calls somewhere. */
  const showStopRefs = routing === "via-hub" && trunkStopHubIds.length > 0;

  /** Stops are only meaningful on a via-hub trunk, and only stops actually on the route may be
   *  named by a pallet line. Dropping a stop must therefore reset any line pointing at it — the
   *  server would reject the stale ref, and the operator never asked for that error. Resetting
   *  means those lines now ride MORE of the trunk (price goes up), so it's counted and surfaced
   *  via `stopResetNotice` rather than done silently. */
  const applyStops = (next: string[]) => {
    const removedNames = trunkStopHubIds.filter((id) => !next.includes(id)).map(hubNameOf);
    setTrunkStopHubIds(next);

    let resetCount = 0;
    const updatedLines = lines.map((l) => {
      const joinOk = !l.joinAtHubId || next.includes(l.joinAtHubId);
      const leaveOk = !l.leaveAtHubId || next.includes(l.leaveAtHubId);
      if (joinOk && leaveOk) return l;
      resetCount += 1;
      return { ...l, joinAtHubId: joinOk ? l.joinAtHubId : "", leaveAtHubId: leaveOk ? l.leaveAtHubId : "" };
    });
    setLines(updatedLines);

    // A later edit that resets nothing must NOT clear a warning an earlier edit raised: remove two
    // stops in a row and the second (harmless) removal would erase the price warning from the first,
    // leaving the operator with silently re-priced lines. Only an explicit dismiss, or a fresh
    // quote, clears it.
    if (resetCount === 0) return;
    const line = resetCount === 1 ? "pallet line" : "pallet lines";
    const verb = resetCount === 1 ? "it now rides" : "they now ride";
    const where = removedNames.length > 0 ? ` at ${removedNames.join(", ")}` : "";
    setStopResetNotice(`${resetCount} ${line} joined/left${where} — ${verb} more of the trunk than before. Check the price.`);
  };

  // A stop that becomes an end hub (origin/destination catchment now covers it) can no longer be
  // an intermediate stop — prune it the same way a manual removal would, so the server never sees
  // a stale stop-as-end reference.
  useEffect(() => {
    const pruned = trunkStopHubIds.filter((id) => !originDestHubIds.includes(id));
    if (pruned.length === trunkStopHubIds.length) return;
    // The operator didn't remove these — a postcode edit did, by pulling the hub onto an end of the
    // trunk. The row simply disappearing would be a silent edit to their route; say what happened.
    const dropped = trunkStopHubIds.filter((id) => originDestHubIds.includes(id)).map(hubNameOf);
    applyStops(pruned);
    setStopResetNotice(
      `${dropped.join(", ")} ${dropped.length === 1 ? "is now an end of this route, so it is no longer a stop" : "are now ends of this route, so they are no longer stops"} — the truck already calls there. Check the price.`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originDestHubIds]);

  /** Station position along the trunk: 0 = origin, k+1 = trunkStopHubIds[k], length+1 = destination. */
  const joinPos = (l: PalletLine) => (l.joinAtHubId ? trunkStopHubIds.indexOf(l.joinAtHubId) + 1 : 0);
  const leavePos = (l: PalletLine) => (l.leaveAtHubId ? trunkStopHubIds.indexOf(l.leaveAtHubId) + 1 : trunkStopHubIds.length + 1);
  /** Stations this line may join at: stops strictly before its current leave station (Origin is
   *  always offered separately). */
  const joinOptionsFor = (l: PalletLine) => trunkStopHubIds.filter((_, k) => k + 1 < leavePos(l));
  /** Stations this line may leave at: stops strictly after its current join station (Destination is
   *  always offered separately). */
  const leaveOptionsFor = (l: PalletLine) => trunkStopHubIds.filter((_, k) => k + 1 > joinPos(l));

  /** A bad body (joins after it leaves) must be unreachable from the UI — so picking a "Joins at"
   *  that would land on/after the current "Leaves at" resets the leave choice back to default, and
   *  says so rather than silently widening the ride. */
  const setLineJoinAt = (i: number, hubId: string) => {
    let cleared = false;
    setLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== i) return l;
        const newJoinPos = hubId ? trunkStopHubIds.indexOf(hubId) + 1 : 0;
        const stillValid = !l.leaveAtHubId || leavePos(l) > newJoinPos;
        if (!stillValid) cleared = true;
        return { ...l, joinAtHubId: hubId, leaveAtHubId: stillValid ? l.leaveAtHubId : "" };
      }),
    );
    if (cleared) {
      setStopResetNotice("Changing where a pallet line joins reset where it leaves — it now rides to the destination. Check the price.");
    }
  };

  /** Mirror of `setLineJoinAt` for the "Leaves at" picker. */
  const setLineLeaveAt = (i: number, hubId: string) => {
    let cleared = false;
    setLines((prev) =>
      prev.map((l, idx) => {
        if (idx !== i) return l;
        const newLeavePos = hubId ? trunkStopHubIds.indexOf(hubId) + 1 : trunkStopHubIds.length + 1;
        const stillValid = !l.joinAtHubId || joinPos(l) < newLeavePos;
        if (!stillValid) cleared = true;
        return { ...l, leaveAtHubId: hubId, joinAtHubId: stillValid ? l.joinAtHubId : "" };
      }),
    );
    if (cleared) {
      setStopResetNotice("Changing where a pallet line leaves reset where it joins — it now rides from the origin. Check the price.");
    }
  };

  // Switching to a hubless direct move removes the trunk entirely — so its stops go with it.
  useEffect(() => {
    if (routing !== "via-hub" && trunkStopHubIds.length > 0) applyStops([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routing]);

  // A picked suggestion with no postcode can't be resolved to a hub server-side, so it
  // stays invalid (no green ✓) and shows guidance instead of silently storing the label.
  const handleOriginSelect = (s: PlaceSuggestion) => {
    if (s.postcode == null) {
      setOriginPostcode(s.label);
      setOriginValid(false);
      setOriginNoPostcode(true);
      return;
    }
    setOriginPostcode(s.postcode);
    setOriginValid(true);
    setOriginNoPostcode(false);
  };
  const handleDestinationSelect = (s: PlaceSuggestion) => {
    if (s.postcode == null) {
      setDestinationPostcode(s.label);
      setDestinationValid(false);
      setDestinationNoPostcode(true);
      return;
    }
    setDestinationPostcode(s.postcode);
    setDestinationValid(true);
    setDestinationNoPostcode(false);
  };

  const updateLine = (index: number, patch: Partial<PalletLine>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const addLine = () => setLines((prev) => [...prev, emptyLine()]);
  const removeLine = (index: number) =>
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));

  const submit = async () => {
    setError(null);
    setQuote(null);
    // The warning says "check the price" — a fresh quote IS that check, so it has served its purpose.
    setStopResetNotice(null);
    setLoading(true);
    try {
      const res = await fetch("/api/groupage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originPostcode,
          destinationPostcode,
          pallets: parsePallets(lines),
          routing,
          trunkStopHubIds,
          eta: eta.trim() === "" ? null : eta.trim(),
          customerName: customerName.trim() === "" ? undefined : customerName.trim(),
          sessionHubs: sessionHubs.map(toWireHub),
        }),
      });
      const data = (await res.json()) as
        | { success: true; quote: GroupageQuote }
        | { success: false; check?: string; error: string };
      if (data.success) {
        setQuote(data.quote);
      } else {
        setError(data.error);
      }
    } catch (fetchErr) {
      setError(fetchErr instanceof Error ? fetchErr.message : "Failed to get groupage quote.");
    } finally {
      setLoading(false);
    }
  };

  const book = async () => {
    if (!quote) return;
    setBookError(null);
    setBookedId(null);
    setBookedTotal(null);
    setBooking(true);
    try {
      const res = await fetch("/api/shipments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originPostcode,
          destinationPostcode,
          pallets: parsePallets(lines),
          routing,
          trunkStopHubIds,
          eta: eta.trim() === "" ? null : eta.trim(),
          // The server re-quotes anyway (anti-tamper) — this only lets it detect drift and
          // stop BEFORE saving, instead of silently booking whatever it just recomputed.
          expectedTotal: quote.total,
          sessionHubs: sessionHubs.map(toWireHub),
        }),
      });
      const data = (await res.json()) as
        | { success: true; shipment: { id: string; total: number; currencySymbol: string } }
        | { success: false; priceChanged?: boolean; quote?: GroupageQuote; error: string };
      if (data.success) {
        setBookedId(data.shipment.id);
        setBookedTotal({ total: data.shipment.total, currencySymbol: data.shipment.currencySymbol });
        onBooked?.();
      } else {
        // Price drift: the server refused to save and handed back the fresh quote — show it
        // on screen so a second, explicit click books at the new (now-matching) price.
        if (data.priceChanged && data.quote) setQuote(data.quote);
        setBookError(data.error);
      }
    } catch (fetchErr) {
      setBookError(fetchErr instanceof Error ? fetchErr.message : "Failed to book shipment.");
    } finally {
      setBooking(false);
    }
  };

  // Booking re-prices server-side (anti-tamper), so if rates or hubs changed since the
  // on-screen quote the saved price can differ — that drift must be visible, never silent.
  const priceMoved =
    bookedTotal != null && quote != null && Math.abs(bookedTotal.total - quote.total) >= 0.005;

  // Dimension lookup for unplaced items (they carry no size of their own). Only items with
  // a known size can be stacked, so the summary/tray must be honest about how many qualify.
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const palletableUnplaced = useMemo(
    () => unplaced.filter((u) => itemById.get(u.id)?.dimensions != null),
    [unplaced, itemById],
  );

  // Fold a built pallet (from the 3D builder) into the quote as a pallet line. Replaces the
  // untouched default blank line on first use, then appends — opt-in, so the operator keeps
  // control of the demand and the price only moves when they ask.
  const useBuiltPallet = (p: { footprint: PalletFootprintClass; weightKg: number; quantity: number }) => {
    setLines((prev) => {
      const line: PalletLine = { footprint: p.footprint, weightKg: String(p.weightKg), quantity: String(p.quantity) };
      const onlyBlankDefault = prev.length === 1 && prev[0]!.weightKg.trim() === "";
      return onlyBlankDefault ? [line] : [...prev, line];
    });
    // Reveal the (collapsed) hand form so the newly-added pallet line — and its "added ✓" note — are visible.
    setHandFormOpen(true);
  };

  // Seed for the shared-truck planner — the current form's route + valid pallet lines, so the
  // operator can drop THIS quote straight into a multi-company shared-truck plan.
  const sharedTruckSeed = useMemo(
    () => ({
      company: customerName.trim() || undefined,
      originPostcode: originPostcode.trim() || undefined,
      destinationPostcode: destinationPostcode.trim() || undefined,
      pallets: parsePallets(lines).filter((p) => Number.isFinite(p.weightKg) && p.weightKg > 0 && p.quantity > 0),
    }),
    [customerName, originPostcode, destinationPostcode, lines],
  );

  return (
    <div
      style={
        embedded
          ? { display: "flex", flexDirection: "column", gap: spacing.md }
          : {
              background: color.surface,
              border: `1px solid ${color.border}`,
              borderRadius: radius.card,
              padding: spacing.lg,
              display: "flex",
              flexDirection: "column",
              gap: spacing.md,
            }
      }
    >
      {!embedded && (
        <div>
          <p style={sectionLabel}>Shared truck · groupage</p>
          <h3 style={{ margin: 0, fontSize: font.md, color: color.text, fontWeight: 700, letterSpacing: "-0.01em" }}>
            Groupage quote
          </h3>
          <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
            Consolidated pallet freight across the hub network, priced per pallet-space.
          </p>
        </div>
      )}

      {/* Plain-language segmentation — the recurring "is shared truck restacking my van?" confusion.
          It is a PRICE (+ optional 3D of the pooled truck), not a change to your own van's packing. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          padding: `${spacing.sm}px ${spacing.md}px`,
          background: color.surfaceSub,
          border: `1px solid ${color.border}`,
          borderRadius: radius.input,
        }}
      >
        <span style={{ fontSize: font.sm, fontWeight: 600, color: color.text }}>What “shared truck” does</span>
        <span style={{ fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          Prices pooled <strong>hub-to-hub</strong> freight per pallet-space. It does <strong>not</strong> change
          how your own van is packed.
        </span>
      </div>

      {/* Session hubs read off the uploaded manifest — a "never-guess" surface: shown, editable,
          never silently trusted. Sent as `sessionHubs` on every quote/pack/book request below. */}
      {sessionHubs.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: spacing.xs,
            padding: `${spacing.sm}px ${spacing.md}px`,
            background: color.surfaceSub,
            border: `1px solid ${color.border}`,
            borderRadius: radius.input,
          }}
        >
          <span style={{ fontSize: font.sm, fontWeight: 600, color: color.text }}>
            Using {sessionHubs.length} {sessionHubs.length === 1 ? "hub" : "hubs"} from this manifest
          </span>
          <span style={{ fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
            From the uploaded document — used for this session only, not saved to your hub network.
          </span>
          {sessionHubs.map((h) => (
            <div
              key={h.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: spacing.sm,
                fontSize: font.xs,
                color: color.text,
                lineHeight: 1.5,
                paddingTop: spacing.xs,
                borderTop: `1px solid ${color.border}`,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span>
                  <strong>{h.name}</strong> — {h.role ?? "hub"} · catchment {h.catchment.join(", ")}
                </span>
                {h.address && <span style={{ color: color.muted }}>{h.address}</span>}
                {h.warning && (
                  <span
                    style={{
                      color: color.review.fg,
                      background: color.review.bg,
                      border: `1px solid ${color.review.border}`,
                      borderRadius: radius.input,
                      padding: `2px ${spacing.xs}px`,
                      width: "fit-content",
                    }}
                  >
                    {h.warning}
                  </span>
                )}
                {hubSaveState[h.id]?.status === "error" && (
                  <span style={{ color: color.error }}>{hubSaveState[h.id]!.message}</span>
                )}
                {hubSaveState[h.id]?.conflict && (
                  <button
                    type="button"
                    onClick={() => takeOverAreaAndRetry(h, hubSaveState[h.id]!.conflict!)}
                    style={{
                      alignSelf: "flex-start",
                      border: "none",
                      background: "none",
                      padding: 0,
                      color: color.error,
                      fontSize: font.xs,
                      fontWeight: 700,
                      textDecoration: "underline",
                      cursor: "pointer",
                    }}
                  >
                    Take over {hubSaveState[h.id]!.conflict!.area} from {hubSaveState[h.id]!.conflict!.owner} and save
                  </button>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => saveSessionHubToNetwork(h)}
                  disabled={hubSaveState[h.id]?.status === "saving" || hubSaveState[h.id]?.status === "resolving"}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: hubSaveState[h.id]?.status === "saving" ? "not-allowed" : "pointer",
                    color: color.accentDark,
                    fontSize: font.xs,
                    fontWeight: 600,
                    padding: 0,
                    textDecoration: "underline",
                  }}
                >
                  {hubSaveState[h.id]?.status === "saving"
                    ? "Saving…"
                    : hubSaveState[h.id]?.status === "resolving"
                      ? "Resolving…"
                      : "Save to hub network"}
                </button>
                <button
                  type="button"
                  onClick={() => removeSessionHub(h.id)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: color.muted, fontSize: font.xs, padding: 0 }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {savedHubNote && (
        <p
          role="status"
          style={{
            margin: 0,
            fontSize: font.xs,
            color: color.success,
            background: color.surfaceSub,
            border: `1px solid ${color.border}`,
            borderRadius: radius.input,
            padding: `${spacing.sm}px ${spacing.md}px`,
          }}
        >
          {savedHubNote}
        </p>
      )}

      {/* Breadcrumb: arrived here from a collection run's "Send hub-to-hub" — say why the origin is
          pre-filled and what's left to do, so the jump between screens isn't disorienting. */}
      {prefill?.fromCollectionHub && (
        <div
          role="status"
          style={{
            fontSize: font.xs,
            color: color.text,
            lineHeight: 1.5,
            background: color.surfaceSub,
            border: `1px solid ${color.border}`,
            borderRadius: radius.input,
            padding: `${spacing.sm}px ${spacing.md}px`,
          }}
        >
          Continuing your collection run — origin set to{" "}
          <strong>{prefill.originPostcode ?? "the collection hub"}</strong>. Pick the destination hub to price
          the hub-to-hub leg.
        </div>
      )}

      {/* Hand-off heads-up: shared truck can't represent a multi-drop / multi-van job, so
          say plainly what was dropped instead of quoting a disconnected one-pallet load. */}
      {handoff && !handoffDismissed && (
        <div
          role="status"
          style={{
            display: "flex",
            gap: spacing.sm,
            alignItems: "flex-start",
            justifyContent: "space-between",
            background: color.review.bg,
            border: `1px solid ${color.review.border}`,
            borderRadius: radius.input,
            padding: `${spacing.sm}px ${spacing.md}px`,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: font.xs, color: color.review.fg, lineHeight: 1.5 }}>
            <span style={{ fontWeight: 700, fontSize: font.sm }}>Shared truck carries one pickup → one delivery</span>
            <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 2 }}>
              {handoff.dropCount > 1 && (
                <li>
                  This job has <strong>{handoff.dropCount} delivery addresses</strong> — only{" "}
                  <strong>{handoff.keptDestinationPostcode ?? "the pickup"}</strong> carried over; the other{" "}
                  {handoff.dropCount - 1} {handoff.dropCount - 1 === 1 ? "was" : "were"} dropped.
                </li>
              )}
              {handoff.fleetVanCount > 1 && (
                <li>
                  The full load needs <strong>{handoff.fleetVanCount} vans</strong>, so it won&apos;t fit one shared truck.
                </li>
              )}
              {handoff.recommendedModeLabel && handoff.recommendedModeLabel !== "Shared truck" && (
                <li>
                  The planner recommended <strong>{handoff.recommendedModeLabel}</strong> for this job
                  {handoff.reasons.length > 0 ? <> — {handoff.reasons[0]}</> : null}.
                </li>
              )}
              <li>Pallet lines were cleared — re-enter them below.</li>
            </ul>
          </div>
          <button
            type="button"
            onClick={() => setHandoffDismissed(true)}
            aria-label="Dismiss"
            style={{ background: "none", border: "none", cursor: "pointer", color: color.review.fg, fontSize: font.md, lineHeight: 1, padding: 0 }}
          >
            ×
          </button>
        </div>
      )}

      {/* ── Step 1 · Build your pallets (3D) ──
          Stack the order's LEFTOVER loose items onto pallets (drag / auto-fill / remove — all via the
          reused Van3DViewer). Empty in the common manifest flow (no loose items), where the pallets
          instead come from the companies gathered in Step 2 — say so rather than render nothing. */}
      <StepSection
        step={1}
        title="Build your pallets (3D)"
        subtitle="Stack any leftover loose items onto pallets — drag from the tray, auto-fill, or remove. They fold into the price when you choose to use them."
      >
        {unplaced.length > 0 ? (
          <>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                padding: `${spacing.sm}px ${spacing.md}px`,
                background: color.surfaceSub,
                border: `1px solid ${color.border}`,
                borderRadius: radius.input,
              }}
            >
              <span style={{ fontSize: font.sm, fontWeight: 600, color: color.text }}>
                {unplaced.length} leftover item{unplaced.length === 1 ? "" : "s"} from this load didn&apos;t fit the main van
              </span>
              <span style={{ fontSize: font.xs, color: color.muted }}>
                {palletableUnplaced.length > 0
                  ? `${palletableUnplaced.length} have a known size and can be stacked onto a pallet here.`
                  : "None have usable dimensions yet, so they can't be stacked."}
              </span>
            </div>
            <GroupagePalletBuilder unplaced={unplaced} itemById={itemById} maxStackHeightM={palletMaxHeightM} onUsePallet={useBuiltPallet} />
            {palletableUnplaced.length === 0 && (
              <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
                Nothing to stack yet — leftover items with a known size appear here as a draggable 3D pallet.
              </p>
            )}
          </>
        ) : (
          <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
            No loose items to stack here — your pallets come from the companies you add in Step 2 below.
          </p>
        )}
      </StepSection>

      {/* ── Step 2 (+ Step 3) live inside the shared-truck planner: it emits its own Step 2 header,
          the trunk load 3D, then the Step 3 journey maps. Fetches on mount, so it loads as soon as
          it's on screen. ── */}
      <TruckStackPlanner seed={sharedTruckSeed} uploadedDocument={uploadedDocument} onOpenHubs={onOpenHubs} />

      {/* ── Price a single consignment by hand ──
          A secondary path — the primary flow is the stepped shared-truck planner above. Collapsed by
          default so the 3D/map story leads; expand to price one point-to-point consignment. */}
      <details
        open={handFormOpen}
        onToggle={(e) => setHandFormOpen(e.currentTarget.open)}
        style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.md }}
      >
        <summary
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.xs,
            cursor: "pointer",
            fontSize: font.sm,
            fontWeight: 600,
            color: color.text,
            padding: `${spacing.sm}px 0`,
          }}
        >
          Price a single consignment by hand
        </summary>
      <div style={{ paddingTop: spacing.sm }}>
        <label style={{ ...labelWrap, marginBottom: spacing.sm }}>
          <span style={labelText}>Company / customer (optional)</span>
          <input
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="e.g. Acme Ltd"
            maxLength={120}
            style={inputStyle}
          />
          <span style={{ fontSize: font.xs, color: color.muted }}>
            Name it so this quote can be picked later when planning a shared truck across companies.
          </span>
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label style={labelWrap}>
            <span style={labelText}>Origin postcode</span>
            <PlacesInput
              value={originPostcode}
              onChange={(v) => { setOriginPostcode(v); setOriginValid(false); setOriginNoPostcode(false); }}
              onSelect={handleOriginSelect}
              valid={originValid}
              placeholder="e.g. CV1 2AB"
              style={inputStyle}
            />
            {originNoPostcode && (
              <span style={{ fontSize: font.xs, color: color.error }}>
                That place has no postcode — pick a suggestion with a postcode or type one.
              </span>
            )}
          </label>
          <label style={labelWrap}>
            <span style={labelText}>Destination postcode</span>
            <PlacesInput
              value={destinationPostcode}
              onChange={(v) => { setDestinationPostcode(v); setDestinationValid(false); setDestinationNoPostcode(false); }}
              onSelect={handleDestinationSelect}
              valid={destinationValid}
              placeholder="e.g. B1 1AA"
              style={inputStyle}
            />
            {destinationNoPostcode && (
              <span style={{ fontSize: font.xs, color: color.error }}>
                That place has no postcode — pick a suggestion with a postcode or type one.
              </span>
            )}
          </label>
        </div>

        <label style={{ ...labelWrap, marginTop: spacing.sm }}>
          <span style={labelText}>ETA (optional)</span>
          <input
            type="date"
            className="date-field"
            value={eta}
            onChange={(e) => setEta(e.target.value)}
            // Clicking anywhere on the field opens the picker, not just the calendar icon.
            onClick={(e) => e.currentTarget.showPicker?.()}
            // A date needs far less room than a postcode — constrain it so it doesn't
            // stretch awkwardly across the full row.
            style={{ ...inputStyle, cursor: "pointer", maxWidth: 240 }}
          />
          <span style={{ fontSize: font.xs, color: color.muted }}>
            Leave blank if the delivery date isn&apos;t committed yet.
          </span>
        </label>

        {/* Routing choice — shared truck via our hubs (cross-dock) vs a hubless direct move on another carrier. */}
        <div style={{ ...labelWrap, marginTop: spacing.sm }}>
          <span style={labelText}>Routing</span>
          <div
            role="radiogroup"
            aria-label="Shared-truck routing"
            style={{ display: "inline-flex", border: `1px solid ${color.border}`, borderRadius: radius.badge, overflow: "hidden", width: "fit-content" }}
          >
            {([
              ["via-hub", "Via hubs"],
              ["direct", "Direct (another carrier)"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={routing === value}
                onClick={() => setRouting(value)}
                style={{
                  padding: "6px 14px",
                  fontSize: font.sm,
                  fontWeight: 600,
                  border: "none",
                  cursor: "pointer",
                  background: routing === value ? color.surface : "transparent",
                  color: routing === value ? color.text : color.muted,
                  boxShadow: routing === value ? color.shadow : "none",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <span style={{ fontSize: font.xs, color: color.muted }}>
            {routing === "via-hub"
              ? "Cross-docks through your hub network — both postcodes must sit in a hub catchment."
              : "Hubless pooled move — quotable for any postcode, priced per pallet-space."}
          </span>
        </div>

        {/* Intermediate trunk stops. Only a via-hub route has a trunk to stop on, so the picker is
            hidden on a direct move rather than left to earn a 400 from the server. */}
        {routing === "via-hub" ? (
          <TrunkStopsEditor
            hubs={stoppableHubs}
            stopHubIds={trunkStopHubIds}
            endHubIds={originDestHubIds}
            hubsState={hubsState}
            onChange={applyStops}
            disabled={loading}
          />
        ) : null}

        <p style={fieldGroupLabel}>The pallets we&apos;ll price</p>
        <p style={{ margin: `0 0 ${spacing.xs}px`, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          One line per pallet type — <strong>size</strong>, weight of a <strong>single</strong> pallet, and how
          many. Charged by <strong>pallet-space</strong> (full = 1, half = ½).
          {uploadedDocument ? " Your uploaded file feeds the shared-truck planner below; this form prices one consignment by hand." : ""}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {lines.map((line, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: showStopRefs ? "1.4fr 1fr 1fr 1fr 1fr auto" : "1.4fr 1fr 1fr auto",
                gap: 8,
                alignItems: "end",
              }}
            >
              <label style={labelWrap}>
                <span style={labelText}>Pallet size</span>
                <select
                  value={line.footprint}
                  onChange={(e) => updateLine(i, { footprint: e.target.value as PalletFootprintClass })}
                  style={inputStyle}
                >
                  {FOOTPRINT_META_LIST.map((m) => (
                    <option key={m.footprint} value={m.footprint}>
                      {m.optionLabel}
                    </option>
                  ))}
                </select>
              </label>
              <label style={labelWrap}>
                <span style={labelText}>Weight per pallet (kg)</span>
                <input
                  type="number"
                  min="0"
                  value={line.weightKg}
                  onChange={(e) => updateLine(i, { weightKg: e.target.value })}
                  placeholder="e.g. 250"
                  style={inputStyle}
                />
              </label>
              <label style={labelWrap}>
                <span style={labelText}>How many</span>
                <input
                  type="number"
                  min="1"
                  value={line.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  placeholder="e.g. 1"
                  style={inputStyle}
                />
              </label>
              {/* Where this line boards and leaves the trunk. Only offered once the route has a stop
                  to board or leave at; the options are the stops themselves, so a line can never
                  name a station that isn't on the route. */}
              {showStopRefs ? (
                <>
                  <label style={labelWrap}>
                    <span style={labelText}>Joins at</span>
                    <select
                      value={line.joinAtHubId ?? ""}
                      onChange={(e) => setLineJoinAt(i, e.target.value)}
                      style={inputStyle}
                    >
                      <option value="">Origin (start)</option>
                      {joinOptionsFor(line).map((id) => (
                        <option key={id} value={id}>
                          {hubNameOf(id)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={labelWrap}>
                    <span style={labelText}>Leaves at</span>
                    <select
                      value={line.leaveAtHubId ?? ""}
                      onChange={(e) => setLineLeaveAt(i, e.target.value)}
                      style={inputStyle}
                    >
                      {leaveOptionsFor(line).map((id) => (
                        <option key={id} value={id}>
                          {hubNameOf(id)}
                        </option>
                      ))}
                      <option value="">Destination (end)</option>
                    </select>
                  </label>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => removeLine(i)}
                disabled={lines.length <= 1}
                style={{ ...secondaryBtn, padding: "6px 10px" }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        {stopResetNotice && (
          <p
            role="status"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: spacing.sm,
              margin: `${spacing.sm}px 0 0`,
              fontSize: font.xs,
              color: color.review.fg,
              background: color.review.bg,
              border: `1px solid ${color.review.border}`,
              borderRadius: radius.input,
              padding: "8px 10px",
              lineHeight: 1.5,
            }}
          >
            <span>{stopResetNotice}</span>
            <button
              type="button"
              onClick={() => setStopResetNotice(null)}
              aria-label="Dismiss"
              style={{ background: "none", border: "none", cursor: "pointer", color: color.review.fg, fontWeight: 700, padding: 0, lineHeight: 1 }}
            >
              ×
            </button>
          </p>
        )}

        <div style={{ marginTop: spacing.sm }}>
          <PalletTallyBar lines={lines} />
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: spacing.md }}>
          <button type="button" onClick={addLine} style={secondaryBtn}>
            Add pallet line
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={loading}
            style={{ ...primaryBtn, opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }}
          >
            {loading ? "Getting quote…" : quote ? "Recalculate quote" : "Get groupage quote"}
          </button>
        </div>

        {error && (
          <ErrorBanner
            style={{ marginTop: spacing.sm }}
            action={onOpenHubs && (() => {
              // A catchment-gap error names the uncovered area: `postcode area "EH"`. When we can read
              // it, offer a one-click "create a hub covering EH" that lands on a prefilled Add-hub form;
              // otherwise fall back to just opening the hubs card.
              const missingArea = error.match(/postcode area "([A-Z]{1,2})"/)?.[1];
              return missingArea ? (
                <button
                  type="button"
                  onClick={() => onOpenHubs({ catchment: [missingArea] })}
                  style={hubFixLinkStyle}
                >
                  Create a hub covering {missingArea} →
                </button>
              ) : (
                <button type="button" onClick={() => onOpenHubs()} style={hubFixLinkStyle}>
                  Check your depots &amp; hubs setup →
                </button>
              );
            })()}
          >
            {error}
          </ErrorBanner>
        )}
      </div>
      </details>

      {/* ── Result ── */}
      {quote && (
        <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.md, display: "flex", flexDirection: "column", gap: spacing.sm }}>
          {/* Journey — plain step-by-step: your pickup → hub(s) → your delivery. */}
          <GroupageJourneyStrip quote={quote} />

          {/* Geographic context demoted to an opt-in toggle — the schematic above is the
              primary read. The UK map confused operators as the default (a lone hub dot,
              no address pins), so it now hides behind a summary. */}
          <details>
            <summary style={{ fontSize: font.xs, color: color.muted, cursor: "pointer" }}>
              Where these hubs sit on the UK map
            </summary>
            <div style={{ marginTop: spacing.sm }}>
              {(() => {
                // Live Google map of the two hubs (origin → destination) when a browser key is set;
                // otherwise the static SVG. Hubless "direct" paths have no hubs to plot — the
                // journey strip carries the story (GroupageRouteMap returns null there).
                const originLL = quote.path.originHub ? hubCentroid(quote.path.originHub.catchment) : null;
                const destLL = quote.path.destinationHub ? hubCentroid(quote.path.destinationHub.catchment) : null;
                const points: RoutePoint[] = [];
                if (quote.path.originHub && originLL) points.push({ seq: 1, label: quote.path.originHub.name, ...originLL });
                if (!quote.path.isLocal && quote.path.destinationHub && destLL) {
                  points.push({ seq: 2, label: quote.path.destinationHub.name, ...destLL });
                }
                return publicEnv.googleMapsApiKey && points.length > 0 ? (
                  <RouteMap points={points} heightPx={300} />
                ) : (
                  <GroupageRouteMap path={quote.path} />
                );
              })()}
            </div>
          </details>

          {/* A high-volume booking is quoted, not rejected — so the fact that it outgrows one
              vehicle has to be said out loud, right above the price. Two DIFFERENT problems, never
              merged: a divisible overflow (run N vehicles) and an indivisible one (no vehicle on
              that leg can carry that pallet, whatever the count). */}
          {!quote.fits && (
            <div
              style={{
                border: `1px solid ${color.warningBorder}`,
                background: color.warningBg,
                color: color.warning,
                borderRadius: radius.badge,
                padding: "10px 12px",
                fontSize: font.xs,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <strong style={{ fontSize: font.sm }}>
                This load needs {quote.vehiclesNeeded} vehicles — it will not fit on one.
              </strong>
              <span>
                Priced for the space and weight it really consumes. Book {quote.vehiclesNeeded} vehicles on the
                overflowing leg{quote.capacityChecks.filter((c) => !c.fits).length > 1 ? "s" : ""} below, or reduce the load.
              </span>
              {quote.oversizeLines?.length ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {quote.oversizeLines.map((o, i) => (
                    <li key={i}>
                      <strong>Pallet line {o.lineNumber}</strong> cannot ride the {o.legKind} leg ({o.legFrom} →{" "}
                      {o.legTo}) at all: {o.reason === "weight" ? `${o.palletValue} kg` : `${o.palletValue} pallet-spaces`}{" "}
                      per pallet vs a {o.reason === "weight" ? `${o.vehicleLimit} kg` : `${o.vehicleLimit}-space`} vehicle.
                      More vehicles will not help — re-palletise it, or put a bigger vehicle on that leg.
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}

          {/* Leg chain */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {quote.path.legs.map((leg, i) => {
              const check = quote.capacityChecks[i];
              return (
                <div
                  key={i}
                  style={{
                    border: `1px solid ${color.border}`,
                    borderRadius: radius.badge,
                    padding: "8px 12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600, fontSize: font.sm, color: color.text, textTransform: "capitalize" }}>
                      {leg.kind}
                    </span>
                    <span style={{ fontSize: font.xs, color: color.muted, marginLeft: 6 }}>
                      {leg.from} → {leg.to}
                    </span>
                  </div>
                  {check && (
                    <span style={{ fontSize: font.xs, color: check.fits ? color.success : color.error }}>
                      {check.fits ? "Fits ✓" : `Overflow · needs ${check.vehiclesNeeded} vehicles`} ·{" "}
                      {check.spacesRemaining} spaces, {Math.round(check.payloadRemainingKg)} kg remaining
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div>
            <span style={badgeStyle}>
              {quote.bindingLimit === "weight" ? "Weight-out" : "Space-out"}
            </span>
          </div>

          {/* Demand summary */}
          <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
            {quote.demand.palletCount} pallets · {quote.demand.footprints} pallet-spaces · {quote.demand.weightKg} kg
          </p>

          {/* What each leg actually carries. Pallets leave and join at the stops, so a hop rarely
              carries the whole booking — show it rather than let the operator assume it does.
              One entry per `path.legs[i]`; present only when `path.stops` is non-empty. */}
          {quote.legLoads ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={sectionLabel}>On board, leg by leg</span>
              {quote.path.legs.map((leg, i) => {
                const load = quote.legLoads![i];
                return (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: font.xs }}>
                    <span style={{ color: color.muted }}>
                      {leg.from} → {leg.to}
                    </span>
                    {load ? (
                      <span style={{ color: color.text, fontWeight: 600 }}>
                        {load.palletCount} pallets · {load.footprints} spaces · {load.weightKg} kg
                      </span>
                    ) : (
                      <span style={{ color: color.error }}>Load unknown for this hop</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* Price breakdown */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {quote.lineItems.map((item, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: font.sm, color: color.text }}>
                <span>{item.label}</span>
                <span>
                  {quote.currencySymbol}
                  {item.amount.toFixed(2)}
                </span>
              </div>
            ))}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: font.sm,
                fontWeight: 700,
                color: color.text,
                borderTop: `1px solid ${color.border}`,
                paddingTop: 6,
                marginTop: 2,
              }}
            >
              <span>Total</span>
              <span>
                {quote.currencySymbol}
                {quote.total.toFixed(2)}
              </span>
            </div>
          </div>

          {/* ETA */}
          {quote.eta ? (
            <p style={{ margin: 0, fontSize: font.xs, color: color.text, fontWeight: 600 }}>
              Committed delivery: {quote.eta}
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
              No ETA provided (timetables not yet wired)
            </p>
          )}

          {/* Send Quote */}
          <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.sm }}>
            <p style={{ margin: `0 0 ${spacing.xs}px`, fontSize: font.xs, fontWeight: 600, color: color.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Send Quote
            </p>
            <SendQuoteButton groupageQuote={quote} />
          </div>

          {/* Book shipment */}
          <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.sm }}>
            <button
              type="button"
              onClick={book}
              disabled={booking || bookedId != null}
              style={{
                ...primaryBtn,
                opacity: booking || bookedId != null ? 0.6 : 1,
                cursor: booking || bookedId != null ? "not-allowed" : "pointer",
              }}
            >
              {booking ? "Booking…" : bookedId != null ? "Booked" : "Book shipment"}
            </button>
            {bookedId && (
              <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: font.xs, color: color.success, fontWeight: 600 }}>
                Booked — {bookedId}
                {bookedTotal ? ` at ${bookedTotal.currencySymbol}${bookedTotal.total.toFixed(2)}` : ""} (track it
                under Shipments in the left panel)
              </p>
            )}
            {priceMoved && bookedTotal && (
              <p
                role="alert"
                style={{
                  fontSize: font.xs,
                  marginTop: spacing.xs,
                  color: color.review.fg,
                  background: color.review.bg,
                  border: `1px solid ${color.review.border}`,
                  borderRadius: radius.input,
                  padding: "8px 10px",
                }}
              >
                ⚠️ The price moved since you quoted: booked at {bookedTotal.currencySymbol}
                {bookedTotal.total.toFixed(2)} vs {quote?.currencySymbol}
                {quote?.total.toFixed(2)} on screen (rates or hubs changed in between). Requote before
                confirming with the customer.
              </p>
            )}
            {bookError && (
              <ErrorBanner style={{ marginTop: spacing.xs }}>{bookError}</ErrorBanner>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const fieldGroupLabel: React.CSSProperties = {
  fontSize: font.xs,
  fontWeight: 600,
  color: color.muted,
  margin: `${spacing.md}px 0 ${spacing.xs}px`,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const primaryBtn: React.CSSProperties = {
  ...baseBtn,
  background: color.text,
  color: color.surface,
  border: `1px solid ${color.text}`,
};
const badgeStyle: React.CSSProperties = {
  display: "inline-block",
  fontSize: font.xs,
  fontWeight: 600,
  color: color.muted,
  background: color.surfaceSub,
  border: `1px solid ${color.border}`,
  borderRadius: radius.badge,
  padding: "2px 8px",
};
const hubFixLinkStyle: React.CSSProperties = {
  display: "block",
  marginTop: 6,
  border: "none",
  background: "none",
  padding: 0,
  color: color.error,
  fontSize: font.xs,
  fontWeight: 600,
  textDecoration: "underline",
  cursor: "pointer",
};
