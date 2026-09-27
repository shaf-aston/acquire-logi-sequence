import { describe, it, expect } from "vitest";
import { buildGroupageQuoteEmail, buildQuoteEmail } from "@/lib/email/quote-email";
import type { GroupageQuote } from "@/lib/groupage/groupage.types";
import type { Quote } from "@/types/api";

// /api/quote/send renders a quote echoed back by the browser, so every field is attacker-controllable.
const EVIL = `<a href="https://evil.example">x</a><img src=x onerror=alert(1)>'`;

const hostileGroupage = {
  path: { originHub: { name: EVIL }, destinationHub: { name: EVIL }, isLocal: false },
  originPostcode: EVIL,
  destinationPostcode: EVIL,
  demand: { palletCount: EVIL, footprints: EVIL, weightKg: EVIL },
  eta: EVIL,
  lineItems: [{ label: EVIL, amount: 10 }],
  total: 10,
  currencySymbol: EVIL,
} as unknown as GroupageQuote;

const hostileQuote = {
  route: { origin: EVIL, destination: EVIL, distanceMiles: 12 },
  vans: [{ description: EVIL, distanceCost: 5 }],
  lineItems: [{ label: EVIL, amount: EVIL }],
  total: 5,
} as unknown as Quote;

function expectNoMarkup(html: string) {
  expect(html).not.toContain("<a href=\"https://evil");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("onerror=alert(1)>'");
}

describe("quote emails escape client-supplied values", () => {
  it("groupage: currency symbol and load figures can't inject markup", () => {
    const { html } = buildGroupageQuoteEmail(hostileGroupage, EVIL);
    expectNoMarkup(html);
    expect(html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(html).toContain("&#39;");
  });

  it("van quote: text fields escaped, non-numeric amounts render as a dash", () => {
    const { html } = buildQuoteEmail(hostileQuote, EVIL);
    expectNoMarkup(html);
    expect(html).toContain("—");
  });

  it("still renders normal values unchanged", () => {
    const { html } = buildGroupageQuoteEmail(
      {
        ...hostileGroupage,
        path: { originHub: { name: "Midlands" }, destinationHub: { name: "Leeds" }, isLocal: false },
        demand: { palletCount: 3, footprints: 2.5, weightKg: 900 },
        eta: "Tue 3 Nov",
        lineItems: [{ label: "Trunk", amount: 120 }],
        currencySymbol: "£",
      } as unknown as GroupageQuote,
      "Acme",
    );
    expect(html).toContain("Midlands → Leeds");
    expect(html).toContain("3 pallets · 2.5 pallet-spaces · 900 kg");
    expect(html).toContain("£10.00");
  });
});
