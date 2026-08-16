/**
 * Exercises the route handlers directly, without starting a server: they
 * are plain (Request) => Response functions, so this covers auth, status
 * codes and the response envelope the README documents.
 */
import { createHmac } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { GET as cronGet } from "../app/api/cron/route";
import { DELETE, GET as promptGet, PATCH } from "../app/api/prompts/[id]/route";
import { POST as runPost } from "../app/api/prompts/[id]/run/route";
import {
  GET as promptsGet,
  POST as promptsPost,
} from "../app/api/prompts/route";
import { GET as resultsGet } from "../app/api/results/route";
import { POST as webhookPost } from "../app/api/webhook/route";
import { applyMigrations, closeDatabase, hasDatabase, resetTables } from "./db";

const SECRET = "s3cret";
const BASE = "https://tracker.example.com";

const authed = (path: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${SECRET}`, ...(init.headers ?? {}) },
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function createPrompt(body: Record<string, unknown> = {}) {
  const res = await promptsPost(
    authed("/api/prompts", {
      method: "POST",
      body: JSON.stringify({
        name: "best crm tools",
        prompt: "What are the best CRM tools?",
        engines: ["chatgpt"],
        ...body,
      }),
    }),
    params(""),
  );
  return { res, body: (await res.json()) as { prompt: { id: string } } };
}

describe.skipIf(!hasDatabase)("API routes (need a database)", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = SECRET;
    process.env.CLORO_API_KEY = "sk_test_key";
    process.env.CLORO_API_URL = "https://api.example.com";
    process.env.APP_URL = BASE;
    await applyMigrations();
  });

  afterAll(closeDatabase);

  beforeEach(async () => {
    await resetTables();
    // Task ids must be unique per submission: results.task_id is unique, so
    // a stub that repeats one would fail the insert for the whole run.
    let taskCounter = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ task: { id: `task_${++taskCounter}` } }),
      ),
    );
  });

  describe("auth", () => {
    it("rejects every endpoint without a token", async () => {
      const anon = (path: string) => new Request(`${BASE}${path}`);
      for (const res of await Promise.all([
        promptsGet(anon("/api/prompts"), params("")),
        resultsGet(anon("/api/results"), params("")),
        cronGet(anon("/api/cron"), params("")),
      ])) {
        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toEqual({
          error: { message: "Unauthorized" },
        });
      }
    });
  });

  describe("prompts", () => {
    it("creates a prompt and returns 201", async () => {
      const { res, body } = await createPrompt();
      expect(res.status).toBe(201);
      expect(body.prompt).toMatchObject({ name: "best crm tools" });
    });

    it("rejects an invalid body with 400 and says why", async () => {
      const res = await promptsPost(
        authed("/api/prompts", {
          method: "POST",
          body: JSON.stringify({ name: "x", prompt: "y", engines: ["bing"] }),
        }),
        params(""),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/engines/);
    });

    it("rejects a body that is not JSON", async () => {
      const res = await promptsPost(
        authed("/api/prompts", { method: "POST", body: "not json" }),
        params(""),
      );
      expect(res.status).toBe(400);
    });

    it("gets, patches and deletes one prompt", async () => {
      const { body } = await createPrompt();
      const id = body.prompt.id;

      expect(
        (await promptGet(authed(`/api/prompts/${id}`), params(id))).status,
      ).toBe(200);

      const patched = await PATCH(
        authed(`/api/prompts/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
        }),
        params(id),
      );
      expect((await patched.json()).prompt.enabled).toBe(false);

      expect(
        (await DELETE(authed(`/api/prompts/${id}`), params(id))).status,
      ).toBe(200);
      expect(
        (await promptGet(authed(`/api/prompts/${id}`), params(id))).status,
      ).toBe(404);
    });

    it("404s an unknown id and 400s a malformed one", async () => {
      const missing = "11111111-1111-4111-8111-111111111111";
      expect(
        (await promptGet(authed(`/api/prompts/${missing}`), params(missing)))
          .status,
      ).toBe(404);
      expect(
        (await promptGet(authed("/api/prompts/nope"), params("nope"))).status,
      ).toBe(400);
    });
  });

  describe("run and results", () => {
    it("submits on demand and returns 202 with pending rows", async () => {
      const { body } = await createPrompt();
      const res = await runPost(
        authed(`/api/prompts/${body.prompt.id}/run`, { method: "POST" }),
        params(body.prompt.id),
      );

      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.results[0]).toMatchObject({
        status: "pending",
        engine: "chatgpt",
      });
    });

    // The payload is the largest column; listing it by default would make
    // every page of results enormous.
    it("omits the response payload unless asked", async () => {
      const { body } = await createPrompt();
      await runPost(
        authed(`/api/prompts/${body.prompt.id}/run`, { method: "POST" }),
        params(body.prompt.id),
      );

      const list = await (
        await resultsGet(authed("/api/results"), params(""))
      ).json();
      expect(list.results[0]).not.toHaveProperty("response");

      const full = await (
        await resultsGet(authed("/api/results?include=response"), params(""))
      ).json();
      expect(full.results[0]).toHaveProperty("response");
    });

    it("filters by engine and status", async () => {
      const { body } = await createPrompt({ engines: ["chatgpt", "gemini"] });
      await runPost(
        authed(`/api/prompts/${body.prompt.id}/run`, { method: "POST" }),
        params(body.prompt.id),
      );

      const byEngine = await (
        await resultsGet(authed("/api/results?engine=gemini"), params(""))
      ).json();
      expect(byEngine.results).toHaveLength(1);

      const byStatus = await (
        await resultsGet(authed("/api/results?status=completed"), params(""))
      ).json();
      expect(byStatus.results).toHaveLength(0);
    });

    it("rejects an invalid filter with 400", async () => {
      expect(
        (await resultsGet(authed("/api/results?limit=9999"), params("")))
          .status,
      ).toBe(400);
    });
  });

  describe("webhook", () => {
    const token = () =>
      createHmac("sha256", SECRET)
        .update("geo-tracker:webhook")
        .digest("hex")
        .slice(0, 32);

    async function pendingTaskId() {
      const { body } = await createPrompt();
      const res = await runPost(
        authed(`/api/prompts/${body.prompt.id}/run`, { method: "POST" }),
        params(body.prompt.id),
      );
      return (await res.json()).results[0].taskId as string;
    }

    it("rejects a wrong token and the raw secret", async () => {
      for (const bad of ["wrong", SECRET]) {
        const res = await webhookPost(
          new Request(`${BASE}/api/webhook?token=${bad}`, {
            method: "POST",
            body: "{}",
          }),
          params(""),
        );
        expect(res.status).toBe(401);
      }
    });

    it("completes the matching row", async () => {
      const taskId = await pendingTaskId();
      const res = await webhookPost(
        new Request(`${BASE}/api/webhook?token=${token()}`, {
          method: "POST",
          body: JSON.stringify({
            task: { id: taskId, status: "COMPLETED" },
            credits: { creditsCharged: 4 },
            response: { text: "an answer" },
          }),
        }),
        params(""),
      );

      expect(await res.json()).toEqual({ ok: true, applied: true });

      const list = await (
        await resultsGet(authed("/api/results?include=response"), params(""))
      ).json();
      expect(list.results[0]).toMatchObject({
        status: "completed",
        creditsCharged: 4,
      });
    });

    // Answering non-2xx would make cloro retry a delivery we can never use.
    it("accepts an unknown task id without asking for a retry", async () => {
      const res = await webhookPost(
        new Request(`${BASE}/api/webhook?token=${token()}`, {
          method: "POST",
          body: JSON.stringify({
            task: { id: "task_unknown", status: "COMPLETED" },
          }),
        }),
        params(""),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, applied: false });
    });

    it("ignores a delivery for a task that is still running", async () => {
      const taskId = await pendingTaskId();
      const res = await webhookPost(
        new Request(`${BASE}/api/webhook?token=${token()}`, {
          method: "POST",
          body: JSON.stringify({ task: { id: taskId, status: "RUNNING" } }),
        }),
        params(""),
      );
      expect(await res.json()).toEqual({ ok: true, applied: false });
    });
  });

  describe("cron", () => {
    it("returns a tick summary", async () => {
      await createPrompt();
      const res = await cronGet(authed("/api/cron"), params(""));
      expect(res.status).toBe(200);

      const summary = await res.json();
      expect(summary.submitted).toHaveLength(1);
      expect(summary.sweep).toMatchObject({
        checked: 0,
        updated: 0,
        timedOut: 0,
      });
    });
  });
});
