import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  applyMigrations,
  closeDatabase,
  hasDatabase,
  resetTables,
} from "../test/db";
import { getDb } from "./db";
import { prompts, results, type Prompt } from "./db/schema";
import {
  completeResult,
  runTick,
  submitPromptOnce,
  sweepPending,
} from "./runner";

const HOUR = 60 * 60 * 1000;

let taskCounter = 0;
let fetchMock: ReturnType<typeof vi.fn>;

/** Stands in for the cloro API: submissions succeed, polls stay queued. */
function stubCloro(overrides: { pollStatus?: string } = {}) {
  fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const href = String(url);
    if (init?.method === "POST") {
      return Response.json({ task: { id: `task_${++taskCounter}` } });
    }
    return Response.json({
      task: {
        id: href.split("/").pop(),
        status: overrides.pollStatus ?? "QUEUED",
      },
      credits: { creditsCharged: 3 },
      response: { text: "an answer" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function insertPrompt(overrides: Partial<Prompt> = {}): Promise<Prompt> {
  const [row] = await getDb()
    .insert(prompts)
    .values({
      name: overrides.name ?? "best crm tools",
      prompt: overrides.prompt ?? "What are the best CRM tools?",
      engines: overrides.engines ?? ["chatgpt"],
      country: overrides.country ?? "US",
      runsPerDay: overrides.runsPerDay ?? 1,
      enabled: overrides.enabled ?? true,
      lastRunAt: overrides.lastRunAt ?? null,
    })
    .returning();
  return row;
}

describe.skipIf(!hasDatabase)("runner (needs a database)", () => {
  beforeAll(async () => {
    process.env.CLORO_API_KEY = "sk_test_key";
    process.env.CLORO_API_URL = "https://api.example.com";
    process.env.CRON_SECRET = "s3cret";
    process.env.APP_URL = "https://tracker.example.com";
    await applyMigrations();
  });

  afterAll(closeDatabase);

  beforeEach(async () => {
    taskCounter = 0;
    await resetTables();
    stubCloro();
  });

  afterEach(() => vi.unstubAllGlobals());

  describe("submitPromptOnce", () => {
    it("records one pending row per engine", async () => {
      const prompt = await insertPrompt({ engines: ["chatgpt", "gemini"] });
      const submitted = await submitPromptOnce(prompt);

      expect(submitted).toHaveLength(2);
      expect(submitted.every((r) => r.status === "pending")).toBe(true);
      expect(new Set(submitted.map((r) => r.taskId)).size).toBe(2);
    });

    // A failed submission must not look pending, or the row waits forever
    // for a webhook that will never arrive.
    it("stores a failed row when cloro rejects the submission", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { error: { code: "INSUFFICIENT_CREDITS", message: "no credits" } },
            { status: 402 },
          ),
        ),
      );

      const prompt = await insertPrompt();
      const [row] = await submitPromptOnce(prompt);

      expect(row.status).toBe("failed");
      expect(row.taskId).toBeNull();
      expect(row.error).toMatch(/INSUFFICIENT_CREDITS/);
    });

    it("isolates engines so one failure does not lose the others", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: URL | string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          return body.taskType === "GEMINI"
            ? Response.json({ error: { message: "boom" } }, { status: 500 })
            : Response.json({ task: { id: `task_${++taskCounter}` } });
        }),
      );

      const prompt = await insertPrompt({ engines: ["chatgpt", "gemini"] });
      const submitted = await submitPromptOnce(prompt);

      expect(submitted.find((r) => r.engine === "chatgpt")?.status).toBe(
        "pending",
      );
      expect(submitted.find((r) => r.engine === "gemini")?.status).toBe(
        "failed",
      );
    });
  });

  describe("runTick due-logic", () => {
    it("runs a prompt that has never run", async () => {
      await insertPrompt();
      const summary = await runTick();
      expect(summary.submitted).toHaveLength(1);
    });

    it("skips a prompt that ran within its interval", async () => {
      await insertPrompt({ runsPerDay: 1, lastRunAt: new Date() });
      expect((await runTick()).submitted).toHaveLength(0);
    });

    it("runs again once the interval has passed", async () => {
      // 4 runs a day is a 6h interval; 7h ago is due.
      await insertPrompt({
        runsPerDay: 4,
        lastRunAt: new Date(Date.now() - 7 * HOUR),
      });
      expect((await runTick()).submitted).toHaveLength(1);
    });

    it("does not run a 4x-daily prompt only 2h after its last run", async () => {
      await insertPrompt({
        runsPerDay: 4,
        lastRunAt: new Date(Date.now() - 2 * HOUR),
      });
      expect((await runTick()).submitted).toHaveLength(0);
    });

    // A tick firing slightly early must still count, or an hourly schedule
    // drifts a whole interval every day.
    it("allows a five minute slack for tick jitter", async () => {
      await insertPrompt({
        runsPerDay: 24,
        lastRunAt: new Date(Date.now() - (HOUR - 3 * 60 * 1000)),
      });
      expect((await runTick()).submitted).toHaveLength(1);
    });

    it("ignores disabled prompts", async () => {
      await insertPrompt({ enabled: false });
      expect((await runTick()).submitted).toHaveLength(0);
    });

    it("stamps lastRunAt when it claims a prompt", async () => {
      const prompt = await insertPrompt();
      await runTick();
      const [after] = await getDb()
        .select()
        .from(prompts)
        .where(eq(prompts.id, prompt.id));
      expect(after.lastRunAt).not.toBeNull();
    });

    // Two schedulers can overlap (Vercel Cron plus a GitHub Actions tick).
    // Double submission would silently double the cloro bill.
    it("submits once when two ticks run concurrently", async () => {
      await insertPrompt({ engines: ["chatgpt"] });

      const [first, second] = await Promise.all([runTick(), runTick()]);
      const claimed = first.submitted.length + second.submitted.length;

      expect(claimed).toBe(1);
      const rows = await getDb().select().from(results);
      expect(rows).toHaveLength(1);
    });
  });

  describe("completeResult", () => {
    async function pendingRow() {
      const prompt = await insertPrompt();
      const [row] = await submitPromptOnce(prompt);
      return row;
    }

    it("stores the answer, credits and completion time", async () => {
      const row = await pendingRow();

      const applied = await completeResult(row.taskId!, {
        status: "completed",
        response: { text: "an answer" },
        creditsCharged: 5,
        error: null,
      });

      expect(applied).toBe(true);
      const [stored] = await getDb()
        .select()
        .from(results)
        .where(eq(results.id, row.id));
      expect(stored.status).toBe("completed");
      expect(stored.response).toEqual({ text: "an answer" });
      expect(stored.creditsCharged).toBe(5);
      expect(stored.completedAt).not.toBeNull();
    });

    // cloro retries webhooks, and the sweep may race a delivery.
    it("applies once and reports later duplicates as not applied", async () => {
      const row = await pendingRow();
      const outcome = {
        status: "completed" as const,
        response: { text: "first" },
        creditsCharged: 5,
        error: null,
      };

      expect(await completeResult(row.taskId!, outcome)).toBe(true);
      expect(
        await completeResult(row.taskId!, {
          ...outcome,
          response: { text: "second" },
        }),
      ).toBe(false);

      const [stored] = await getDb()
        .select()
        .from(results)
        .where(eq(results.id, row.id));
      expect(stored.response).toEqual({ text: "first" });
    });

    it("ignores an unknown task id", async () => {
      expect(
        await completeResult("task_does_not_exist", {
          status: "completed",
          response: {},
          creditsCharged: 0,
          error: null,
        }),
      ).toBe(false);
    });
  });

  describe("sweepPending", () => {
    async function agePendingRow(ms: number) {
      const prompt = await insertPrompt();
      const [row] = await submitPromptOnce(prompt);
      await getDb()
        .update(results)
        .set({ createdAt: new Date(Date.now() - ms) })
        .where(eq(results.id, row.id));
      return row;
    }

    it("leaves young rows to the webhook", async () => {
      await agePendingRow(60 * 1000);
      expect((await sweepPending()).checked).toBe(0);
    });

    it("polls stale rows and applies a finished result", async () => {
      vi.unstubAllGlobals();
      stubCloro({ pollStatus: "COMPLETED" });
      const row = await agePendingRow(20 * 60 * 1000);

      const sweep = await sweepPending();
      expect(sweep.checked).toBe(1);
      expect(sweep.updated).toBe(1);

      const [stored] = await getDb()
        .select()
        .from(results)
        .where(eq(results.id, row.id));
      expect(stored.status).toBe("completed");
      expect(stored.creditsCharged).toBe(3);
    });

    it("leaves a still-queued row pending", async () => {
      await agePendingRow(20 * 60 * 1000);
      const sweep = await sweepPending();
      expect(sweep.checked).toBe(1);
      expect(sweep.updated).toBe(0);
      expect(sweep.timedOut).toBe(0);
    });

    it("gives up on a row that has been pending for over a day", async () => {
      const row = await agePendingRow(25 * HOUR);

      const sweep = await sweepPending();
      expect(sweep.timedOut).toBe(1);

      const [stored] = await getDb()
        .select()
        .from(results)
        .where(eq(results.id, row.id));
      expect(stored.status).toBe("failed");
      expect(stored.error).toMatch(/timed out/i);
    });
  });
});
