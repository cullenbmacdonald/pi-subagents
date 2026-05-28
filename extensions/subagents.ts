/**
 * Pi Subagents Extension
 *
 * Configurable sync + async subagents with fixed semantic model presets:
 * fast, smart, coder.
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
type SubagentKind = "consult" | "explore";
type AsyncDelivery = "steer" | "followUp";
type JobStatus = "running" | "done" | "error" | "aborted" | "cancelled";

const MODEL_PRESETS = ["fast", "smart", "coder"] as const;
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

interface RunResult {
  id?: string;
  kind: SubagentKind;
  execution: "sync" | "async";
  question: string;
  context?: string;
  cwd?: string;
  modelPreset: SubagentModelPreset;
  provider?: string;
  model?: string;
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

const CONSULT_SYSTEM_PROMPT = `You are a reasoning helper spawned by another AI coding agent.

You have NO memory of any prior conversation and NO tools to read files or run commands. Answer only from the information in the user's question and your own knowledge.

If the question requires inspecting files you don't have, say so plainly — don't guess. Suggest what the caller should look at themselves.

Be concise. Prefer a few sentences or short bullets. Your answer goes directly back to the calling agent.`;

const EXPLORE_SYSTEM_PROMPT = `You are a read-only codebase explorer spawned by another AI coding agent. Your job is to answer a single self-contained question about the codebase, then stop.

You have read, grep, find, and ls tools — use them freely. You do NOT have bash, edit, or write. You have NO memory of any prior conversation — treat the question as standalone.

Rules:
- Be concise. Answer the exact question asked, with citations (file_path:line_number) when possible.
- When you have enough to answer, stop calling tools and write the final answer.
- If the question is unanswerable from the codebase, say so plainly — don't speculate.
- No code changes, no suggestions for changes. Describe only what exists.

Your answer goes directly back to the calling agent — no greetings, no preamble.`;

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

function firstText(content: Array<{ type: string; text?: string }>): string {
  return content.find((c) => c.type === "text")?.text ?? "";
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

function summarizeQuestion(question: string, max = 90): string {
  const compact = question.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function modelGuidance(): string {
  return "Required model preset: fast for cheap quick reconnaissance, smart for balanced/default reasoning, coder for code-heavy analysis/review/debugging.";
}

function configErrorResult(kind: SubagentKind, execution: "sync" | "async", modelPreset: SubagentModelPreset, question: string, error: string) {
  const result: RunResult = {
    kind,
    execution,
    modelPreset,
    question,
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

async function runConsult(params: { question: string; context?: string; model: SubagentModelPreset }, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: (partial: RunResult) => void): Promise<RunResult> {
  const startedAt = Date.now();
  const run: RunResult = {
    kind: "consult",
    execution: "sync",
    question: params.question,
    context: params.context,
    modelPreset: params.model,
    status: "running",
    startedAt,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    toolCalls: [],
  };
  onUpdate?.(run);

  const resolved = await resolveConfiguredModel(ctx, params.model);
  if (!resolved.ok) return { ...run, status: "error", endedAt: Date.now(), error: resolved.error };
  run.provider = resolved.provider;
  run.model = resolved.modelId;
  onUpdate?.(run);

  const userText = params.context ? `Context:\n${params.context}\n\nQuestion: ${params.question}` : params.question;
  const context: Context = {
    systemPrompt: CONSULT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userText, timestamp: Date.now() }],
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
      error: result.stopReason === "aborted" ? "consult aborted" : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...run, status: signal?.aborted ? "aborted" : "error", endedAt: Date.now(), error: message };
  }
}

async function runExplore(params: { question: string; cwd?: string; model: SubagentModelPreset }, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: (partial: RunResult) => void): Promise<RunResult> {
  const startedAt = Date.now();
  const subagentCwd = expandHome(params.cwd ?? ctx.cwd);
  const run: RunResult = {
    kind: "explore",
    execution: "sync",
    question: params.question,
    cwd: subagentCwd,
    modelPreset: params.model,
    status: "running",
    startedAt,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    toolCalls: [],
  };
  onUpdate?.(run);

  const resolved = await resolveConfiguredModel(ctx, params.model);
  if (!resolved.ok) return { ...run, status: "error", endedAt: Date.now(), error: resolved.error };
  run.provider = resolved.provider;
  run.model = resolved.modelId;
  onUpdate?.(run);

  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });

    const loader = new DefaultResourceLoader({
      cwd: subagentCwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: EXPLORE_SYSTEM_PROMPT,
    });
    await loader.reload();

    const { session } = await createAgentSessionShim({
      cwd: subagentCwd,
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
      await session.prompt(params.question);
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", abortHandler);
    }

    if (signal?.aborted) return { ...run, status: "aborted", endedAt: Date.now(), answer, error: "explore aborted" };
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
  const text = run.status === "done" ? (run.answer ?? "(subagent returned no text)") : `${run.kind} ${run.status}: ${run.error ?? run.answer ?? "no details"}`;
  return {
    content: [{ type: "text" as const, text }],
    details: run,
    isError: run.status !== "done",
  };
}

function renderRun(run: RunResult, expanded: boolean, theme: Theme) {
  const icon = getStatusIcon(run.status, theme);
  const title = `${icon} ${theme.fg("toolTitle", theme.bold(run.execution === "async" ? `${run.kind}_async` : run.kind))} ${theme.fg("accent", run.modelPreset)}`;
  const meta: string[] = [];
  if (run.id) meta.push(`#${run.id}`);
  if (run.model) meta.push(run.model);
  if (run.kind === "explore" && run.cwd) meta.push(run.cwd);
  meta.push(formatElapsed(elapsedMs(run)));

  if (!expanded) {
    let text = `${title} ${theme.fg("muted", meta.join(" · "))}`;
    text += `\n  ${theme.fg("dim", summarizeQuestion(run.question))}`;
    if (run.status === "running") {
      const activity = run.kind === "explore" ? `${run.toolCalls.length} tool calls` : "reasoning";
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
  container.addChild(new Text(theme.fg("muted", "─── Question ───"), 0, 0));
  container.addChild(new Text(theme.fg("dim", run.question), 0, 0));
  if (run.context) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Provided Context ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", run.context), 0, 0));
  }
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
  if (run.kind === "explore") parts.push(`${run.toolCalls.length} tools`);
  return parts.join(" · ");
}

function makeJobId(kind: SubagentKind, tag?: string): string {
  const cleaned = tag?.trim().replace(/^#/, "").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned) return cleaned;
  const prefix = kind === "explore" ? "x" : "c";
  return `${prefix}-${Date.now().toString(36).slice(-5)}-${Math.random().toString(36).slice(2, 5)}`;
}

function jobToMessage(job: AsyncJob): string {
  const status = job.status === "done" ? "completed" : job.status;
  const body = job.status === "done" ? job.answer : job.error ?? job.answer ?? "No result text.";
  return [
    `Subagent result #${job.id} ${status}.`,
    "",
    `Kind: ${job.kind}`,
    `Model preset: ${job.modelPreset}`,
    job.model ? `Model: ${job.provider}/${job.model}` : undefined,
    job.cwd ? `CWD: ${job.cwd}` : undefined,
    `Elapsed: ${formatElapsed(elapsedMs(job))}`,
    `Usage: ${formatRunUsage(job) || "n/a"}`,
    "",
    "Question:",
    job.question,
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
    const activity = job.kind === "explore" ? `${job.toolCalls.length} tools` : "reasoning";
    lines.push(`${icon} #${job.id} ${job.kind} ${job.modelPreset} ${formatElapsed(elapsedMs(job))} ${activity}`);
  }
  ctx.ui.setWidget(WIDGET_KEY, lines);
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
  const deliverSchema = StringEnum(DELIVERY_OPTIONS, { description: "How to inject async results: steer interrupts at the next tool boundary; followUp waits until the agent is idle." });

  pi.registerTool({
    name: "consult",
    label: "Consult",
    description: "Ask a self-contained reasoning question in a fresh context (no memory, no tools). Requires explicit model preset: fast, smart, or coder.",
    promptSnippet: "consult(question, context?, model) — required model preset; one-shot no-tool reasoning subagent",
    promptGuidelines: [
      "Use consult for strategy, trade-off, design, debugging, or code-review questions where the answer comes from reasoning over supplied context rather than reading files.",
      "Every consult call must choose model: fast for cheap quick reasoning, smart for balanced reasoning, coder for code-heavy analysis/review/debugging.",
      "Consult has no memory and no tools. Include all needed snippets, errors, constraints, and prior decisions in the question/context.",
      "If the answer needs reading files, use explore instead of consult.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "A self-contained reasoning question." }),
      context: Type.Optional(Type.String({ description: "Optional context to prepend to the question." })),
      model: modelSchema,
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const run = await runConsult(params, signal, ctx, (partial) => onUpdate?.({ content: [{ type: "text", text: `${partial.kind} running on ${partial.modelPreset}…` }], details: partial }));
      return runToToolResult(run);
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("consult "))}${theme.fg("accent", args.model ?? "model?")}\n  ${theme.fg("dim", summarizeQuestion(args.question ?? "…"))}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) { return renderRun(result.details as RunResult, expanded, theme); },
  });

  pi.registerTool({
    name: "explore",
    label: "Explore",
    description: "Ask a self-contained codebase question; a read-only subagent with read/grep/find/ls answers it. Requires explicit model preset: fast, smart, or coder.",
    promptSnippet: "explore(question, cwd?, model) — required model preset; read-only codebase exploration subagent",
    promptGuidelines: [
      "Prefer explore over stacking many read/grep calls in the primary context, especially when surveying unfamiliar code or more than a few files.",
      "Every explore call must choose model: fast for cheap reconnaissance, smart for default/balanced exploration, coder for code-heavy architecture/debugging investigation.",
      "Phrase the question self-contained. The explore subagent has no memory of this conversation.",
      "Explore is read-only: it cannot run bash or make changes. If command output or edits are needed, do that in the primary agent.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "A self-contained codebase question. Include repo/path context if ambiguous." }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the subagent. Defaults to current cwd." })),
      model: modelSchema,
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const run = await runExplore(params, signal, ctx, (partial) => onUpdate?.({ content: [{ type: "text", text: `${partial.kind} running on ${partial.modelPreset}: ${partial.toolCalls.length} tool calls…` }], details: partial }));
      return runToToolResult(run);
    },
    renderCall(args, theme) {
      const cwdText = args.cwd ? ` ${theme.fg("muted", args.cwd)}` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("explore "))}${theme.fg("accent", args.model ?? "model?")}${cwdText}\n  ${theme.fg("dim", summarizeQuestion(args.question ?? "…"))}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) { return renderRun(result.details as RunResult, expanded, theme); },
  });

  function launchAsync(kind: SubagentKind, params: { question: string; context?: string; cwd?: string; model: SubagentModelPreset; tag?: string; deliver?: AsyncDelivery }, ctx: ExtensionContext): AsyncJob | { error: string } {
    const configResult = loadSubagentsConfig(ctx.cwd);
    if (!configResult.ok) return { error: configResult.error };
    const running = Array.from(jobs.values()).filter((j) => j.status === "running").length;
    if (running >= configResult.config.async.maxConcurrent) return { error: `subagents: async concurrency limit reached (${running}/${configResult.config.async.maxConcurrent}).` };

    const id = makeJobId(kind, params.tag);
    if (jobs.has(id)) return { error: `subagents: job #${id} already exists.` };
    const abortController = new AbortController();
    const job: AsyncJob = {
      id,
      kind,
      execution: "async",
      question: params.question,
      context: params.context,
      cwd: params.cwd ? expandHome(params.cwd) : undefined,
      modelPreset: params.model,
      status: "running",
      startedAt: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      toolCalls: [],
      abortController,
      deliver: params.deliver ?? configResult.config.async.defaultDelivery,
    };
    jobs.set(id, job);
    widgetCtx = ctx;
    updateWidget(widgetCtx, jobs);

    void (async () => {
      const update = (partial: RunResult) => {
        Object.assign(job, { ...partial, id, execution: "async", abortController, deliver: job.deliver });
        updateWidget(widgetCtx, jobs);
      };
      const result = kind === "consult"
        ? await runConsult({ question: params.question, context: params.context, model: params.model }, abortController.signal, ctx, update)
        : await runExplore({ question: params.question, cwd: params.cwd, model: params.model }, abortController.signal, ctx, update);
      Object.assign(job, { ...result, id, execution: "async", abortController, deliver: job.deliver });
      if (job.status === "aborted" && abortController.signal.aborted) job.status = "cancelled";
      job.endedAt = Date.now();
      updateWidget(widgetCtx, jobs);
      pi.appendEntry("pi-subagents:job", {
        id: job.id,
        kind: job.kind,
        modelPreset: job.modelPreset,
        question: job.question,
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
    name: "consult_async",
    label: "Consult Async",
    description: "Launch a reasoning subagent in the background and return immediately. The result arrives later as a tagged follow-up/steering user message. Requires explicit model preset.",
    promptSnippet: "consult_async(question, context?, model, tag?, deliver?) — launch no-tool reasoning in background",
    promptGuidelines: [
      "Use consult_async only for independent reasoning that does not block your next step; results arrive later as a tagged user message.",
      "Use sync consult when the next action depends on the answer.",
      "Always provide a meaningful tag when launching multiple async subagents so you can correlate results.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "A self-contained reasoning question." }),
      context: Type.Optional(Type.String({ description: "Optional context to prepend to the question." })),
      model: modelSchema,
      tag: Type.Optional(Type.String({ description: "Optional stable job tag, e.g. auth-review." })),
      deliver: Type.Optional(deliverSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const launchParams = { ...params, question: params.question ?? "", model: params.model as SubagentModelPreset };
      const launched = launchAsync("consult", launchParams, ctx);
      if (!("abortController" in launched)) return configErrorResult("consult", "async", launchParams.model, launchParams.question, launched.error);
      return { content: [{ type: "text" as const, text: `Launched async consult #${launched.id}. Result will arrive via ${launched.deliver}.` }], details: launched };
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", theme.bold("consult_async "))}${theme.fg("accent", args.model ?? "model?")} ${theme.fg("muted", args.tag ? `#${args.tag}` : "") }\n  ${theme.fg("dim", summarizeQuestion(args.question ?? "…"))}`, 0, 0); },
    renderResult(result, { expanded }, theme) { return renderRun(result.details as RunResult, expanded, theme); },
  });

  pi.registerTool({
    name: "explore_async",
    label: "Explore Async",
    description: "Launch a read-only codebase exploration subagent in the background and return immediately. The result arrives later as a tagged follow-up/steering user message. Requires explicit model preset.",
    promptSnippet: "explore_async(question, cwd?, model, tag?, deliver?) — launch read-only codebase exploration in background",
    promptGuidelines: [
      "Use explore_async for independent codebase reconnaissance that can run while you continue other work.",
      "Use sync explore when the next action depends on the answer.",
      "Always provide a meaningful tag when launching multiple async subagents so you can correlate results.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "A self-contained codebase question." }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the subagent. Defaults to current cwd." })),
      model: modelSchema,
      tag: Type.Optional(Type.String({ description: "Optional stable job tag, e.g. auth-map." })),
      deliver: Type.Optional(deliverSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const launchParams = { ...params, question: params.question ?? "", model: params.model as SubagentModelPreset };
      const launched = launchAsync("explore", launchParams, ctx);
      if (!("abortController" in launched)) return configErrorResult("explore", "async", launchParams.model, launchParams.question, launched.error);
      return { content: [{ type: "text" as const, text: `Launched async explore #${launched.id}. Result will arrive via ${launched.deliver}.` }], details: launched };
    },
    renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", theme.bold("explore_async "))}${theme.fg("accent", args.model ?? "model?")} ${theme.fg("muted", args.tag ? `#${args.tag}` : "") }\n  ${theme.fg("dim", summarizeQuestion(args.question ?? "…"))}`, 0, 0); },
    renderResult(result, { expanded }, theme) { return renderRun(result.details as RunResult, expanded, theme); },
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
      const lines = selected.map((j) => `#${j.id} ${j.status} ${j.kind} ${j.modelPreset} ${formatElapsed(elapsedMs(j))} ${formatRunUsage(j)}`.trim());
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
