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
  it("hides when all async subagents are finished", async () => {
    const { getSubagentWidgetLines } = await import("../extensions/subagents");

    const lines = getSubagentWidgetLines([
      {
        id: "repo-a-review",
        role: "reviewer",
        task: "review repo a",
        model: "coder",
        tools: "read_only",
        execution: "async",
        status: "done",
        startedAt: Date.now() - 1000,
        endedAt: Date.now(),
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
        toolCalls: [{ name: "read", args: { path: "README.md" } }],
        abortController: new AbortController(),
        deliver: "followUp",
      },
    ]);

    expect(lines).toBeUndefined();
  });

  it("shows only running async subagents", async () => {
    const { getSubagentWidgetLines } = await import("../extensions/subagents");

    const lines = getSubagentWidgetLines([
      {
        id: "running-review",
        role: "reviewer",
        task: "review repo",
        model: "coder",
        tools: "read_only",
        execution: "async",
        status: "running",
        startedAt: Date.now() - 1000,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        toolCalls: [{ name: "read", args: { path: "README.md" } }],
        abortController: new AbortController(),
        deliver: "followUp",
      },
      {
        id: "finished-review",
        role: "reviewer",
        task: "review done",
        model: "coder",
        tools: "read_only",
        execution: "async",
        status: "done",
        startedAt: Date.now() - 2000,
        endedAt: Date.now() - 1000,
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
        toolCalls: [],
        abortController: new AbortController(),
        deliver: "followUp",
      },
    ]);

    expect(lines).toBeDefined();
    expect(lines?.join("\n")).toContain("#running-review");
    expect(lines?.join("\n")).not.toContain("#finished-review");
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
