/**
 * Resolves the active EmailSender from config:
 *   • EMAIL_FROM_ADDRESS, EMAIL_SMTP_USER or EMAIL_SMTP_PASS absent → UnconfiguredEmailSender (fails loud on send)
 *   • all set → SmtpEmailSender (Gmail App Password by default)
 * Resolved once and cached, mirroring src/lib/storage/store.factory.ts.
 */
import { getConfig } from "@/config/env";
import { createLogger } from "@/lib/logger/logger";
import { UnconfiguredEmailSender, type EmailSender } from "@/lib/email/email-sender";
import { SmtpEmailSender } from "@/lib/email/smtp-email.sender";

const logger = createLogger("email.factory");

let cached: EmailSender | null = null;

export function getEmailSender(): EmailSender {
  if (cached) return cached;

  const e = getConfig().email;
  const missing = ([
    ["EMAIL_FROM_ADDRESS", e.fromAddress],
    ["EMAIL_SMTP_USER", e.smtp.user],
    ["EMAIL_SMTP_PASS", e.smtp.pass],
  ] as const)
    .filter(([, value]) => value === "")
    .map(([name]) => name);
  if (missing.length > 0) {
    logger.warn("email not fully configured — Send Quote will fail loud until it is", { missing });
    cached = new UnconfiguredEmailSender(missing);
    return cached;
  }

  cached = new SmtpEmailSender({
    host: e.smtp.host,
    port: e.smtp.port,
    secure: e.smtp.secure,
    user: e.smtp.user,
    pass: e.smtp.pass,
    fromAddress: e.fromAddress,
    fromName: e.fromName,
    timeoutMs: e.timeoutMs,
    bcc: e.bcc,
  });
  logger.info("SMTP email sender active", { host: e.smtp.host, from: e.fromAddress });
  return cached;
}
