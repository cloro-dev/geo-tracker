import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  verifyWebhookSignature,
  verifyWebhookToken,
  webhookCallbackUrl,
} from "./webhooks";

const SECRET = "s3cret";

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  process.env.APP_URL = "https://tracker.example.com";
  delete process.env.CLORO_WEBHOOK_SECRET;
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.APP_URL;
  delete process.env.CLORO_WEBHOOK_SECRET;
});

function tokenFrom(url: string): string {
  return new URL(url).searchParams.get("token")!;
}

describe("webhookCallbackUrl", () => {
  it("points at the webhook route on the public URL", () => {
    const url = new URL(webhookCallbackUrl()!);
    expect(url.origin).toBe("https://tracker.example.com");
    expect(url.pathname).toBe("/api/webhook");
  });

  // The URL is handed to cloro and stored on their side. If it carried the
  // secret, anyone who saw it would hold the API token as well.
  it("never puts the secret in the URL", () => {
    expect(webhookCallbackUrl()).not.toContain(SECRET);
  });

  it("returns null without a public URL, so tasks fall back to polling", () => {
    delete process.env.APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    expect(webhookCallbackUrl()).toBeNull();
  });

  it("strips a trailing slash from APP_URL", () => {
    process.env.APP_URL = "https://tracker.example.com/";
    expect(webhookCallbackUrl()).toContain("https://tracker.example.com/api/");
  });
});

describe("verifyWebhookToken", () => {
  it("accepts the token it issued", () => {
    expect(verifyWebhookToken(tokenFrom(webhookCallbackUrl()!))).toBe(true);
  });

  it("rejects the raw secret", () => {
    expect(verifyWebhookToken(SECRET)).toBe(false);
  });

  it("rejects a missing or wrong token", () => {
    expect(verifyWebhookToken(null)).toBe(false);
    expect(verifyWebhookToken("")).toBe(false);
    expect(verifyWebhookToken("deadbeef")).toBe(false);
  });

  it("changes when the secret is rotated", () => {
    const before = tokenFrom(webhookCallbackUrl()!);
    process.env.CRON_SECRET = "rotated";
    expect(verifyWebhookToken(before)).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  const body = '{"task":{"id":"t1"}}';
  const sign = (timestamp: number, secret = "whsec", payload = body) =>
    createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

  it("passes everything through when signing is not configured", () => {
    expect(verifyWebhookSignature(body, null, null)).toBe(true);
  });

  it("accepts a valid signature", () => {
    process.env.CLORO_WEBHOOK_SECRET = "whsec";
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(body, String(ts), `v1=${sign(ts)}`)).toBe(
      true,
    );
  });

  it("accepts a signature without the v1 prefix", () => {
    process.env.CLORO_WEBHOOK_SECRET = "whsec";
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(body, String(ts), sign(ts))).toBe(true);
  });

  it("rejects a tampered body", () => {
    process.env.CLORO_WEBHOOK_SECRET = "whsec";
    const ts = Math.floor(Date.now() / 1000);
    expect(
      verifyWebhookSignature('{"task":{"id":"t2"}}', String(ts), sign(ts)),
    ).toBe(false);
  });

  it("rejects the wrong signing secret", () => {
    process.env.CLORO_WEBHOOK_SECRET = "whsec";
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(body, String(ts), sign(ts, "other"))).toBe(
      false,
    );
  });

  // Without this a captured delivery could be replayed forever.
  it("rejects a stale timestamp", () => {
    process.env.CLORO_WEBHOOK_SECRET = "whsec";
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(
      verifyWebhookSignature(body, String(stale), `v1=${sign(stale)}`),
    ).toBe(false);
  });

  it("rejects missing headers once signing is configured", () => {
    process.env.CLORO_WEBHOOK_SECRET = "whsec";
    expect(verifyWebhookSignature(body, null, null)).toBe(false);
    expect(verifyWebhookSignature(body, "not-a-number", "v1=abc")).toBe(false);
  });
});
