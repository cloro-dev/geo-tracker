import { afterEach, describe, expect, it } from "vitest";

import { isApiKeyAuthorized, isCronAuthorized, unauthorized } from "./auth";

const bearer = (token: string) =>
  new Request("https://example.com/api/prompts", {
    headers: { authorization: `Bearer ${token}` },
  });

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.APP_API_KEY;
});

// A deployment created by the deploy button has CRON_SECRET and nothing
// else, so this is the configuration almost everyone runs.
describe("with only CRON_SECRET set", () => {
  it("authorises the API with the cron secret", () => {
    process.env.CRON_SECRET = "one-secret";
    expect(isApiKeyAuthorized(bearer("one-secret"))).toBe(true);
    expect(isCronAuthorized(bearer("one-secret"))).toBe(true);
  });

  it("rejects anything else", () => {
    process.env.CRON_SECRET = "one-secret";
    expect(isApiKeyAuthorized(bearer("wrong"))).toBe(false);
    expect(isCronAuthorized(bearer("wrong"))).toBe(false);
  });
});

describe("with APP_API_KEY set as an override", () => {
  it("uses APP_API_KEY for the API and keeps cron on either", () => {
    process.env.CRON_SECRET = "cron";
    process.env.APP_API_KEY = "api";

    expect(isApiKeyAuthorized(bearer("api"))).toBe(true);
    expect(isApiKeyAuthorized(bearer("cron"))).toBe(false);

    // Vercel Cron sends CRON_SECRET; a human triggering a tick by hand
    // reaches for the API token. Both have to work.
    expect(isCronAuthorized(bearer("cron"))).toBe(true);
    expect(isCronAuthorized(bearer("api"))).toBe(true);
  });
});

describe("with only APP_API_KEY set", () => {
  it("still authorises both surfaces", () => {
    process.env.APP_API_KEY = "api";
    expect(isApiKeyAuthorized(bearer("api"))).toBe(true);
    expect(isCronAuthorized(bearer("api"))).toBe(true);
  });
});

describe("header parsing", () => {
  it("rejects a missing or malformed authorization header", () => {
    process.env.CRON_SECRET = "one-secret";
    const req = (headers?: HeadersInit) =>
      new Request("https://example.com/api/prompts", { headers });

    expect(isApiKeyAuthorized(req())).toBe(false);
    expect(isApiKeyAuthorized(req({ authorization: "one-secret" }))).toBe(
      false,
    );
    expect(isApiKeyAuthorized(req({ authorization: "Basic one-secret" }))).toBe(
      false,
    );
    expect(isApiKeyAuthorized(req({ authorization: "Bearer " }))).toBe(false);
  });

  it("does not accept a token that merely starts with the secret", () => {
    process.env.CRON_SECRET = "one-secret";
    expect(isApiKeyAuthorized(bearer("one-secret-extra"))).toBe(false);
  });
});

describe("unauthorized", () => {
  it("returns the documented 401 envelope", async () => {
    const res = unauthorized();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { message: "Unauthorized" },
    });
  });
});
