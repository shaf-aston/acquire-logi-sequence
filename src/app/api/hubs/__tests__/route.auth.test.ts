import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildConfigFrom } from "@/config/env";

const upsertHub = vi.fn();
const deleteHub = vi.fn();
vi.mock("@/lib/groupage/hub.repository", async (orig) => ({
  ...(await orig<typeof import("@/lib/groupage/hub.repository")>()),
  FileHubRepository: class {
    listHubs = async () => [];
    upsertHub = upsertHub;
    deleteHub = deleteHub;
  },
}));

const configRef = { current: buildConfigFrom({ ADMIN_API_KEY: "s3cret" }) };
vi.mock("@/config/env", async (orig) => ({
  ...(await orig<typeof import("@/config/env")>()),
  getConfig: () => configRef.current,
}));

const { GET, POST, PUT, DELETE } = await import("@/app/api/hubs/route");

const hub = { id: "hub-x", name: "Hub X", catchment: ["B"] };
const call = (method: string, body: unknown, key?: string) =>
  new Request("http://localhost/api/hubs", {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { "x-admin-key": key } : {}) },
    body: JSON.stringify(body),
  });

describe("/api/hubs admin gate", () => {
  beforeEach(() => {
    upsertHub.mockReset();
    deleteHub.mockReset().mockResolvedValue(true);
  });

  it("GET stays public", async () => {
    expect((await GET()).status).toBe(200);
  });

  for (const [name, handler] of [["POST", POST], ["PUT", PUT]] as const) {
    it(`${name} without a key is 401 and never writes`, async () => {
      expect((await handler(call(name, hub))).status).toBe(401);
      expect(upsertHub).not.toHaveBeenCalled();
    });
    it(`${name} with the right key writes`, async () => {
      expect((await handler(call(name, hub, "s3cret"))).status).toBe(200);
      expect(upsertHub).toHaveBeenCalledOnce();
    });
  }

  it("DELETE with a wrong key is 401 and never deletes", async () => {
    expect((await DELETE(call("DELETE", { id: "hub-x" }, "wrong"))).status).toBe(401);
    expect(deleteHub).not.toHaveBeenCalled();
  });

  it("DELETE with the right key deletes", async () => {
    expect((await DELETE(call("DELETE", { id: "hub-x" }, "s3cret"))).status).toBe(200);
    expect(deleteHub).toHaveBeenCalledWith("hub-x");
  });
});
