import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getConfig } from "@/config/env";
import { ADMIN_KEY_HEADER } from "./admin-key-header";

// Hash both sides so timingSafeEqual always compares equal-length buffers and the key length isn't leaked.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function isAdminKeyValid(provided: string | null, expected: string): boolean {
  if (!expected || !provided) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

/** Returns an error response when the request is not an authorised admin write, else null. */
export function requireAdmin(request: Request): Response | null {
  const expected = getConfig().security.adminApiKey;
  if (!expected) {
    return NextResponse.json(
      { success: false, error: "Admin writes are disabled: ADMIN_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }
  if (!isAdminKeyValid(request.headers.get(ADMIN_KEY_HEADER), expected)) {
    return NextResponse.json({ success: false, error: "Unauthorised." }, { status: 401 });
  }
  return null;
}
