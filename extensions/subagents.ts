/**
 * Pi Subagents Extension
 *
 * Runs fresh sub Pi agents with orchestrator-supplied role/task/cwd/model/tool policy.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/subagents.json
 * - <cwd>/.pi/subagents.json
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  getMarkdownTheme,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { complete, type Context } from "@earendil-works/pi-ai/compat";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

type SubagentModelPreset = "fast" | "smart" | "coder";
type SubagentToolPolicy = "none" | "read_only";
type AsyncDelivery = "steer" | "followUp";
type JobStatus = "running" | "done" | "error" | "aborted" | "cancelled";

const MODEL_PRESETS = ["fast", "smart", "coder"] as const;
const TOOL_POLICIES = ["none", "read_only"] as const;
const DELIVERY_OPTIONS = ["steer", "followUp"] as const;
const WIDGET_KEY = "pi-subagents";
const DEFAULT_MAX_CONCURRENT_ASYNC = 4;
const DEFAULT_ASYNC_DELIVERY: AsyncDelivery = "followUp";

interface ModelConfig {
  provider: string;
  model: string;
}

interface SubagentsConfig {
  models: Record<SubagentModelPreset, ModelConfig>;
  async: {
    defaultDelivery: AsyncDelivery;
    maxConcurrent: number;
  };
}

interface RawSubagentsConfig {
  models?: Partial<Record<SubagentModelPreset, Partial<ModelConfig>>>;
  async?: {
    defaultDelivery?: AsyncDelivery;
    maxConcurrent?: number;
  };
}

type ConfigResult =
  | {
      ok: true;
      config: SubagentsConfig;
      globalPath: string;
      projectPath: string;
      loadedPaths: string[];
    }
  | {
      ok: false;
      error: string;
      globalPath: string;
      projectPath: string;
      loadedPaths: string[];
    };

interface ToolCallSummary {
  name: string;
  args: Record<string, unknown>;
}

interface SubagentInput {
  role: string;
  task: string;
  cwd?: string;
  model: SubagentModelPreset;
  tools: SubagentToolPolicy;
}

interface RunResult extends SubagentInput {
  id?: string;
  execution: "sync" | "async";
  provider?: string;
  modelId?: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  answer?: string;
  error?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  toolCalls: ToolCallSummary[];
}

interface AsyncJob extends RunResult {
  id: string;
  groupId: string;
  sessionGeneration: number;
  abortController: AbortController;
  completion: Promise<RunResult>;
  resolveCompletion: (result: RunResult) => void;
  completionSettled: boolean;
  deliver: AsyncDelivery;
  abortReason?: "shutdown" | "cancelled";
}

interface AsyncGroup {
  id: string;
  jobIds: string[];
  createdAt: number;
  deliver: AsyncDelivery;
  notified: boolean;
  waiters: number;
  collectedJobIds: Set<string>;
}

interface AsyncLaunchInput extends SubagentInput {
  tag?: string;
  deliver?: AsyncDelivery;
  groupId: string;
}

export interface WaitableSubagentJob {
  status: JobStatus;
  completion: Promise<unknown>;
}

export type SubagentWaitOutcome = "completed" | "timeout" | "aborted";
type ExtensionToolResult<T> = AgentToolResult<T> & { isError?: boolean };
type SerializedAsyncJob = RunResult & { groupId: string };

interface SubagentWaitDetails {
  groupId?: string;
  outcome?: SubagentWaitOutcome;
  jobs: SerializedAsyncJob[];
}

interface SubagentStatusDetails {
  groupId?: string;
  jobs: SerializedAsyncJob[];
}

const MAX_RETAINED_TERMINAL_JOBS = 100;
const MAX_RETAINED_GROUPS = 50;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

function buildSystemPrompt(role: string, tools: SubagentToolPolicy): string {
  const toolPolicy = tools === "none"
    ? "You have no tools. Reason only from the task and any context included in it. If the task requires inspecting files that were not provided, say so plainly."
    : "You have read, grep, find, and ls tools. Use them freely for read-only codebase inspection. You do not have bash, edit, or write tools.";

  return `You are a subagent spawned by a primary AI coding agent.

Role:
${role}

Tool policy:
${toolPolicy}

Rules:
- You have NO memory of the parent conversation. Treat the task as standalone.
- Do exactly the assigned task, then stop.
- Be concise and dense. Your answer goes directly back to the orchestrating agent.
- If using repo evidence, cite files and line numbers when possible.
- If the task is unanswerable with your tools/context, say so plainly — do not speculate.
- Do not make code changes.`;
}

function expandHome(p: string): string {
  if (p === "~") return process.env.HOME || "/tmp";
  if (p.startsWith("~/")) return join(process.env.HOME || "/tmp", p.slice(2));
  return p;
}

function readJson(path: string): RawSubagentsConfig | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as RawSubagentsConfig;
}

function mergeRawConfig(base: RawSubagentsConfig, override: RawSubagentsConfig): RawSubagentsConfig {
  return {
    models: {
      ...(base.models ?? {}),
      ...(override.models ?? {}),
      fast: { ...(base.models?.fast ?? {}), ...(override.models?.fast ?? {}) },
      smart: { ...(base.models?.smart ?? {}), ...(override.models?.smart ?? {}) },
      coder: { ...(base.models?.coder ?? {}), ...(override.models?.coder ?? {}) },
    },
    async: { ...(base.async ?? {}), ...(override.async ?? {}) },
  };
}

export function loadSubagentsConfig(cwd: string): ConfigResult {
  const globalPath = join(getAgentDir(), "subagents.json");
  const projectPath = join(cwd, ".pi", "subagents.json");
  const loadedPaths: string[] = [];

  let merged: RawSubagentsConfig = {};
  try {
    const globalConfig = readJson(globalPath);
    if (globalConfig) {
      loadedPaths.push(globalPath);
      merged = mergeRawConfig(merged, globalConfig);
    }

    const projectConfig = readJson(projectPath);
    if (projectConfig) {
      loadedPaths.push(projectPath);
      merged = mergeRawConfig(merged, projectConfig);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not parse subagents config: ${message}`, globalPath, projectPath, loadedPaths };
  }

  const missing: string[] = [];
  const models = {} as Record<SubagentModelPreset, ModelConfig>;
  for (const preset of MODEL_PRESETS) {
    const value = merged.models?.[preset];
    if (!value?.provider) missing.push(`models.${preset}.provider`);
    if (!value?.model) missing.push(`models.${preset}.model`);
    if (value?.provider && value?.model) models[preset] = { provider: value.provider, model: value.model };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      globalPath,
      projectPath,
      loadedPaths,
      error: [
        "Missing required subagents config fields:",
        ...missing.map((m) => `- ${m}`),
        "",
        "Create ~/.pi/agent/subagents.json or <cwd>/.pi/subagents.json. See pi-subagents/examples/subagents.json.",
      ].join("\n"),
    };
  }

  const defaultDelivery = merged.async?.defaultDelivery ?? DEFAULT_ASYNC_DELIVERY;
  const maxConcurrent = merged.async?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_ASYNC;
  if (!DELIVERY_OPTIONS.includes(defaultDelivery)) {
    return { ok: false, globalPath, projectPath, loadedPaths, error: `Invalid async.defaultDelivery: ${defaultDelivery}` };
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) {
    return { ok: false, globalPath, projectPath, loadedPaths, error: "async.maxConcurrent must be an integer from 1 to 16." };
  }

  return {
    ok: true,
    globalPath,
    projectPath,
    loadedPaths,
    config: { models, async: { defaultDelivery, maxConcurrent } },
  };
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function elapsedMs(run: Pick<RunResult, "startedAt" | "endedAt">): number {
  return (run.endedAt ?? Date.now()) - run.startedAt;
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}:${rem.toString().padStart(2, "0")}`;
}

function getStatusIcon(status: JobStatus, theme: Theme): string {
  switch (status) {
    case "running": return theme.fg("warning", "⏳");
    case "done": return theme.fg("success", "✓");
    case "cancelled": return theme.fg("warning", "◌");
    case "aborted": return theme.fg("warning", "◌");
    case "error": return theme.fg("error", "✗");
  }
}

function summarize(value: string, max = 90): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function modelGuidance(): string {
  return "Required model preset: fast for cheap quick reconnaissance, smart for balanced/default reasoning, coder for code-heavy analysis/review/debugging.";
}

function toolsGuidance(): string {
  return "Required tool policy: none for reasoning-only; read_only for a fresh Pi agent with read/grep/find/ls.";
}

async function resolveConfiguredModel(ctx: ExtensionContext, preset: SubagentModelPreset): Promise<{ ok: true; provider: string; modelId: string; model: any; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } | { ok: false; error: string }> {
  const configResult = loadSubagentsConfig(ctx.cwd);
  if (!configResult.ok) return { ok: false, error: configResult.error };
  const selected = configResult.config.models[preset];
  const model = ctx.modelRegistry.find(selected.provider, selected.model);
  if (!model) {
    return { ok: false, error: `subagents: configured model ${selected.provider}/${selected.model} for preset ${preset} is not registered.` };
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { ok: false, error: `subagents: could not resolve API key for ${selected.provider}: ${auth.error}` };
  return { ok: true, provider: selected.provider, modelId: selected.model, model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
}

function getModelRuntime(ctx: ExtensionContext): any {
  return (ctx.modelRegistry as any).runtime;
}

async function runSubagent(input: SubagentInput, execution: "sync" | "async", signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: (partial: RunResult) => void): Promise<RunResult> {
  const startedAt = Date.now();
  const cwd = input.cwd ? expandHome(input.cwd) : ctx.cwd;
  const run: RunResult = {
    ...input,
    cwd,
    execution,
    status: "running",
    startedAt,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    toolCalls: [],
  };
  onUpdate?.(run);

  if (signal?.aborted) return { ...run, status: "aborted", endedAt: Date.now(), error: "subagent aborted" };

  const resolved = await resolveConfiguredModel(ctx, input.model);
  if (!resolved.ok) return { ...run, status: "error", endedAt: Date.now(), error: resolved.error };
  if (signal?.aborted) return { ...run, status: "aborted", endedAt: Date.now(), error: "subagent aborted" };
  run.provider = resolved.provider;
  run.modelId = resolved.modelId;
  onUpdate?.(run);

  if (input.tools === "none") {
    const context: Context = {
      systemPrompt: buildSystemPrompt(input.role, input.tools),
      messages: [{ role: "user", content: input.task, timestamp: Date.now() }],
    };

    try {
      const result = await complete(resolved.model, context, {
        signal,
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        env: resolved.env,
        maxTokens: 4096,
      });

      const answer = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim() || "(subagent returned no text)";

      return {
        ...run,
        status: result.stopReason === "aborted" ? "aborted" : "done",
        endedAt: Date.now(),
        answer,
        tokensIn: result.usage.input,
        tokensOut: result.usage.output,
        costUsd: result.usage.cost.total,
        error: result.stopReason === "aborted" ? "subagent aborted" : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...run, status: signal?.aborted ? "aborted" : "error", endedAt: Date.now(), error: message };
    }
  }

  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: buildSystemPrompt(input.role, input.tools),
    });
    await loader.reload();
    if (signal?.aborted) return { ...run, status: "aborted", endedAt: Date.now(), error: "subagent aborted" };

    const modelRuntime = getModelRuntime(ctx);
    if (!modelRuntime) {
      return { ...run, status: "error", endedAt: Date.now(), error: "subagents: current Pi runtime does not expose model auth runtime." };
    }
    if (signal?.aborted) return { ...run, status: "aborted", endedAt: Date.now(), error: "subagent aborted" };

    const { session } = await createAgentSessionShim({
      cwd,
      agentDir: getAgentDir(),
      model: resolved.model,
      thinkingLevel: "off",
      modelRuntime,
      tools: ["read", "grep", "find", "ls"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
    });

    if (signal?.aborted) {
      await session.abort();
      session.dispose();
      return { ...run, status: "aborted", endedAt: Date.now(), error: "subagent aborted" };
    }

    const abortHandler = () => { void session.abort(); };
    signal?.addEventListener("abort", abortHandler);

    let answer = "";
    let error: string | undefined;
    const unsubscribe = session.subscribe((event: any) => {
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const msg = event.message;
      const text = msg.content
        .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("\n")
        .trim();
      if (text) answer = text;

      for (const part of msg.content) {
        if (part.type === "toolCall") run.toolCalls.push({ name: part.name, args: part.arguments ?? {} });
      }

      if (msg.usage) {
        run.tokensIn += msg.usage.input ?? 0;
        run.tokensOut += msg.usage.output ?? 0;
        run.costUsd += msg.usage.cost?.total ?? 0;
      }
      if (msg.stopReason === "error" && msg.errorMessage) error = msg.errorMessage;
      onUpdate?.({ ...run });
    });

    try {
      await session.prompt(input.task);
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", abortHandler);
    }

    if (signal?.aborted) return { ...run, status: "aborted", endedAt: Date.now(), answer, error: "subagent aborted" };
    if (error) return { ...run, status: "error", endedAt: Date.now(), answer, error };
    return { ...run, status: "done", endedAt: Date.now(), answer: answer || "(subagent returned no text)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...run, status: signal?.aborted ? "aborted" : "error", endedAt: Date.now(), error: message };
  }
}

// Isolated to keep the import list readable and make tests that only import helpers cheaper.
async function createAgentSessionShim(args: Parameters<typeof import("@earendil-works/pi-coding-agent").createAgentSession>[0]) {
  const mod = await import("@earendil-works/pi-coding-agent");
  return mod.createAgentSession(args);
}

function runToToolResult(run: RunResult) {
  const text = run.status === "done" ? (run.answer ?? "(subagent returned no text)") : `subagent ${run.status}: ${run.error ?? run.answer ?? "no details"}`;
  return {
    content: [{ type: "text" as const, text }],
    details: run,
    isError: run.status !== "done",
  };
}

function renderRun(run: RunResult, expanded: boolean, theme: Theme) {
  const icon = getStatusIcon(run.status, theme);
  const title = `${icon} ${theme.fg("toolTitle", theme.bold(run.execution === "async" ? "subagent_async" : "subagent"))} ${theme.fg("accent", run.model)}`;
  const meta: string[] = [];
  if (run.id) meta.push(`#${run.id}`);
  meta.push(run.tools);
  if (run.modelId) meta.push(run.modelId);
  if (run.cwd) meta.push(run.cwd);
  meta.push(formatElapsed(elapsedMs(run)));

  if (!expanded) {
    let text = `${title} ${theme.fg("muted", meta.join(" · "))}`;
    text += `\n  ${theme.fg("muted", "role: ")}${theme.fg("dim", summarize(run.role, 100))}`;
    text += `\n  ${theme.fg("muted", "task: ")}${theme.fg("dim", summarize(run.task, 100))}`;
    if (run.status === "running") {
      const activity = run.tools === "read_only" ? `${run.toolCalls.length} tool calls` : "reasoning";
      text += `\n  ${theme.fg("warning", `running · ${activity}`)}`;
    } else if (run.status === "done") {
      const answer = (run.answer ?? "").split("\n").slice(0, 3).join("\n");
      if (answer) text += `\n${theme.fg("toolOutput", answer)}`;
    } else {
      text += `\n${theme.fg("error", run.error ?? run.status)}`;
    }
    const usage = formatRunUsage(run);
    if (usage) text += `\n${theme.fg("dim", usage)}`;
    if (run.status === "done" && run.answer && run.answer.split("\n").length > 3) {
      text += `\n${theme.fg("muted", keyHint("app.tools.expand", "to expand"))}`;
    }
    return new Text(text, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(`${title} ${theme.fg("muted", meta.join(" · "))}`, 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─── Role ───"), 0, 0));
  container.addChild(new Text(theme.fg("dim", run.role), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
  container.addChild(new Text(theme.fg("dim", run.task), 0, 0));
  if (run.toolCalls.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", `─── Tool calls (${run.toolCalls.length}) ───`), 0, 0));
    for (const call of run.toolCalls) {
      container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("accent", call.name) + theme.fg("dim", ` ${JSON.stringify(call.args).slice(0, 160)}`), 0, 0));
    }
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", run.status === "done" ? "─── Answer ───" : "─── Status ───"), 0, 0));
  if (run.status === "done" && run.answer) container.addChild(new Markdown(run.answer, 0, 0, getMarkdownTheme()));
  else container.addChild(new Text(run.error ? theme.fg("error", run.error) : theme.fg("warning", run.status), 0, 0));
  const usage = formatRunUsage(run);
  if (usage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", usage), 0, 0));
  }
  return container;
}

type UsageRun = Pick<RunResult, "tokensIn" | "tokensOut" | "costUsd" | "tools" | "toolCalls">;

function formatRunUsage(run: UsageRun): string {
  const parts: string[] = [];
  if (run.tokensIn || run.tokensOut) parts.push(`↑${formatTokens(run.tokensIn)} ↓${formatTokens(run.tokensOut)}`);
  if (run.costUsd) parts.push(formatCost(run.costUsd));
  if (run.tools === "read_only") parts.push(`${run.toolCalls.length} tools`);
  return parts.join(" · ");
}

function normalizeJobTag(tag?: string): string | undefined {
  const cleaned = tag?.trim().replace(/^#/, "").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || undefined;
}

function makeJobId(tag?: string): string {
  return normalizeJobTag(tag) ?? `s-${Date.now().toString(36).slice(-5)}-${Math.random().toString(36).slice(2, 5)}`;
}

function makeGroupId(): string {
  return `g-${Date.now().toString(36).slice(-5)}-${Math.random().toString(36).slice(2, 6)}`;
}

function jobToRunResult(job: AsyncJob): RunResult {
  const { abortController: _abortController, completion: _completion, resolveCompletion: _resolveCompletion, completionSettled: _completionSettled, groupId: _groupId, sessionGeneration: _sessionGeneration, deliver: _deliver, abortReason: _abortReason, ...result } = job;
  return result;
}

function settleJobCompletion(job: AsyncJob): void {
  if (job.completionSettled) return;
  job.completionSettled = true;
  job.resolveCompletion(jobToRunResult(job));
}

function jobDetails(job: AsyncJob): SerializedAsyncJob {
  const { abortController: _abortController, completion: _completion, resolveCompletion: _resolveCompletion, completionSettled: _completionSettled, sessionGeneration: _sessionGeneration, deliver: _deliver, abortReason: _abortReason, ...details } = job;
  return details;
}

/** Wait for the selected running jobs without cancelling them when the wait ends. */
export function waitForSubagentJobs(
  selected: readonly WaitableSubagentJob[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SubagentWaitOutcome> {
  const running = selected.filter((job) => job.status === "running");
  if (running.length === 0) return Promise.resolve("completed");
  if (signal?.aborted) return Promise.resolve("aborted");

  return new Promise<SubagentWaitOutcome>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const onAbort = () => finish("aborted");

    const finish = (outcome: SubagentWaitOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.all(running.map((job) => job.completion.catch(() => undefined))).then(() => finish("completed"));
  });
}

function makeParentAbortedRun(input: SubagentInput, ctx: ExtensionContext): RunResult {
  return {
    ...input,
    execution: "sync",
    cwd: input.cwd ? expandHome(input.cwd) : ctx.cwd,
    status: "aborted",
    startedAt: Date.now(),
    endedAt: Date.now(),
    error: "parent aborted before subagent completed",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    toolCalls: [],
  };
}

async function runParallelSubagents(
  inputs: readonly SubagentInput[],
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<RunResult[]> {
  if (signal?.aborted) return inputs.map((input) => makeParentAbortedRun(input, ctx));

  const results: Array<RunResult | undefined> = new Array(inputs.length);
  const childPromises = inputs.map((input, index) => runSubagent(input, "sync", signal, ctx).then((result) => {
    results[index] = result;
    return result;
  }));
  const allChildren = Promise.all(childPromises);
  if (!signal) return allChildren;

  let abort!: () => void;
  const aborted = new Promise<"aborted">((resolve) => { abort = () => resolve("aborted"); });
  const onAbort = () => abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) abort();
  try {
    const outcome = await Promise.race([
      allChildren.then((completed) => ({ type: "completed" as const, results: completed })),
      aborted.then(() => ({ type: "aborted" as const })),
    ]);
    if (outcome.type === "completed") return outcome.results;

    // Synchronous children must not become detached when the parent aborts.
    // runSubagent receives the same signal and is responsible for unwinding;
    // wait for that cleanup before returning the tool result.
    const settled = await allChildren;
    return inputs.map((input, index) => settled[index] ?? makeParentAbortedRun(input, ctx));
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function formatRunResult(run: RunResult, label: string): string {
  const status = run.status === "done" ? "completed" : run.status;
  const body = run.status === "done" ? run.answer : run.error ?? run.answer ?? "No result text.";
  return [
    `### ${label} ${status}`,
    `Model preset: ${run.model}`,
    `Tool policy: ${run.tools}`,
    run.modelId ? `Model: ${run.provider}/${run.modelId}` : undefined,
    run.cwd ? `CWD: ${run.cwd}` : undefined,
    `Elapsed: ${formatElapsed(elapsedMs(run))}`,
    `Usage: ${formatRunUsage(run) || "n/a"}`,
    "",
    "Role:",
    run.role,
    "",
    "Task:",
    run.task,
    "",
    "Result:",
    body,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatAsyncJobResult(job: AsyncJob): string {
  return formatRunResult(job, `#${job.id}`);
}

function formatAsyncGroupMessage(group: AsyncGroup, allJobs: AsyncJob[], jobsToReport: AsyncJob[]): string {
  const completed = allJobs.filter((job) => job.status !== "running").length;
  const failed = allJobs.filter((job) => job.status !== "running" && job.status !== "done").length;
  const status = failed > 0 ? "completed with errors" : "completed";
  const collected = allJobs.length - jobsToReport.length;
  return [
    `Subagent group ${group.id} ${status}: ${completed}/${allJobs.length} finished.`,
    collected > 0 ? `Results for ${collected} job${collected === 1 ? "" : "s"} were already collected by the parent.` : "All results are included below.",
    "",
    jobsToReport.map(formatAsyncJobResult).join("\n\n---\n\n"),
  ].join("\n");
}

type WidgetJob = Pick<RunResult, "id" | "model" | "tools" | "status" | "startedAt" | "endedAt" | "toolCalls">;

export function getSubagentWidgetLines(jobs: Iterable<WidgetJob>): string[] | undefined {
  const active = Array.from(jobs).filter((j) => j.status === "running");
  if (active.length === 0) return undefined;

  const lines = ["Subagents"];
  for (const job of active) {
    const activity = job.tools === "read_only" ? `${job.toolCalls.length} tools` : "reasoning";
    lines.push(`⏳ #${job.id} ${job.model} ${job.tools} ${formatElapsed(elapsedMs(job))} ${activity}`);
  }
  return lines;
}

export function pruneCompletedSubagentJobsIfIdle(
  jobs: Map<string, { status: string; endedAt?: number }>,
  maxRetained = MAX_RETAINED_TERMINAL_JOBS,
): number {
  const terminal = Array.from(jobs.entries()).filter(([, job]) => job.status !== "running");
  if (terminal.length <= maxRetained) return 0;

  terminal.sort(([, a], [, b]) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  let pruned = 0;
  for (const [id] of terminal.slice(0, terminal.length - maxRetained)) {
    jobs.delete(id);
    pruned++;
  }
  return pruned;
}

function pruneAsyncGroups(groups: Map<string, AsyncGroup>, jobs: Map<string, AsyncJob>): number {
  const groupEntries = Array.from(groups.values());
  let pruned = 0;

  // Never leave a group pointing at a partially evicted batch. Tags can still
  // retrieve any retained jobs, but the group handle must either identify the
  // complete batch or no longer exist.
  for (const group of groupEntries) {
    if (group.jobIds.some((id) => !jobs.has(id))) {
      groups.delete(group.id);
      pruned++;
    }
  }
  if (groups.size <= MAX_RETAINED_GROUPS) return pruned;

  groupEntries.sort((a, b) => a.createdAt - b.createdAt);
  for (const group of groupEntries) {
    if (groups.size <= MAX_RETAINED_GROUPS) break;
    if (!groups.has(group.id)) continue;
    const hasRunningJob = group.jobIds.some((id) => jobs.get(id)?.status === "running");
    if (!hasRunningJob) {
      groups.delete(group.id);
      pruned++;
    }
  }
  return pruned;
}

function pruneRetainedAsyncState(jobs: Map<string, AsyncJob>, groups: Map<string, AsyncGroup>): void {
  let terminalCount = Array.from(jobs.values()).filter((job) => job.status !== "running").length;
  if (terminalCount > MAX_RETAINED_TERMINAL_JOBS) {
    const groupEntries = Array.from(groups.values()).sort((a, b) => a.createdAt - b.createdAt);
    for (const group of groupEntries) {
      if (terminalCount <= MAX_RETAINED_TERMINAL_JOBS) break;
      const groupJobs = group.jobIds.map((id) => jobs.get(id));
      if (groupJobs.some((job) => !job || job.status === "running")) continue;
      for (const id of group.jobIds) {
        if (jobs.delete(id)) terminalCount--;
      }
      groups.delete(group.id);
    }
  }

  // This handles any ungrouped/legacy entries and also removes groups whose
  // complete batch was evicted. Grouped jobs are evicted as a unit above so a
  // retained group never points at only part of its original batch.
  pruneCompletedSubagentJobsIfIdle(jobs);
  pruneAsyncGroups(groups, jobs);
}

function updateWidget(ctx: ExtensionContext | undefined, jobs: Map<string, AsyncJob>, groups?: Map<string, AsyncGroup>) {
  const lines = getSubagentWidgetLines(jobs.values());
  if (groups) pruneRetainedAsyncState(jobs, groups);
  else pruneCompletedSubagentJobsIfIdle(jobs);
  if (!ctx?.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, lines);
}

function configErrorResult(input: SubagentInput, error: string) {
  const result: RunResult = {
    ...input,
    execution: "sync",
    status: "error",
    startedAt: Date.now(),
    endedAt: Date.now(),
    error,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    toolCalls: [],
  };
  return { content: [{ type: "text" as const, text: error }], details: result, isError: true };
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<string, AsyncJob>();
  const groups = new Map<string, AsyncGroup>();
  let widgetCtx: ExtensionContext | undefined;
  let sessionGeneration = 0;
  let sessionActive = false;

  pi.on("session_start", (_event, ctx) => {
    sessionGeneration++;
    sessionActive = true;
    jobs.clear();
    groups.clear();
    widgetCtx = ctx;
    updateWidget(widgetCtx, jobs, groups);
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
    for (const job of jobs.values()) {
      if (job.status === "running") {
        job.status = "aborted";
        job.abortReason = "shutdown";
        job.endedAt = Date.now();
        job.error = "session shut down before subagent completed";
        settleJobCompletion(job);
        job.abortController.abort();
      }
    }
    updateWidget(widgetCtx, jobs, groups);
  });

  pi.registerCommand("subagents-config", {
    description: "Show resolved pi-subagents config",
    handler: async (_args, ctx) => {
      const result = loadSubagentsConfig(ctx.cwd);
      if (!result.ok) {
        ctx.ui.notify(result.error, "error");
        return;
      }
      const lines = [
        "pi-subagents config",
        `Loaded: ${result.loadedPaths.join(", ") || "none"}`,
        ...MODEL_PRESETS.map((preset) => `- ${preset}: ${result.config.models[preset].provider}/${result.config.models[preset].model}`),
        `async.defaultDelivery: ${result.config.async.defaultDelivery}`,
        `async.maxConcurrent: ${result.config.async.maxConcurrent}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  const modelSchema = StringEnum(MODEL_PRESETS, { description: modelGuidance() });
  const toolsSchema = StringEnum(TOOL_POLICIES, { description: toolsGuidance() });
  const deliverSchema = StringEnum(DELIVERY_OPTIONS, { description: "How to inject async results: steer interrupts at the next tool boundary; followUp waits until the agent is idle." });
  const subagentWaitSchema = Type.Object({
    groupId: Type.Optional(Type.String({ description: "Async group id returned by subagents_async. Waits for every job in the group." })),
    tags: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 8, description: "Job tags/ids to wait for. Waits for every matching job." })),
    all: Type.Optional(Type.Boolean({ description: "Wait for all currently active async jobs in this parent session." })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum time to wait. Children continue running if the wait times out." })),
  });
  const subagentTaskSchema = Type.Object({
    tag: Type.Optional(Type.String({ description: "Optional stable async job tag, e.g. repo-a-review." })),
    role: Type.String({ description: "Bespoke role/job framing for this subagent, e.g. 'You are a staff backend reviewer focused on API compatibility.'" }),
    task: Type.String({ description: "Self-contained task. Include all context the subagent needs; it has no parent memory." }),
    cwd: Type.Optional(Type.String({ description: "Working directory for read_only subagents. Relative paths resolve from the parent agent cwd." })),
    model: modelSchema,
    tools: toolsSchema,
  });
  const parallelTaskSchema = Type.Object({
    role: subagentTaskSchema.properties.role,
    task: subagentTaskSchema.properties.task,
    cwd: subagentTaskSchema.properties.cwd,
    model: modelSchema,
    tools: toolsSchema,
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Run one fresh sub Pi agent with a bespoke role, task, cwd, required model preset, and required tool policy. Use this when the answer is needed before continuing.",
    promptSnippet: "subagent(role, task, cwd?, model, tools) — run a fresh bespoke sub Pi agent synchronously",
    promptGuidelines: [
      "Use subagent for scoped work that benefits from an isolated context and a bespoke role/job.",
      "Every subagent call must choose model: fast, smart, or coder.",
      "Every subagent call must choose tools: none for reasoning-only, read_only for codebase inspection with read/grep/find/ls.",
      "Pack all necessary context into role/task. The subagent has no memory of this conversation.",
    ],
    parameters: Type.Object({
      role: subagentTaskSchema.properties.role,
      task: subagentTaskSchema.properties.task,
      cwd: subagentTaskSchema.properties.cwd,
      model: modelSchema,
      tools: toolsSchema,
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input: SubagentInput = {
        role: params.role ?? "You are a helpful subagent.",
        task: params.task ?? "",
        cwd: params.cwd,
        model: params.model as SubagentModelPreset,
        tools: params.tools as SubagentToolPolicy,
      };
      const run = await runSubagent(input, "sync", signal, ctx, (partial) => onUpdate?.({
        content: [{ type: "text", text: `subagent running on ${partial.model} with ${partial.tools}: ${partial.toolCalls.length} tool calls…` }],
        details: partial,
      }));
      return runToToolResult(run);
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.model ?? "model?")} ${theme.fg("muted", args.tools ?? "tools?")}\n  ${theme.fg("muted", "role: ")}${theme.fg("dim", summarize(args.role ?? "…"))}\n  ${theme.fg("muted", "task: ")}${theme.fg("dim", summarize(args.task ?? "…"))}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) { return renderRun(result.details as RunResult, expanded, theme); },
  });

  pi.registerTool({
    name: "subagents_parallel",
    label: "Parallel Subagents",
    description: "Run multiple fresh sub Pi agents concurrently and wait for every result before returning. Use this when the parent needs the complete set of findings before continuing.",
    promptSnippet: "subagents_parallel(tasks) — run parallel subagents and wait for all results",
    promptGuidelines: [
      "Use subagents_parallel when the next phase depends on all delegated results.",
      "This tool is a synchronization barrier: it does not return until every child has finished or the parent aborts.",
      "Use subagents_async instead only when the work is genuinely independent and the parent will not duplicate or immediately depend on it.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(parallelTaskSchema, { minItems: 1, maxItems: 8, description: "Independent subagent tasks to run concurrently." }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const tasks = params.tasks ?? [];
      const inputs = tasks.map((task) => ({
        role: task.role ?? "You are a helpful subagent.",
        task: task.task ?? "",
        cwd: task.cwd,
        model: task.model as SubagentModelPreset,
        tools: task.tools as SubagentToolPolicy,
      }));
      const results = await runParallelSubagents(inputs, signal, ctx);
      const failures = results.filter((run) => run.status !== "done").length;
      const text = [
        `Parallel subagents completed: ${results.length - failures}/${results.length} succeeded.`,
        "",
        results.map((run, index) => formatRunResult(run, `subagent-${index + 1}`)).join("\n\n---\n\n"),
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: { runs: results }, isError: failures > 0 };
    },
  });

  function maybeDeliverCompletedGroup(groupId: string): void {
    const group = groups.get(groupId);
    if (!group || group.notified) return;

    const groupJobs = group.jobIds
      .map((id) => jobs.get(id))
      .filter((job): job is AsyncJob => Boolean(job));
    if (groupJobs.length !== group.jobIds.length || groupJobs.some((job) => job.status === "running")) return;

    // A waiter is the authoritative result channel. Omit jobs it already
    // collected, while still notifying about uncollected siblings.
    if (group.waiters > 0) return;
    const jobsToReport = groupJobs.filter((job) => !group.collectedJobIds.has(job.id));
    if (jobsToReport.length === 0) {
      group.notified = true;
      return;
    }

    try {
      pi.sendUserMessage(formatAsyncGroupMessage(group, groupJobs, jobsToReport), { deliverAs: group.deliver });
      group.notified = true;
    } catch (err) {
      console.error(`pi-subagents: could not deliver group ${group.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function launchAsync(input: AsyncLaunchInput, ctx: ExtensionContext): AsyncJob | { error: string } {
    const configResult = loadSubagentsConfig(ctx.cwd);
    if (!configResult.ok) return { error: configResult.error };
    const running = Array.from(jobs.values()).filter((j) => j.status === "running").length;
    if (running >= configResult.config.async.maxConcurrent) return { error: `subagents: async concurrency limit reached (${running}/${configResult.config.async.maxConcurrent}).` };

    const { tag, deliver, groupId, ...baseInput } = input;
    const id = makeJobId(tag);
    if (jobs.has(id)) return { error: `subagents: job #${id} already exists.` };

    const abortController = new AbortController();
    let resolveCompletion: (result: RunResult) => void = () => {};
    const completion = new Promise<RunResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const job: AsyncJob = {
      ...baseInput,
      id,
      groupId,
      sessionGeneration,
      execution: "async",
      cwd: baseInput.cwd ? expandHome(baseInput.cwd) : ctx.cwd,
      status: "running",
      startedAt: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      toolCalls: [],
      abortController,
      completion,
      resolveCompletion,
      completionSettled: false,
      deliver: deliver ?? configResult.config.async.defaultDelivery,
    };
    jobs.set(id, job);
    widgetCtx = ctx;
    updateWidget(widgetCtx, jobs, groups);

    void (async () => {
      let result: RunResult;
      try {
        const update = (partial: RunResult) => {
          if (job.abortReason) return;
          if (!sessionActive || job.sessionGeneration !== sessionGeneration) return;
          Object.assign(job, { ...partial, id, groupId, sessionGeneration, execution: "async", abortController, completion, resolveCompletion, completionSettled: job.completionSettled, deliver: job.deliver });
          updateWidget(widgetCtx, jobs, groups);
        };
        result = await runSubagent(baseInput, "async", abortController.signal, ctx, update);
      } catch (err) {
        result = {
          ...baseInput,
          id,
          execution: "async",
          cwd: job.cwd,
          status: job.status === "cancelled" ? "cancelled" : "error",
          startedAt: job.startedAt,
          endedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
          tokensIn: job.tokensIn,
          tokensOut: job.tokensOut,
          costUsd: job.costUsd,
          toolCalls: job.toolCalls,
        };
      }

      const abortReason = job.abortReason;
      const belongsToCurrentSession = sessionActive && job.sessionGeneration === sessionGeneration;
      Object.assign(job, { ...result, id, groupId, sessionGeneration: job.sessionGeneration, execution: "async", abortController, completion, resolveCompletion, completionSettled: job.completionSettled, deliver: job.deliver });
      if (abortReason === "cancelled") {
        job.status = "cancelled";
        job.error = "cancelled by primary agent";
      } else if (abortReason === "shutdown") {
        job.status = "aborted";
        job.error = "session shut down before subagent completed";
      }
      job.endedAt = Date.now();
      if (belongsToCurrentSession) updateWidget(widgetCtx, jobs, groups);
      settleJobCompletion(job);

      if (!belongsToCurrentSession || abortReason === "shutdown") return;

      try {
        pi.appendEntry("pi-subagents:job", {
          id: job.id,
          groupId: job.groupId,
          model: job.model,
          tools: job.tools,
          role: job.role,
          task: job.task,
          cwd: job.cwd,
          status: job.status,
          answer: job.answer,
          error: job.error,
          startedAt: job.startedAt,
          endedAt: job.endedAt,
          tokensIn: job.tokensIn,
          tokensOut: job.tokensOut,
          costUsd: job.costUsd,
          toolCalls: job.toolCalls.length,
        });
      } catch (err) {
        // The child result is already available to waiters. A stale session or
        // persistence failure must not turn a successful child run into an error.
        console.error(`pi-subagents: could not persist job #${job.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      maybeDeliverCompletedGroup(job.groupId);
    })();

    return job;
  }

  pi.registerTool({
    name: "subagents_async",
    label: "Subagents Async",
    description: "Launch one or more fresh sub Pi agents in the background. Each task supplies a bespoke role, task, cwd, required model preset, required tool policy, and optional tag. Returns a groupId for waiting on the complete batch; results also arrive later as tagged user messages.",
    promptSnippet: "subagents_async(tasks, deliver?, handoff?) — launch background subagents and return a groupId",
    promptGuidelines: [
      "Use subagents_async only for work that is genuinely independent of the current task; parallelizable does not mean independent.",
      "Use one task per repo/scope and give each task a clear tag so results can be correlated.",
      "Every async subagent task must choose model and tools explicitly.",
      "If your next action depends on these results, call subagents_wait with the returned groupId before starting that action.",
      "Do not repeat an async subagent's investigation while its job is running. Continue only with unrelated work or wait for the dependency boundary.",
      "Set handoff=true when this parent should end its current turn after launching; the grouped completion will wake it later. This only takes effect when this is the only terminating tool batch.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(subagentTaskSchema, { minItems: 1, maxItems: 8, description: "Subagent tasks to launch." }),
      deliver: Type.Optional(deliverSchema),
      handoff: Type.Optional(Type.Boolean({ description: "End the parent turn after launching. Results arrive later through the group's completion notification; this is not a wait." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const configResult = loadSubagentsConfig(ctx.cwd);
      if (!configResult.ok) {
        const fallback: SubagentInput = { role: "configuration", task: "configuration", model: "smart", tools: "none" };
        return configErrorResult(fallback, configResult.error);
      }
      const tasks = params.tasks ?? [];
      const running = Array.from(jobs.values()).filter((j) => j.status === "running").length;
      if (running + tasks.length > configResult.config.async.maxConcurrent) {
        const error = `subagents: launching ${tasks.length} jobs would exceed async concurrency limit (${running}/${configResult.config.async.maxConcurrent} already running).`;
        const fallback: SubagentInput = { role: "concurrency check", task: error, model: "smart", tools: "none" };
        return configErrorResult(fallback, error);
      }

      const explicitIds = tasks
        .map((task) => normalizeJobTag(task.tag))
        .filter((id): id is string => Boolean(id));
      const duplicateIds = [...new Set(explicitIds.filter((id, index) => explicitIds.indexOf(id) !== index))];
      const existingIds = explicitIds.filter((id) => jobs.has(id));
      if (duplicateIds.length > 0 || existingIds.length > 0) {
        const conflicts = [
          duplicateIds.length > 0 ? `duplicate tags: ${duplicateIds.map((id) => `#${id}`).join(", ")}` : undefined,
          existingIds.length > 0 ? `already-used tags: ${existingIds.map((id) => `#${id}`).join(", ")}` : undefined,
        ].filter((line): line is string => line !== undefined).join("; ");
        const error = `subagents: async batch rejected before launch (${conflicts}).`;
        const fallback: SubagentInput = { role: "batch validation", task: error, model: "smart", tools: "none" };
        return configErrorResult(fallback, error);
      }

      const groupId = makeGroupId();
      const group: AsyncGroup = {
        id: groupId,
        jobIds: [],
        createdAt: Date.now(),
        deliver: params.deliver ?? configResult.config.async.defaultDelivery,
        notified: false,
        waiters: 0,
        collectedJobIds: new Set(),
      };
      groups.set(groupId, group);

      const launched: AsyncJob[] = [];
      const errors: string[] = [];
      for (const task of tasks) {
        const input: AsyncLaunchInput = {
          role: task.role ?? "You are a helpful subagent.",
          task: task.task ?? "",
          cwd: task.cwd,
          model: task.model as SubagentModelPreset,
          tools: task.tools as SubagentToolPolicy,
          tag: task.tag,
          deliver: params.deliver,
          groupId,
        };
        const result = launchAsync(input, ctx);
        if ("abortController" in result) {
          launched.push(result);
          group.jobIds.push(result.id);
        } else {
          errors.push(result.error);
        }
      }

      if (launched.length === 0) groups.delete(groupId);
      const lines = [
        launched.length > 0 ? `Launched ${launched.length} async subagent${launched.length === 1 ? "" : "s"} in group ${groupId}:` : "No subagents launched.",
        ...launched.map((j) => `- #${j.id} ${j.model} ${j.tools} (${j.deliver})`),
        launched.length > 0 ? `Use subagents_wait({ groupId: "${groupId}" }) before using these results.` : undefined,
        ...errors.map((e) => `- error: ${e}`),
      ].filter((line): line is string => line !== undefined);
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { groupId: launched.length > 0 ? groupId : undefined, launched: launched.map(jobDetails), errors }, isError: errors.length > 0, terminate: launched.length > 0 && params.handoff === true };
    },
  });

  pi.registerTool({
    name: "subagents_wait",
    label: "Wait for Subagents",
    description: "Wait for selected async subagent jobs to finish and return their results. Use groupId from subagents_async, tags for specific jobs, or all for every active job. This is a real synchronization barrier; it does not cancel children when the wait times out or is aborted.",
    promptSnippet: "subagents_wait(groupId?, tags?, all?, timeoutMs?) — wait for async results",
    promptGuidelines: [
      "Use subagents_wait before beginning work that depends on async subagent results.",
      "Use groupId from subagents_async to wait for the complete launched batch.",
      "Do not duplicate an async subagent's investigation while waiting for its result.",
      "A timeout or aborted wait leaves child jobs running and does not consume the group notification; inspect or wait again rather than launching duplicate replacements.",
    ],
    parameters: subagentWaitSchema,
    async execute(_toolCallId, params, signal): Promise<ExtensionToolResult<SubagentWaitDetails>> {
      const hasGroup = Boolean(params.groupId?.trim());
      const hasTags = (params.tags?.length ?? 0) > 0;
      const hasAll = params.all === true;
      const selectorCount = Number(hasGroup) + Number(hasTags) + Number(hasAll);
      if (selectorCount > 1) {
        return {
          content: [{ type: "text" as const, text: "Choose exactly one of groupId, tags, or all." }],
          details: { jobs: [] },
          isError: true,
        };
      }
      if (selectorCount === 0) {
        return {
          content: [{ type: "text" as const, text: "Specify groupId, tags, or all to select async subagent jobs." }],
          details: { jobs: [] },
          isError: true,
        };
      }

      let selected: AsyncJob[];
      let selectedGroupId: string | undefined;
      if (hasGroup) {
        selectedGroupId = params.groupId!.trim();
        const group = groups.get(selectedGroupId);
        if (!group) {
          return {
            content: [{ type: "text" as const, text: `No async subagent group ${selectedGroupId}.` }],
            details: { groupId: selectedGroupId, jobs: [] },
            isError: true,
          };
        }
        selected = group.jobIds.map((id) => jobs.get(id)).filter((job): job is AsyncJob => Boolean(job));
      } else if (hasTags) {
        const ids = [...new Set(params.tags!.map((tag: string) => tag.replace(/^#/, "").trim()).filter(Boolean))];
        selected = ids.map((id: string) => jobs.get(id)).filter((job): job is AsyncJob => Boolean(job));
        const missing = ids.filter((id: string) => !jobs.has(id));
        if (missing.length > 0) {
          return {
            content: [{ type: "text" as const, text: `No async subagent job${missing.length === 1 ? "" : "s"}: ${missing.map((id: string) => `#${id}`).join(", ")}.` }],
            details: { jobs: selected.map(jobDetails) },
            isError: true,
          };
        }
      } else {
        selected = Array.from(jobs.values()).filter((job) => job.status === "running");
      }

      if (selected.length === 0) {
        return {
          content: [{ type: "text" as const, text: selectedGroupId ? `Group ${selectedGroupId} has no retained jobs.` : "No active async subagent jobs." }],
          details: { groupId: selectedGroupId, outcome: "completed" as const, jobs: [] },
        };
      }

      // A wait owns notification suppression at the group level while it is
      // active. Collected job ids are recorded only after the wait returns, so
      // overlapping waits cannot clear each other's suppression state.
      const touchedGroups = new Map<string, AsyncGroup>();
      for (const job of selected) {
        const group = groups.get(job.groupId);
        if (group) touchedGroups.set(group.id, group);
      }
      for (const group of touchedGroups.values()) group.waiters++;

      const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const outcome = await waitForSubagentJobs(selected, timeoutMs, signal);
      if (outcome === "completed") {
        for (const job of selected) {
          const group = touchedGroups.get(job.groupId);
          group?.collectedJobIds.add(job.id);
        }
      }
      for (const group of touchedGroups.values()) {
        group.waiters = Math.max(0, group.waiters - 1);
        maybeDeliverCompletedGroup(group.id);
      }
      const completed = selected.filter((job) => job.status !== "running").length;
      const scope = selectedGroupId ? `group ${selectedGroupId}` : hasTags ? "selected jobs" : "all active jobs";
      const lines = [
        outcome === "completed"
          ? `Subagent wait completed for ${scope}: ${completed}/${selected.length} finished.`
          : outcome === "timeout"
            ? `Subagent wait timed out for ${scope}: ${completed}/${selected.length} finished. Remaining jobs continue running.`
            : `Subagent wait aborted for ${scope}: ${completed}/${selected.length} finished. Remaining jobs continue running.`,
        ...selected.map((job) => {
          const body = job.status === "done" ? job.answer ?? "(subagent returned no text)" : job.error ?? job.answer ?? "No result text.";
          return [``, `### #${job.id} ${job.status}`, body].join("\n");
        }),
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { groupId: selectedGroupId, outcome, jobs: selected.map(jobDetails) },
        isError: outcome === "aborted",
      };
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: "Check async subagent job or group status. Completed results are retained for later subagents_wait calls.",
    promptSnippet: "subagent_status(tag?, groupId?) — check async subagent jobs",
    parameters: Type.Object({
      tag: Type.Optional(Type.String({ description: "Job tag/id without leading #." })),
      groupId: Type.Optional(Type.String({ description: "Async group id returned by subagents_async." })),
    }),
    async execute(_toolCallId, params): Promise<ExtensionToolResult<SubagentStatusDetails>> {
      const tag = params.tag?.replace(/^#/, "");
      const groupId = params.groupId?.trim();
      if (tag && groupId) return { content: [{ type: "text" as const, text: "Choose either tag or groupId, not both." }], details: { jobs: [] }, isError: true };
      if (groupId && !groups.has(groupId)) return { content: [{ type: "text" as const, text: `No async subagent group ${groupId}.` }], details: { groupId, jobs: [] }, isError: true };

      const selected = groupId
        ? groups.get(groupId)!.jobIds.map((id) => jobs.get(id)).filter((j): j is AsyncJob => Boolean(j))
        : tag
          ? [jobs.get(tag)].filter((j): j is AsyncJob => Boolean(j))
          : Array.from(jobs.values());
      if (selected.length === 0) {
        const target = groupId ? `group ${groupId}` : tag ? `job #${tag}` : "jobs";
        return { content: [{ type: "text" as const, text: `No async subagent ${target}.` }], details: { groupId, jobs: [] } };
      }
      const lines = selected.map((j) => {
        const resultHint = j.status === "done" ? ` — result available via subagents_wait` : "";
        return `#${j.id} ${j.status} ${j.model} ${j.tools} ${formatElapsed(elapsedMs(j))} ${formatRunUsage(j)}${resultHint}`.trim();
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { groupId, jobs: selected.map(jobDetails) } };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Subagent Cancel",
    description: "Cancel a running async subagent job by tag/id.",
    promptSnippet: "subagent_cancel(tag) — cancel a running async subagent job",
    parameters: Type.Object({ tag: Type.String({ description: "Job tag/id without leading #." }) }),
    async execute(_toolCallId, params) {
      const tag = params.tag.replace(/^#/, "");
      const job = jobs.get(tag);
      if (!job) return { content: [{ type: "text" as const, text: `No async subagent job #${tag}.` }], details: {}, isError: true };
      if (job.status !== "running") return { content: [{ type: "text" as const, text: `Job #${tag} is already ${job.status}.` }], details: jobDetails(job) };
      job.status = "cancelled";
      job.abortReason = "cancelled";
      job.endedAt = Date.now();
      job.error = "cancelled by primary agent";
      settleJobCompletion(job);
      job.abortController.abort();
      updateWidget(widgetCtx, jobs, groups);
      return { content: [{ type: "text" as const, text: `Cancelled async subagent #${tag}.` }], details: jobDetails(job) };
    },
  });
}
