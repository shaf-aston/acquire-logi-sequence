import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildConfigFrom } from "@/config/env";
import { isAdminKeyValid, requireAdmin } from "@/lib/security/admin-auth";

const configRef = { current: buildConfigFrom({}) };
vi.mock("@/config/env", async (orig) => ({
  ...(await orig<typeof import("@/config/env")>()),
  getConfig: () => configRef.current,
}));

const withKey = (key: string) => {
  configRef.current = buildConfigFrom({ ADMIN_API_KEY: key });
};
const req = (key?: string) =>
  new Request("http://localhost/api/hubs", { method: "POST", headers: key === undefined ? {} : { "x-admin-key": key } });

describe("isAdminKeyValid", () => {
  it("accepts an exact match", () => expect(isAdminKeyValid("s3cret", "s3cret")).toBe(true));
  it("rejects a wrong key", () => expect(isAdminKeyValid("nope", "s3cret")).toBe(false));
  it("rejects a key that only shares a prefix", () => expect(isAdminKeyValid("s3cret-extra", "s3cret")).toBe(false));
  it("rejects a missing key", () => expect(isAdminKeyValid(null, "s3cret")).toBe(false));
  it("never matches when no key is configured, even an empty one", () => expect(isAdminKeyValid("", "")).toBe(false));
});

describe("requireAdmin", () => {
  beforeEach(() => withKey(""));

  it("refuses every write with 503 when ADMIN_API_KEY is unset (closed by default)", async () => {
    const res = requireAdmin(req("anything"));
    expect(res?.status).toBe(503);
    expect((await res!.json()).error).toMatch(/ADMIN_API_KEY/);
  });

  it("returns 401 when the header is missing", () => {
    withKey("s3cret");
    expect(requireAdmin(req())?.status).toBe(401);
  });

  it("returns 401 for a wrong key", () => {
    withKey("s3cret");
    expect(requireAdmin(req("wrong"))?.status).toBe(401);
  });

  it("lets the request through (null) with the right key", () => {
    withKey("s3cret");
    expect(requireAdmin(req("s3cret"))).toBeNull();
  });
});

describe("config: ADMIN_API_KEY", () => {
  it("defaults to blank", () => expect(buildConfigFrom({}).security.adminApiKey).toBe(""));
  it("reads the configured key", () => expect(buildConfigFrom({ ADMIN_API_KEY: " k " }).security.adminApiKey).toBe("k"));
});
