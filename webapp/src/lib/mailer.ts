import net from "node:net";
import tls from "node:tls";
import os from "node:os";

/**
 * Pluggable outbound email. Real delivery is configured by the operator:
 *   RESEND_API_KEY + EMAIL_FROM   → Resend HTTPS API
 *   SMTP_URL + EMAIL_FROM         → SMTP (smtp://user:pass@host:587 with
 *                                    STARTTLS, or smtps://user:pass@host:465)
 * With neither, development gets a clearly-logged console fallback. In
 * production there is NO silent fallback: delivery reports "none" and callers
 * either refuse (signup) or show the link to an authorized owner.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type EmailDeliveryMode = "resend" | "smtp" | "console" | "none";

export interface EmailSender {
  readonly mode: Exclude<EmailDeliveryMode, "none">;
  send(message: EmailMessage): Promise<void>;
}

type Env = Record<string, string | undefined>;

export function emailDeliveryMode(env: Env = process.env): EmailDeliveryMode {
  const from = env.EMAIL_FROM?.trim();
  if (from && env.RESEND_API_KEY?.trim()) return "resend";
  if (from && env.SMTP_URL?.trim()) return "smtp";
  return env.NODE_ENV === "production" ? "none" : "console";
}

/** True only when an address outside this process can actually receive mail. */
export function emailIsDeliverable(env: Env = process.env): boolean {
  const mode = emailDeliveryMode(env);
  return mode === "resend" || mode === "smtp";
}

export function getEmailSender(env: Env = process.env): EmailSender | null {
  const mode = emailDeliveryMode(env);
  switch (mode) {
    case "resend":
      return resendSender(env.RESEND_API_KEY!.trim(), env.EMAIL_FROM!.trim());
    case "smtp":
      return smtpSender(env.SMTP_URL!.trim(), env.EMAIL_FROM!.trim());
    case "console":
      return consoleSender();
    default:
      return null;
  }
}

