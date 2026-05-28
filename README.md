# pi-subagents

Configurable sync and async subagents for [Pi](https://pi.dev).

`pi-subagents` gives your primary agent a small set of delegation tools with isolated context windows:

- `consult` — synchronous no-tool reasoning helper
- `explore` — synchronous read-only codebase explorer
- `consult_async` — background reasoning helper; result arrives later
- `explore_async` — background read-only explorer; result arrives later
- `subagent_status` — inspect async jobs
- `subagent_cancel` — cancel a running async job
- `/subagents-config` — inspect resolved config

Subagents have **no memory** of the parent conversation. Every call must include the context needed to answer the question.

---

## Why use this?

Primary coding agents are good at steering work, but broad reconnaissance and side reasoning can pollute the parent context. Subagents let the primary agent offload scoped work into fresh contexts and receive a compact answer back.

Good uses:

- map an unfamiliar part of a repo before editing
- ask for independent review of a design or code snippet
- run multiple independent investigations in the background
- keep parent-session context focused on decisions and edits

Bad uses:

- making file changes
- running commands/tests that require bash
- anything that needs parent-session memory but was not included in the prompt
- async work whose result is required before the next step

---

## Fixed model presets

The tool API uses three fixed semantic model presets:

| Preset | Meaning | Typical backing model |
|---|---|---|
| `fast` | Cheap, quick, disposable reconnaissance | Haiku / small fast model |
| `smart` | Balanced/default exploration and reasoning | Sonnet / strong general model |
| `coder` | Code-heavy analysis, implementation review, subtle debugging | Codex / Opus / strongest code model |

The preset names are intentionally fixed. The backing provider/model IDs are configurable.

Every subagent tool call requires an explicit `model` value. There is no default.

---

## Install

### From git

```bash
pi install git:github.com/cullenbmacdonald/pi-subagents
```

### From a local checkout

```bash
pi install /Users/you/dev/pi-subagents
```

### For local development

Add the package path to `~/.pi/agent/settings.json` or a project `.pi/settings.json`:

```json
{
  "packages": ["/Users/you/dev/pi-subagents"]
}
```

Then restart Pi or run `/reload`.

---

## Configuration

Config files are merged in this order:

1. `~/.pi/agent/subagents.json`
2. `<cwd>/.pi/subagents.json`

Project-local config overrides global config.

### Required config

```json
{
  "models": {
    "fast": {
      "provider": "litellm",
      "model": "claude-haiku-4-5-20251001"
    },
    "smart": {
      "provider": "litellm",
      "model": "claude-sonnet-4-6"
    },
    "coder": {
      "provider": "litellm-openai",
      "model": "gpt-5.3-codex"
    }
  },
  "async": {
    "defaultDelivery": "followUp",
    "maxConcurrent": 4
  }
}
```

Required fields:

- `models.fast.provider`
- `models.fast.model`
- `models.smart.provider`
- `models.smart.model`
- `models.coder.provider`
- `models.coder.model`

Optional fields:

| Field | Values | Default | Meaning |
|---|---|---|---|
| `async.defaultDelivery` | `"followUp"`, `"steer"` | `"followUp"` | How async results are injected into the parent session |
| `async.maxConcurrent` | integer `1`–`16` | `4` | Max running async jobs |

Use the included example as a starting point:

```text
examples/subagents.json
```

Inside Pi, run:

```text
/subagents-config
```

to see the resolved config and model mapping.

---

## Provider requirements

`pi-subagents` does **not** register model providers. It consumes whatever providers/models are already available in Pi's model registry.

That means each configured provider/model pair must be available through one of:

- a built-in Pi provider, configured via API key or `/login`
- a provider extension package, such as a LiteLLM provider extension
- a custom provider registered by another Pi extension
- `~/.pi/agent/models.json` custom model config, when appropriate

For example, this config:

```json
{
  "models": {
    "fast": { "provider": "litellm", "model": "claude-haiku-4-5-20251001" },
    "smart": { "provider": "litellm", "model": "claude-sonnet-4-6" },
    "coder": { "provider": "litellm-openai", "model": "gpt-5.3-codex" }
  }
}
```

requires some other package/config to register providers named `litellm` and `litellm-openai` with those model IDs.

A project settings file might therefore load both a provider package and `pi-subagents`:

```json
{
  "packages": [
    "git:https://github.com/your-org/pi-litellm-provider.git",
    "git:github.com/cullenbmacdonald/pi-subagents"
  ]
}
```

If the provider/model is not registered, subagent calls fail with a clear error:

```text
subagents: configured model litellm/foo for preset smart is not registered.
```

Use `pi --list-models`, `/model`, or your provider extension docs to confirm the provider/model IDs before putting them in `subagents.json`.

---

## Tools

## `consult(question, context?, model)`

Ask a no-tool reasoning subagent a self-contained question. The subagent cannot read files or run commands.

Use for:

- architecture trade-offs
- code review of snippets you paste in
- reasoning over an error message
- asking for an independent opinion after you provide context

Example:

```text
consult(
  question="What race conditions do you see in this function?",
  context="<paste the relevant function and caller>",
  model="coder"
)
```

The answer is returned synchronously to the primary agent.

---

## `explore(question, cwd?, model)`

Ask a read-only codebase explorer a self-contained question. The subagent gets these tools only:

- `read`
- `grep`
- `find`
- `ls`

It cannot run bash, edit files, write files, load extensions, load skills, or use parent-session memory.

Use for:

- locating implementation areas
- summarizing existing architecture
- finding tests or conventions
- answering repo questions that would otherwise require many reads/greps

Example:

```text
explore(
  question="Find where authentication middleware is registered and summarize the request flow.",
  cwd="/Users/you/dev/app",
  model="smart"
)
```

The answer is returned synchronously to the primary agent.

---

## `consult_async(question, context?, model, tag?, deliver?)`

Launch a no-tool reasoning subagent in the background and return immediately.

Use only when the primary agent can continue without the answer.

Example:

```text
consult_async(
  question="Review this migration strategy for hidden risks.",
  context="<paste plan>",
  model="coder",
  tag="migration-risk-review"
)
```

When complete, the result is injected as a tagged user message:

```md
Subagent result #migration-risk-review completed.

Kind: consult
Model preset: coder
...

Result:
...
```

---

## `explore_async(question, cwd?, model, tag?, deliver?)`

Launch a read-only codebase explorer in the background and return immediately.

Use for independent reconnaissance while the primary agent continues other work.

Example:

```text
explore_async(
  question="Map the API route structure and identify auth boundaries.",
  cwd="/Users/you/dev/app",
  model="fast",
  tag="api-auth-map"
)
```

When complete, the result is injected as a tagged user message.

---

## `subagent_status(tag?)`

Check async job status.

Examples:

```text
subagent_status()
subagent_status(tag="api-auth-map")
```

---

## `subagent_cancel(tag)`

Cancel a running async job.

Example:

```text
subagent_cancel(tag="api-auth-map")
```

---

## Async delivery modes

Async tools accept optional `deliver`:

| Value | Behavior |
|---|---|
| `followUp` | Wait until the primary agent is idle before delivering the result. Safest default. |
| `steer` | Deliver after the current tool batch, before the next model turn. More interruptive. |

Default comes from config:

```json
{
  "async": {
    "defaultDelivery": "followUp"
  }
}
```

### Important async semantics

Pi tool calls are synchronous from the model's perspective. Async subagents are implemented as fire-and-forget background jobs:

1. the launch tool starts a background task
2. the launch tool immediately returns a job id
3. the primary agent continues
4. the background task later injects a tagged user message with the result

This means the primary agent **cannot await an async result in the same reasoning chain**. Use sync `consult` or `explore` if the next step depends on the answer.

---

## UI

`pi-subagents` renders custom tool rows showing:

- tool kind and model preset
- job id/tag for async calls
- question preview
- cwd for exploration
- running/done/error status
- elapsed time
- token/cost summary
- read-only tool-call count
- expandable markdown answer

Async jobs also appear in a persistent widget while running and for recent completions:

```text
Subagents
⏳ #api-auth-map explore fast 0:22 5 tools
✓ #migration-risk-review consult coder 0:41 reasoning
```

---

## Prompting guidance for primary agents

Good parent-agent instructions:

```md
Use subagents aggressively for independent work.

- Use `explore(..., model="smart")` when surveying unfamiliar code.
- Use `explore(..., model="fast")` for cheap, narrow reconnaissance.
- Use `consult(..., model="smart")` for general design/trade-off reasoning.
- Use `consult(..., model="coder")` for code-heavy review, subtle bugs, or implementation analysis.
- Use async variants only when the result does not block the next step.
- Always include all context the subagent needs; subagents have no memory of this conversation.
```

---

## Security model

`consult` and `consult_async` are single no-tool model calls.

`explore` and `explore_async` run isolated in-process Pi sessions with only read-only tools enabled:

- no bash
- no writes
- no edits
- no extensions
- no skills
- no prompt templates
- no context files

Async subagents should stay read-only/reasoning-only. Background write-capable agents are unsafe because the primary agent may edit the same files concurrently.

---

## Troubleshooting

### Missing config

If config is missing, tools return an error listing required fields:

```text
Missing required subagents config fields:
- models.fast.provider
- models.fast.model
...
```

Create one of:

```text
~/.pi/agent/subagents.json
<cwd>/.pi/subagents.json
```

### Model not registered

If a configured provider/model does not exist in Pi's model registry, the tool returns an error like:

```text
subagents: configured model litellm/foo for preset smart is not registered.
```

Check that your provider package is installed and that `/model` or `pi --list-models` can see the model.

### Auth error

If the provider exists but credentials are missing, the tool returns an API-key/auth error.

Check environment variables, OAuth login, or provider extension configuration.

---

## Package development

```bash
npm install
npm run typecheck
npm test
```

Dry-run package contents:

```bash
npm pack --dry-run
```

---

## Package layout

```text
pi-subagents/
├── extensions/
│   └── subagents.ts
├── examples/
│   └── subagents.json
├── tests/
│   └── subagents.test.ts
├── README.md
├── package.json
└── tsconfig.json
```

`package.json` exposes the extension through the Pi package manifest:

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```
