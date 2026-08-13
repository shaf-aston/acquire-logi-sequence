/**
 * Resolves the active EmailSender from config:
 *   • EMAIL_SMTP_PASS absent → UnconfiguredEmailSender (fails loud on send)
 *   • EMAIL_SMTP_PASS set   → SmtpEmailSender (Gmail App Password by default)
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
  if (e.smtp.pass === "") {
    logger.warn("EMAIL_SMTP_PASS not set — Send Quote will fail loud until it's configured");
    cached = new UnconfiguredEmailSender();
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