function clean(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function consoleSender(): EmailSender {
  return {
    mode: "console",
    async send(message) {
      console.warn(
        [
          "[DEV ONLY — email NOT sent: no RESEND_API_KEY/SMTP_URL configured]",
          `To: ${clean(message.to)}`,
          `Subject: ${clean(message.subject)}`,
          message.text,
        ].join("\n"),
      );
    },
  };
}

function resendSender(apiKey: string, from: string): EmailSender {
  return {
    mode: "resend",
    async send(message) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [clean(message.to)], subject: clean(message.subject), text: message.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Resend rejected the message (HTTP ${response.status})`);
    },
  };
}

// ---------------------------------------------------------------- SMTP

class SmtpConnection {
  private buffer = "";
  private waiters: Array<(line: string) => void> = [];
  private lines: string[] = [];
  private failure: Error | null = null;
  private failWaiters: Array<(error: Error) => void> = [];

  constructor(public socket: net.Socket) {
    this.attach(socket);
  }

  private handlers: { data: (chunk: Buffer) => void; error: (error: Error) => void; close: () => void } | null = null;

  private attach(socket: net.Socket): void {
    const onData = (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    };
    const fail = (error: Error) => {
      this.failure = error;
      for (const waiter of this.failWaiters.splice(0)) waiter(error);
    };
    const onClose = () => fail(new Error("SMTP connection closed unexpectedly"));
    socket.on("data", onData);
    socket.on("error", fail);
    socket.on("close", onClose);
    socket.setTimeout(20_000, () => fail(new Error("SMTP timed out")));
    this.handlers = { data: onData, error: fail, close: onClose };
  }

  /** Stops reading the raw socket so a TLS wrapper can take it over. */
  detach(): void {
    if (!this.handlers) return;
    this.socket.off("data", this.handlers.data);
    this.socket.off("error", this.handlers.error);
    this.socket.off("close", this.handlers.close);
    this.handlers = null;
  }

  upgrade(socket: net.Socket): void {
    this.socket = socket;
    this.buffer = "";
    this.lines = [];
    this.failure = null;
    this.attach(socket);
  }

  private nextLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.failWaiters.push(reject);
    });
  }

  /** Reads one (possibly multi-line) reply and enforces the expected class. */
  async reply(expectPrefix: string): Promise<string[]> {
    const collected: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      collected.push(line);
      if (line.length < 4 || line[3] !== "-") break;
    }
    const last = collected[collected.length - 1] ?? "";
    if (!last.startsWith(expectPrefix)) throw new Error(`SMTP error: ${last.slice(0, 120)}`);
    return collected;
  }

  async command(text: string, expectPrefix: string): Promise<string[]> {
    this.socket.write(`${text}\r\n`);
    return this.reply(expectPrefix);
  }
}

export function parseSmtpUrl(value: string): { secure: boolean; host: string; port: number; user: string | null; pass: string | null } {
  const url = new URL(value);
  const secure = url.protocol === "smtps:";
  if (!secure && url.protocol !== "smtp:") throw new Error("SMTP_URL must start with smtp:// or smtps://");
  return {
    secure,
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    user: url.username ? decodeURIComponent(url.username) : null,
    pass: url.password ? decodeURIComponent(url.password) : null,
  };
}

function smtpSender(smtpUrl: string, from: string): EmailSender {
  return {
    mode: "smtp",
    async send(message) {
      const config = parseSmtpUrl(smtpUrl);
      const raw = await new Promise<net.Socket>((resolve, reject) => {
        const socket = config.secure
          ? tls.connect({ host: config.host, port: config.port, servername: config.host }, () => resolve(socket))
          : net.connect({ host: config.host, port: config.port }, () => resolve(socket));
        socket.once("error", reject);
      });
      const connection = new SmtpConnection(raw);
      try {
        await connection.reply("220");
        const hello = os.hostname().replace(/[^a-zA-Z0-9.-]/g, "") || "localhost";
        let capabilities = await connection.command(`EHLO ${hello}`, "250");
        if (!config.secure && capabilities.some((line) => /STARTTLS/i.test(line))) {
          await connection.command("STARTTLS", "220");
          connection.detach();
          const upgraded = tls.connect({ socket: connection.socket, servername: config.host });
          await new Promise<void>((resolve, reject) => {
            upgraded.once("secureConnect", () => resolve());
            upgraded.once("error", reject);
          });
          connection.upgrade(upgraded);
          capabilities = await connection.command(`EHLO ${hello}`, "250");
        }
        if (config.user && config.pass !== null) {
          const credentials = Buffer.from(`\0${config.user}\0${config.pass}`).toString("base64");
          await connection.command(`AUTH PLAIN ${credentials}`, "235");
        }
        const address = (value: string): string => `<${clean(value).replace(/[<>]/g, "")}>`;
        const fromAddress = /<([^>]+)>/.exec(from)?.[1] ?? from;
        await connection.command(`MAIL FROM:${address(fromAddress)}`, "250");
        await connection.command(`RCPT TO:${address(message.to)}`, "250");
        await connection.command("DATA", "354");
        const body = message.text
          .replace(/\r?\n/g, "\r\n")
          .split("\r\n")
          .map((line) => (line.startsWith(".") ? `.${line}` : line))
          .join("\r\n");
        const encodedSubject = /^[\x20-\x7e]*$/.test(message.subject)
          ? clean(message.subject)
          : `=?UTF-8?B?${Buffer.from(clean(message.subject)).toString("base64")}?=`;
        const payload = [
          `From: ${clean(from)}`,
          `To: ${clean(message.to)}`,
          `Subject: ${encodedSubject}`,
          `Date: ${new Date().toUTCString()}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: 8bit",
          "",
          body,
          ".",
        ].join("\r\n");
        await connection.command(payload, "250");
        await connection.command("QUIT", "221").catch(() => undefined);
      } finally {
        connection.socket.destroy();
      }
    },
  };
}
