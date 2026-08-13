/**
 * GET /api/config/pricing — the non-secret pricing defaults the "Quote settings" panel
 * pre-fills from. Thin wrapper over getConfig(); surfaces only the operator-tunable rate
 * knobs (never API keys or paths) so the client can show the current default beside each
 * override field. Read-only: changing a value is a per-request override, not a config write.
 */
import { NextResponse } from "next/server";
import { getConfig } from "@/config/env";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const { routing } = getConfig();
    return NextResponse.json({
      currencySymbol: routing.currencySymbol,
      driverHourlyRate: routing.driverHourlyRate,
      loadUnloadMinutesPerVan: routing.loadUnloadMinutesPerVan,
      returnFactor: routing.returnFactor,
      fragilitySurchargePerItem: routing.fragilitySurchargePerItem,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load pricing defaults.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
