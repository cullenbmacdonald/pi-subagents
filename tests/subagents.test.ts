import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "repo");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return { root, agentDir, cwd };
}

describe("subagents widget", () => {
  it("retains completed async subagents when no jobs are running", async () => {
    const { pruneCompletedSubagentJobsIfIdle } = await import("../extensions/subagents");
    const jobs = new Map<string, { status: string }>([
      ["done", { status: "done" }],
      ["error", { status: "error" }],
      ["cancelled", { status: "cancelled" }],
    ]);

    expect(pruneCompletedSubagentJobsIfIdle(jobs)).toBe(0);
    expect(jobs.size).toBe(3);
  });

  it("bounds retained terminal async subagents by oldest completion", async () => {
    const { pruneCompletedSubagentJobsIfIdle } = await import("../extensions/subagents");
    const jobs = new Map<string, { status: string; endedAt?: number }>([
      ["oldest", { status: "done", endedAt: 1 }],
      ["middle", { status: "error", endedAt: 2 }],
      ["newest", { status: "done", endedAt: 3 }],
    ]);

    expect(pruneCompletedSubagentJobsIfIdle(jobs, 2)).toBe(1);
    expect(Array.from(jobs.keys())).toEqual(["middle", "newest"]);
  });

  it("keeps completed async subagents while another job is running", async () => {
    const { pruneCompletedSubagentJobsIfIdle } = await import("../extensions/subagents");
    const jobs = new Map<string, { status: string }>([
      ["running", { status: "running" }],
      ["done", { status: "done" }],
    ]);

    expect(pruneCompletedSubagentJobsIfIdle(jobs)).toBe(0);
    expect(Array.from(jobs.keys())).toEqual(["running", "done"]);
  });

  it("hides when all async subagents are finished", async () => {
    const { getSubagentWidgetLines } = await import("../extensions/subagents");

    const lines = getSubagentWidgetLines([
      {
        id: "repo-a-review",
        model: "coder",
        tools: "read_only",
        status: "done",
        startedAt: Date.now() - 1000,
        endedAt: Date.now(),
        toolCalls: [{ name: "read", args: { path: "README.md" } }],
      },
    ]);

    expect(lines).toBeUndefined();
  });

  it("shows only running async subagents", async () => {
    const { getSubagentWidgetLines } = await import("../extensions/subagents");

    const lines = getSubagentWidgetLines([
      {
        id: "running-review",
        model: "coder",
        tools: "read_only",
        status: "running",
        startedAt: Date.now() - 1000,
        toolCalls: [{ name: "read", args: { path: "README.md" } }],
      },
      {
        id: "finished-review",
        model: "coder",
        tools: "read_only",
        status: "done",
        startedAt: Date.now() - 2000,
        endedAt: Date.now() - 1000,
        toolCalls: [],
      },
    ]);

    expect(lines).toBeDefined();
    expect(lines?.join("\n")).toContain("#running-review");
    expect(lines?.join("\n")).not.toContain("#finished-review");
  });
});

describe("phase 2 orchestration tools", () => {
  it("registers a synchronous parallel tool and an async wait barrier", async () => {
    const { default: registerSubagents } = await import("../extensions/subagents");
    const tools = new Map<string, any>();
    registerSubagents({
      on: () => {},
      registerCommand: () => {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
    } as any);

    expect(tools.has("subagents_parallel")).toBe(true);
    expect(tools.has("subagents_wait")).toBe(true);
    expect(tools.get("subagents_parallel").description).toContain("wait for every result");

    const result = await tools.get("subagents_wait").execute("wait", { all: true }, undefined, undefined, undefined);
    expect(result.content[0].text).toContain("No active async subagent jobs");
  });
});

describe("subagent waiting", () => {
  it("waits until every selected running job completes", async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstCompletion = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const secondCompletion = new Promise<void>((resolve) => { resolveSecond = resolve; });
    const selected = [
      { status: "running" as const, completion: firstCompletion },
      { status: "running" as const, completion: secondCompletion },
    ];

    const waiting = (await import("../extensions/subagents")).waitForSubagentJobs(selected, 1000);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSecond();
    await expect(waiting).resolves.toBe("completed");
  });

  it("does not wait for jobs that are already terminal", async () => {
    const { waitForSubagentJobs } = await import("../extensions/subagents");
    await expect(waitForSubagentJobs([
      { status: "done", completion: new Promise(() => {}) },
    ], 1000)).resolves.toBe("completed");
  });

  it("returns aborted without cancelling the child", async () => {
    const { waitForSubagentJobs } = await import("../extensions/subagents");
    const controller = new AbortController();
    const completion = new Promise<void>(() => {});
    const waiting = waitForSubagentJobs([{ status: "running", completion }], 1000, controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBe("aborted");
    expect(controller.signal.aborted).toBe(true);
  });

  it("returns a timeout while leaving the completion promise untouched", async () => {
    const { waitForSubagentJobs } = await import("../extensions/subagents");
    let resolveChild!: () => void;
    let childSettled = false;
    const completion = new Promise<void>((resolve) => { resolveChild = resolve; }).then(() => { childSettled = true; });

    await expect(waitForSubagentJobs([{ status: "running", completion }], 1)).resolves.toBe("timeout");
    expect(childSettled).toBe(false);
    resolveChild();
    await completion;
    expect(childSettled).toBe(true);
  });
});

describe("subagents config", () => {
  it("reports missing required model slots", async () => {
    const { cwd } = makeDirs();
    const { loadSubagentsConfig } = await import("../extensions/subagents");

    const result = loadSubagentsConfig(cwd);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("models.fast.provider");
      expect(result.error).toContain("models.smart.model");
      expect(result.error).toContain("models.coder.provider");
    }
  });

  it("merges global and project config with required fixed preset names", async () => {
    const { agentDir, cwd } = makeDirs();
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({
      models: {
        fast: { provider: "p", model: "fast-1" },
        smart: { provider: "p", model: "smart-1" },
        coder: { provider: "p", model: "coder-1" }
      },
      async: { defaultDelivery: "followUp", maxConcurrent: 4 }
    }));
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
      models: { coder: { provider: "code", model: "coder-2" } },
      async: { maxConcurrent: 2 }
    }));

    const { loadSubagentsConfig } = await import("../extensions/subagents");
    const result = loadSubagentsConfig(cwd);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.models.fast).toEqual({ provider: "p", model: "fast-1" });
      expect(result.config.models.smart).toEqual({ provider: "p", model: "smart-1" });
      expect(result.config.models.coder).toEqual({ provider: "code", model: "coder-2" });
      expect(result.config.async.defaultDelivery).toBe("followUp");
      expect(result.config.async.maxConcurrent).toBe(2);
    }
  });
});
