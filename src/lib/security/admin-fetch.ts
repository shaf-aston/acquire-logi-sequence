"use client";

import { ADMIN_KEY_HEADER } from "./admin-key-header";

const STORAGE_KEY = "fleetview.adminKey";

function readStoredKey(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeKey(key: string | null): void {
  try {
    if (key) window.sessionStorage.setItem(STORAGE_KEY, key);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode): the key just won't persist past this call.
  }
}

/**
 * fetch() for admin config writes. Asks the operator for the admin key once per tab (never bundled
 * into client code), sends it as a header, and forgets it on a 401 so the next attempt re-asks.
 */
export async function adminFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let key = readStoredKey();
  if (!key) {
    key = window.prompt("Enter the admin key to change the hub/fleet configuration:")?.trim() || null;
    storeKey(key);
  }
  const headers = new Headers(init.headers);
  if (key) headers.set(ADMIN_KEY_HEADER, key);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) storeKey(null);
  return res;
}
