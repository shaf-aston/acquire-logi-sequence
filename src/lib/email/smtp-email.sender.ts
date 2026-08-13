/** SMTP EmailSender backed by nodemailer — the Gmail App Password path. */
import nodemailer, { type Transporter } from "nodemailer";
import { EmailError, type EmailSender, type SendEmailInput } from "@/lib/email/email-sender";

export interface SmtpEmailSenderOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly timeoutMs: number;
  /** Blank = no copy. Applied to every send — callers never need to pass it themselves. */
  readonly bcc: string;
}

export class SmtpEmailSender implements EmailSender {
  readonly backend = "smtp";
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly bcc?: string;

  constructor(opts: SmtpEmailSenderOptions) {
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.user, pass: opts.pass },
      connectionTimeout: opts.timeoutMs,
      greetingTimeout: opts.timeoutMs,
      socketTimeout: opts.timeoutMs,
    });
    this.from = opts.fromName ? `"${opts.fromName}" <${opts.fromAddress}>` : opts.fromAddress;
    this.bcc = opts.bcc || undefined;
  }

  async send(input: SendEmailInput): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: input.to,
        bcc: this.bcc,
        subject: input.subject,
        html: input.html,
        text: input.text,
      });
    } catch (err) {
      throw new EmailError(`Failed to send email: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
