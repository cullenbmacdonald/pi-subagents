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
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  getMarkdownTheme,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type, complete, type Context } from "@earendil-works/pi-ai";
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
  abortController: AbortController;
  deliver: AsyncDelivery;
}

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

function elapsedMs(run: RunResult): number {
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

async function resolveConfiguredModel(ctx: ExtensionContext, preset: SubagentModelPreset): Promise<{ ok: true; provider: string; modelId: string; model: any; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }> {
  const configResult = loadSubagentsConfig(ctx.cwd);
  if (!configResult.ok) return { ok: false, error: configResult.error };
  const selected = configResult.config.models[preset];
  const model = ctx.modelRegistry.find(selected.provider, selected.model);
  if (!model) {
    return { ok: false, error: `subagents: configured model ${selected.provider}/${selected.model} for preset ${preset} is not registered.` };
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { ok: false, error: `subagents: could not resolve API key for ${selected.provider}: ${auth.error}` };
  return { ok: true, provider: selected.provider, modelId: selected.model, model, apiKey: auth.apiKey, headers: auth.headers };
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

  const resolved = await resolveConfiguredModel(ctx, input.model);
  if (!resolved.ok) return { ...run, status: "error", endedAt: Date.now(), error: resolved.error };
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

    const { session } = await createAgentSessionShim({
      cwd,
      agentDir: getAgentDir(),
      model: resolved.model,
      thinkingLevel: "off",
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
      tools: ["read", "grep", "find", "ls"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
    });

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

function formatRunUsage(run: RunResult): string {
  const parts: string[] = [];
  if (run.tokensIn || run.tokensOut) parts.push(`↑${formatTokens(run.tokensIn)} ↓${formatTokens(run.tokensOut)}`);
  if (run.costUsd) parts.push(formatCost(run.costUsd));
  if (run.tools === "read_only") parts.push(`${run.toolCalls.length} tools`);
  return parts.join(" · ");
}

function makeJobId(tag?: string): string {
  const cleaned = tag?.trim().replace(/^#/, "").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned) return cleaned;
  return `s-${Date.now().toString(36).slice(-5)}-${Math.random().toString(36).slice(2, 5)}`;
}

function jobToMessage(job: AsyncJob): string {
  const status = job.status === "done" ? "completed" : job.status;
  const body = job.status === "done" ? job.answer : job.error ?? job.answer ?? "No result text.";
  return [
    `Subagent result #${job.id} ${status}.`,
    "",
    `Model preset: ${job.model}`,
    `Tool policy: ${job.tools}`,
    job.modelId ? `Model: ${job.provider}/${job.modelId}` : undefined,
    job.cwd ? `CWD: ${job.cwd}` : undefined,
    `Elapsed: ${formatElapsed(elapsedMs(job))}`,
    `Usage: ${formatRunUsage(job) || "n/a"}`,
    "",
    "Role:",
    job.role,
    "",
    "Task:",
    job.task,
    "",
    "Result:",
    body,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function updateWidget(ctx: ExtensionContext | undefined, jobs: Map<string, AsyncJob>) {
  if (!ctx?.hasUI) return;
  const active = Array.from(jobs.values()).filter((j) => j.status === "running");
  const recentDone = Array.from(jobs.values()).filter((j) => j.status !== "running").slice(-3);
  const shown = [...active, ...recentDone];
  if (shown.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }
  const lines = ["Subagents"];
  for (const job of shown) {
    const icon = job.status === "running" ? "⏳" : job.status === "done" ? "✓" : "✗";
    const activity = job.tools === "read_only" ? `${job.toolCalls.length} tools` : "reasoning";
    lines.push(`${icon} #${job.id} ${job.model} ${job.tools} ${formatElapsed(elapsedMs(job))} ${activity}`);
  }
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
  let widgetCtx: ExtensionContext | undefined;

  pi.on("session_start", (_event, ctx) => {
    widgetCtx = ctx;
    updateWidget(widgetCtx, jobs);
  });

  pi.on("session_shutdown", () => {
    for (const job of jobs.values()) {
      if (job.status === "running") {
        job.status = "aborted";
        job.endedAt = Date.now();
        job.error = "session shut down before subagent completed";
        job.abortController.abort();
      }
    }
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
  const subagentTaskSchema = Type.Object({
    tag: Type.Optional(Type.String({ description: "Optional stable async job tag, e.g. repo-a-review." })),
    role: Type.String({ description: "Bespoke role/job framing for this subagent, e.g. 'You are a staff backend reviewer focused on API compatibility.'" }),
    task: Type.String({ description: "Self-contained task. Include all context the subagent needs; it has no parent memory." }),
    cwd: Type.Optional(Type.String({ description: "Working directory for read_only subagents. Relative paths resolve from the parent agent cwd." })),
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
      "Use subagents_async for independent work that can run while you continue. Use subagent when the next step depends on the result.",
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

  function launchAsync(input: SubagentInput & { tag?: string; deliver?: AsyncDelivery }, ctx: ExtensionContext): AsyncJob | { error: string } {
    const configResult = loadSubagentsConfig(ctx.cwd);
    if (!configResult.ok) return { error: configResult.error };
    const running = Array.from(jobs.values()).filter((j) => j.status === "running").length;
    if (running >= configResult.config.async.maxConcurrent) return { error: `subagents: async concurrency limit reached (${running}/${configResult.config.async.maxConcurrent}).` };

    const id = makeJobId(input.tag);
    if (jobs.has(id)) return { error: `subagents: job #${id} already exists.` };
    const abortController = new AbortController();
    const job: AsyncJob = {
      ...input,
      id,
      execution: "async",
      cwd: input.cwd ? expandHome(input.cwd) : ctx.cwd,
      status: "running",
      startedAt: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      toolCalls: [],
      abortController,
      deliver: input.deliver ?? configResult.config.async.defaultDelivery,
    };
    jobs.set(id, job);
    widgetCtx = ctx;
    updateWidget(widgetCtx, jobs);

    void (async () => {
      const update = (partial: RunResult) => {
        Object.assign(job, { ...partial, id, execution: "async", abortController, deliver: job.deliver });
        updateWidget(widgetCtx, jobs);
      };
      const result = await runSubagent(input, "async", abortController.signal, ctx, update);
      Object.assign(job, { ...result, id, execution: "async", abortController, deliver: job.deliver });
      if (job.status === "aborted" && abortController.signal.aborted) job.status = "cancelled";
      job.endedAt = Date.now();
      updateWidget(widgetCtx, jobs);
      pi.appendEntry("pi-subagents:job", {
        id: job.id,
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
      pi.sendUserMessage(jobToMessage(job), { deliverAs: job.deliver });
    })().catch((err) => {
      job.status = "error";
      job.endedAt = Date.now();
      job.error = err instanceof Error ? err.message : String(err);
      updateWidget(widgetCtx, jobs);
      pi.sendUserMessage(jobToMessage(job), { deliverAs: job.deliver });
    });

    return job;
  }

  pi.registerTool({
    name: "subagents_async",
    label: "Subagents Async",
    description: "Launch one or more fresh sub Pi agents in the background. Each task supplies a bespoke role, task, cwd, required model preset, required tool policy, and optional tag. Results arrive later as tagged user messages.",
    promptSnippet: "subagents_async(tasks, deliver?) — launch one or more bespoke sub Pi agents in the background",
    promptGuidelines: [
      "Use subagents_async for independent work that does not block your next step, including parallel review/exploration across multiple repos.",
      "Use one task per repo/scope. Give each task a clear tag so results can be correlated.",
      "Every async subagent task must choose model and tools explicitly.",
      "Use subagent instead when the next action depends on the result.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(subagentTaskSchema, { minItems: 1, maxItems: 8, description: "Subagent tasks to launch." }),
      deliver: Type.Optional(deliverSchema),
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

      const launched: AsyncJob[] = [];
      const errors: string[] = [];
      for (const task of tasks) {
        const input = {
          role: task.role ?? "You are a helpful subagent.",
          task: task.task ?? "",
          cwd: task.cwd,
          model: task.model as SubagentModelPreset,
          tools: task.tools as SubagentToolPolicy,
          tag: task.tag,
          deliver: params.deliver,
        };
        const result = launchAsync(input, ctx);
        if ("abortController" in result) launched.push(result);
        else errors.push(result.error);
      }

      const lines = [
        launched.length > 0 ? `Launched ${launched.length} async subagent${launched.length === 1 ? "" : "s"}:` : "No subagents launched.",
        ...launched.map((j) => `- #${j.id} ${j.model} ${j.tools} (${j.deliver})`),
        ...errors.map((e) => `- error: ${e}`),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { launched, errors }, isError: errors.length > 0 };
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: "Check async subagent job status. Omit tag to list all jobs.",
    promptSnippet: "subagent_status(tag?) — check async subagent jobs",
    parameters: Type.Object({ tag: Type.Optional(Type.String({ description: "Job tag/id without leading #." })) }),
    async execute(_toolCallId, params) {
      const tag = params.tag?.replace(/^#/, "");
      const selected = tag ? [jobs.get(tag)].filter((j): j is AsyncJob => Boolean(j)) : Array.from(jobs.values());
      if (selected.length === 0) return { content: [{ type: "text" as const, text: tag ? `No async subagent job #${tag}.` : "No async subagent jobs." }], details: { jobs: [] } };
      const lines = selected.map((j) => `#${j.id} ${j.status} ${j.model} ${j.tools} ${formatElapsed(elapsedMs(j))} ${formatRunUsage(j)}`.trim());
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { jobs: selected.map(({ abortController: _a, ...j }) => j) } };
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
      if (job.status !== "running") return { content: [{ type: "text" as const, text: `Job #${tag} is already ${job.status}.` }], details: job };
      job.status = "cancelled";
      job.endedAt = Date.now();
      job.error = "cancelled by primary agent";
      job.abortController.abort();
      updateWidget(widgetCtx, jobs);
      return { content: [{ type: "text" as const, text: `Cancelled async subagent #${tag}.` }], details: job };
    },
  });
}
