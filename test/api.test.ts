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

import {
  DELETE as brandDelete,
  PATCH as brandPatch,
} from "../app/api/brands/[id]/route";
import { GET as brandsGet, POST as brandsPost } from "../app/api/brands/route";
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

const webhookToken = () =>
  createHmac("sha256", SECRET)
    .update("geo-tracker:webhook")
    .digest("hex")
    .slice(0, 32);

/** A completed-task delivery carrying a ChatGPT-shaped answer. */
const completedWebhook = (taskId: string, text: string) =>
  new Request(`${BASE}/api/webhook?token=${webhookToken()}`, {
    method: "POST",
    body: JSON.stringify({
      task: { id: taskId, status: "COMPLETED" },
      credits: { creditsCharged: 1 },
      response: { success: true, result: { text, sources: [] } },
    }),
  });

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

async function createBrand(body: Record<string, unknown> = {}) {
  const res = await brandsPost(
    authed("/api/brands", {
      method: "POST",
      body: JSON.stringify({ name: "Acme", ...body }),
    }),
    params(""),
  );
  return {
    res,
    body: (await res.json()) as {
      brand: { id: string };
      queuedForExtraction: number;
    },
  };
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
    const token = webhookToken;

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
      // Nothing is configured, so the refresh declines to derive anything.
      expect(summary.refresh).toMatchObject({ extracted: 0, skipped: true });
    });
  });

  describe("brands", () => {
    it("creates a brand and returns 201", async () => {
      const { res, body } = await createBrand({ domains: ["acme.io"] });
      expect(res.status).toBe(201);
      expect(body.brand).toMatchObject({ name: "Acme", isOwn: false });
    });

    it("normalises a domain to a bare lowercase host", async () => {
      const { body } = await createBrand({ domains: ["WWW.Acme.IO"] });
      expect(body.brand).toMatchObject({ domains: ["acme.io"] });
    });

    it("rejects a URL where a domain belongs", async () => {
      const { res } = await createBrand({ domains: ["https://acme.io/blog"] });
      expect(res.status).toBe(400);
    });

    it("treats a name that differs only in case as the same brand", async () => {
      await createBrand({ name: "Acme" });
      const { res } = await createBrand({ name: "acme" });
      expect(res.status).toBe(409);
    });

    it("lists brands by name", async () => {
      await createBrand({ name: "Globex" });
      await createBrand({ name: "Acme" });
      const res = await brandsGet(authed("/api/brands"), params(""));
      const body = (await res.json()) as { brands: { name: string }[] };
      expect(body.brands.map((b) => b.name)).toEqual(["Acme", "Globex"]);
    });

    it("queues the stored history when a brand is added", async () => {
      await createPrompt();
      await cronGet(authed("/api/cron"), params(""));
      await webhookPost(completedWebhook("task_1", "Acme wins."), params(""));

      const { body } = await createBrand();
      expect(body.queuedForExtraction).toBe(1);

      // The next tick derives it, so the brand's chart starts full.
      const res = await cronGet(authed("/api/cron"), params(""));
      const summary = await res.json();
      expect(summary.refresh).toMatchObject({ extracted: 1, skipped: false });
    });

    it("re-queues history when an edit changes what is matched", async () => {
      await createPrompt();
      await cronGet(authed("/api/cron"), params(""));
      await webhookPost(completedWebhook("task_1", "Acme wins."), params(""));
      const { body } = await createBrand();
      await cronGet(authed("/api/cron"), params(""));

      const res = await brandPatch(
        authed(`/api/brands/${body.brand.id}`, {
          method: "PATCH",
          body: JSON.stringify({ aliases: ["Acme Corp"] }),
        }),
        params(body.brand.id),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        queuedForExtraction: 1,
      });
    });

    it("does not re-queue history for a label-only edit", async () => {
      await createPrompt();
      await cronGet(authed("/api/cron"), params(""));
      await webhookPost(completedWebhook("task_1", "Acme wins."), params(""));
      const { body } = await createBrand();

      const res = await brandPatch(
        authed(`/api/brands/${body.brand.id}`, {
          method: "PATCH",
          body: JSON.stringify({ isOwn: true }),
        }),
        params(body.brand.id),
      );
      await expect(res.json()).resolves.toMatchObject({
        brand: { isOwn: true },
        queuedForExtraction: 0,
      });
    });

    it("404s on an unknown brand and 400s on a malformed id", async () => {
      const missing = await brandDelete(
        authed("/api/brands/00000000-0000-4000-8000-000000000000", {
          method: "DELETE",
        }),
        params("00000000-0000-4000-8000-000000000000"),
      );
      expect(missing.status).toBe(404);

      const malformed = await brandDelete(
        authed("/api/brands/nope", { method: "DELETE" }),
        params("nope"),
      );
      expect(malformed.status).toBe(400);
    });
  });
});
