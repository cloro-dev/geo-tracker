import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchTask, mapTaskStatus, submitTask } from "./cloro";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fail = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CLORO_API_KEY = "sk_test_key";
  process.env.CLORO_API_URL = "https://api.example.com";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLORO_API_KEY;
  delete process.env.CLORO_API_URL;
});

describe("submitTask", () => {
  it("posts an async task and returns the task id", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "task_1" } }));

    const id = await submitTask("chatgpt", "who sells CRMs?", "US", {
      webhookUrl: "https://tracker.example.com/api/webhook?token=abc",
    });

    expect(id).toBe("task_1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.example.com/v1/async/task");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer sk_test_key");

    expect(JSON.parse(init.body)).toEqual({
      taskType: "CHATGPT",
      payload: { prompt: "who sells CRMs?", country: "US" },
      webhook: { url: "https://tracker.example.com/api/webhook?token=abc" },
    });
  });

  it("omits the webhook when there is no public URL", async () => {
    fetchMock.mockResolvedValue(ok({ task: { id: "task_2" } }));
    await submitTask("google", "crm tools", "US");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty(
      "webhook",
    );
  });

  // A run must never look successful when cloro refused it, or the row
  // would sit pending forever waiting for a webhook that cannot arrive.
  it("surfaces the cloro error envelope", async () => {
    fetchMock.mockResolvedValue(
      fail(401, {
        error: { code: "INVALID_API_KEY_FORMAT", message: "Invalid API key" },
      }),
    );

    await expect(submitTask("chatgpt", "x", "US")).rejects.toThrow(
      /401.*INVALID_API_KEY_FORMAT.*Invalid API key/,
    );
  });

  it("fails loudly when the response carries no task id", async () => {
    fetchMock.mockResolvedValue(ok({ task: {} }));
    await expect(submitTask("chatgpt", "x", "US")).rejects.toThrow(
      /no task id/i,
    );
  });

  it("wraps network failures with the path", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(submitTask("chatgpt", "x", "US")).rejects.toThrow(
      /\/v1\/async\/task.*ECONNRESET/,
    );
  });
});

describe("mapTaskStatus", () => {
  it("treats only terminal states as finished", () => {
    expect(mapTaskStatus("COMPLETED")).toBe("completed");
    expect(mapTaskStatus("FAILED")).toBe("failed");
    expect(mapTaskStatus("QUEUED")).toBe("pending");
    expect(mapTaskStatus("RUNNING")).toBe("pending");
    expect(mapTaskStatus(undefined)).toBe("pending");
  });
});

describe("fetchTask", () => {
  it("returns the response and credits of a finished task", async () => {
    fetchMock.mockResolvedValue(
      ok({
        task: { id: "task_1", status: "COMPLETED" },
        credits: { creditsCharged: 5 },
        response: { text: "an answer" },
      }),
    );

    await expect(fetchTask("task_1")).resolves.toEqual({
      status: "completed",
      response: { text: "an answer" },
      creditsCharged: 5,
    });
  });

  it("reports a still-running task as pending with no credits", async () => {
    fetchMock.mockResolvedValue(ok({ task: { status: "RUNNING" } }));
    await expect(fetchTask("task_1")).resolves.toEqual({
      status: "pending",
      response: null,
      creditsCharged: 0,
    });
  });

  it("url-encodes the task id", async () => {
    fetchMock.mockResolvedValue(ok({ task: { status: "QUEUED" } }));
    await fetchTask("a b/c");
    expect(String(fetchMock.mock.calls[0][0])).toContain("a%20b%2Fc");
  });
});
