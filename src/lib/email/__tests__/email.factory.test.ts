import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildConfigFrom } from "@/config/env";

const configRef = { current: buildConfigFrom({}) };
vi.mock("@/config/env", async (orig) => ({
  ...(await orig<typeof import("@/config/env")>()),
  getConfig: () => configRef.current,
}));

async function senderFor(env: Record<string, string>) {
  configRef.current = buildConfigFrom(env);
  vi.resetModules();
  const { getEmailSender } = await import("@/lib/email/email.factory");
  return getEmailSender();
}

describe("email factory", () => {
  beforeEach(() => vi.resetModules());

  it("has no built-in sender address", () => {
    const e = buildConfigFrom({}).email;
    expect(e.fromAddress).toBe("");
    expect(e.smtp.user).toBe("");
  });

  it("names every missing setting and never sends", async () => {
    const sender = await senderFor({ EMAIL_SMTP_PASS: "app-pass" });
    expect(sender.backend).toBe("unconfigured");
    await expect(sender.send({ to: "a@b.co", subject: "s", html: "h", text: "t" })).rejects.toThrow(
      /EMAIL_FROM_ADDRESS, EMAIL_SMTP_USER/,
    );
  });

  it("uses SMTP once address, user and password are all set", async () => {
    const sender = await senderFor({
      EMAIL_FROM_ADDRESS: "quotes@example.com",
      EMAIL_SMTP_USER: "quotes@example.com",
      EMAIL_SMTP_PASS: "app-pass",
    });
    expect(sender.backend).not.toBe("unconfigured");
  });
});
