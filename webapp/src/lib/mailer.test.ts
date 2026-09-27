import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emailDeliveryMode, emailIsDeliverable, getEmailSender, parseSmtpUrl } from "./mailer";

const env = (values: Record<string, string | undefined>) => ({
  EMAIL_FROM: values.EMAIL_FROM,
  RESEND_API_KEY: values.RESEND_API_KEY,
  SMTP_URL: values.SMTP_URL,
  NODE_ENV: values.NODE_ENV,
});

afterEach(() => vi.restoreAllMocks());

describe("email transport selection", () => {
  it("selects configured Resend or SMTP and fails closed in production", () => {
    expect(emailDeliveryMode(env({ EMAIL_FROM: " team@example.com ", RESEND_API_KEY: " key " }))).toBe("resend");
    expect(emailDeliveryMode(env({ EMAIL_FROM: "team@example.com", SMTP_URL: "smtp://mail.example.com" }))).toBe("smtp");
    expect(emailDeliveryMode(env({ NODE_ENV: "production", SMTP_URL: "smtp://mail.example.com" }))).toBe("none");
    expect(emailIsDeliverable(env({ EMAIL_FROM: "team@example.com", SMTP_URL: "smtp://mail.example.com" }))).toBe(true);
    expect(emailIsDeliverable(env({ NODE_ENV: "development" }))).toBe(false);
    expect(getEmailSender(env({ NODE_ENV: "production" }))).toBeNull();
    expect(getEmailSender(env({ NODE_ENV: "test" }))?.mode).toBe("console");
  });

  it("parses default ports, TLS scheme, and percent-encoded SMTP credentials", () => {
    expect(parseSmtpUrl("smtp://mail.example.com")).toEqual({
      secure: false, host: "mail.example.com", port: 587, user: null, pass: null,
    });
    expect(parseSmtpUrl("smtps://user%40example.com:p%40ss@mail.example.com")).toEqual({
      secure: true, host: "mail.example.com", port: 465, user: "user@example.com", pass: "p@ss",
    });
    expect(parseSmtpUrl("smtp://mail.example.com:2525").port).toBe(2525);
    expect(() => parseSmtpUrl("https://mail.example.com")).toThrow("SMTP_URL must start with smtp:// or smtps://");
  });

  it("sends through Resend with sanitized headers and rejects provider errors", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    const sender = getEmailSender(env({ EMAIL_FROM: "Team\n<team@example.com>", RESEND_API_KEY: " secret " }));
    expect(sender?.mode).toBe("resend");
    await sender!.send({ to: "alice@example.com\r\nBcc:bad@example.com", subject: " Verify\naccount ", text: "Click the link" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.resend.com/emails");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ from: "Team <team@example.com>", to: ["alice@example.com Bcc:bad@example.com"], subject: "Verify account", text: "Click the link" }),
    });
    await expect(sender!.send({ to: "a@example.com", subject: "Test", text: "body" })).rejects.toThrow("Resend rejected the message (HTTP 429)");
  });

  it("keeps the console fallback clearly labeled as development-only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sender = getEmailSender(env({ NODE_ENV: "development" }));
    expect(sender?.mode).toBe("console");
    await sender!.send({ to: "alice\nBcc:bad@example.com", subject: "Hello\rworld", text: "body" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DEV ONLY — email NOT sent"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("To: alice Bcc:bad@example.com"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Subject: Hello world"));
  });
});

describe("SMTP delivery", () => {
  it("uses multiline replies, AUTH PLAIN, safe addresses, encoded subjects, and dot-stuffed bodies", async () => {
    const commands: string[] = [];
    let dataMode = false;
    let dataLines: string[] = [];
    const server = net.createServer((socket) => {
      socket.write("220 local test server\r\n");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (dataMode) {
            if (line === ".") {
              dataMode = false;
              commands.push(`BODY:${dataLines.join("\\n")}`);
              dataLines = [];
              socket.write("250 queued\r\n");
            } else dataLines.push(line);
            continue;
          }
          commands.push(line);
          if (line.startsWith("EHLO ")) socket.write("250-localhost\r\n250 SIZE 100000\r\n");
          else if (line.startsWith("AUTH PLAIN ")) socket.write("235 authenticated\r\n");
          else if (line === "DATA") { dataMode = true; socket.write("354 send data\r\n"); }
          else if (line === "QUIT") socket.write("221 goodbye\r\n");
          else socket.write("250 accepted\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test SMTP server did not bind a TCP port");
    try {
      const sender = getEmailSender(env({
        EMAIL_FROM: "Notetaker <team@example.com>",
        SMTP_URL: `smtp://mailer%40example.com:p%40ss@127.0.0.1:${address.port}`,
      }));
      expect(sender?.mode).toBe("smtp");
      await sender!.send({ to: "alice@example.com", subject: "Verify ✓", text: "First line\n.leading dot\nLast" });
      expect(commands.some((command) => command.startsWith("AUTH PLAIN "))).toBe(true);
      expect(commands).toContain("MAIL FROM:<team@example.com>");
      expect(commands).toContain("RCPT TO:<alice@example.com>");
      const body = commands.find((command) => command.startsWith("BODY:")) ?? "";
      expect(body).toContain("Subject: =?UTF-8?B?");
      expect(body).toContain("\\n..leading dot");
      expect(commands.at(-1)).toBe("QUIT");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
