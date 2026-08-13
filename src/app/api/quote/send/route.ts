/**
 * Thin HTTP wrapper over the email seam. No business logic — validates the
 * request shape, renders the quote via lib/email/quote-email, delegates the
 * actual send to lib/email/email.factory.
 * Body: { to: string, quote?: Quote, groupageQuote?: GroupageQuote } (exactly one quote field)
 */
import { NextResponse } from "next/server";
import { getConfig } from "@/config/env";
import { createLogger } from "@/lib/logger/logger";
import { getEmailSender } from "@/lib/email/email.factory";
import { EmailError } from "@/lib/email/email-sender";
import { buildGroupageQuoteEmail, buildQuoteEmail } from "@/lib/email/quote-email";
import type { Quote } from "@/types/api";
import type { GroupageQuote } from "@/lib/groupage/groupage.types";

export const runtime = "nodejs";

const logger = createLogger("api.quote.send");

class SendQuoteValidationError extends Error {}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseTo(raw: unknown): string {
  if (typeof raw !== "string" || !EMAIL_RE.test(raw.trim())) {
    throw new SendQuoteValidationError("Missing or invalid 'to' email address.");
  }
  return raw.trim();
}

/** Shallow structural check — this data only ever originates from our own /api/quote
 *  response echoed back by the client, so we check shape, not every nested field. */
function parseQuote(raw: unknown): Quote {
  const q = raw as Partial<Quote> | null;
  if (
    !q ||
    typeof q !== "object" ||
    !q.route ||
    typeof q.route.origin !== "string" ||
    typeof q.route.destination !== "string" ||
    !Array.isArray(q.vans) ||
    !Array.isArray(q.lineItems) ||
    typeof q.total !== "number"
  ) {
    throw new SendQuoteValidationError("Malformed 'quote'.");
  }
  return q as Quote;
}

function parseGroupageQuote(raw: unknown): GroupageQuote {
  const q = raw as Partial<GroupageQuote> | null;
  if (
    !q ||
    typeof q !== "object" ||
    !q.path ||
    !q.demand ||
    !Array.isArray(q.lineItems) ||
    typeof q.total !== "number" ||
    typeof q.currencySymbol !== "string"
  ) {
    throw new SendQuoteValidationError("Malformed 'groupageQuote'.");
  }
  return q as GroupageQuote;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as {
      to?: unknown;
      quote?: unknown;
      groupageQuote?: unknown;
    };

    const to = parseTo(body.to);
    if (!body.quote && !body.groupageQuote) {
      throw new SendQuoteValidationError("Missing 'quote' or 'groupageQuote'.");
    }
    if (body.quote && body.groupageQuote) {
      throw new SendQuoteValidationError("Send only one of 'quote' or 'groupageQuote', not both.");
    }

    const companyName = getConfig().email.fromName;
    const content = body.quote
      ? buildQuoteEmail(parseQuote(body.quote), companyName)
      : buildGroupageQuoteEmail(parseGroupageQuote(body.groupageQuote), companyName);

    await getEmailSender().send({ to, ...content });

    logger.info("quote emailed", { to });
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof SendQuoteValidationError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    if (err instanceof EmailError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 502 });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ success: false, error: "Request body is not valid JSON." }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("unexpected send-quote error", { error: msg });
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
