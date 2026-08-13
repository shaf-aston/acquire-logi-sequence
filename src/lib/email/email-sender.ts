/**
 * Email-sending seam. One outbound integration point so "Send Quote" doesn't know
 * which provider (SMTP today; a transactional API later) actually delivers it.
 */

export interface SendEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailSender {
  /** Identifies the backend in logs ("smtp" | "unconfigured"). */
  readonly backend: string;
  send(input: SendEmailInput): Promise<void>;
}

export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailError";
  }
}

/**
 * Active when EMAIL_SMTP_PASS is unset. Throws on send rather than pretending
 * success — an operator clicking "Send Quote" must never be told a quote went
 * out when it didn't (fail loud, no silent fallback).
 */
export class UnconfiguredEmailSender implements EmailSender {
  readonly backend = "unconfigured";
  async send(): Promise<void> {
    throw new EmailError(
      "Email sending isn't configured yet — set EMAIL_SMTP_PASS (a Gmail App Password) in .env.local.",
    );
  }
}
