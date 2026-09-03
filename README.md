# pi-subagents

Configurable sync and async sub Pi agents for [Pi](https://pi.dev).

`pi-subagents` gives the orchestrating agent one core primitive:

> Run a fresh Pi subagent with this role, this task, this cwd, this model preset, and this tool policy.

It exposes:

- `subagent` — run one bespoke sub Pi agent synchronously
- `subagents_parallel` — run multiple sub Pi agents concurrently and wait for all results
- `subagents_async` — launch one or more bespoke sub Pi agents in the background
- `subagents_wait` — wait for selected async jobs and collect their results
- `subagent_status` — inspect async jobs and retained results
- `subagent_cancel` — cancel a running async job
- `/subagents-config` — inspect resolved config

Subagents have **no memory** of the parent conversation. Every task must include the context needed to do the job.

---

## Why use this?

Primary coding agents are good orchestrators, but broad reconnaissance and parallel review can pollute the parent context. Subagents let the primary agent delegate scoped jobs into fresh contexts and receive compact answers back.

Good uses:

- review several repos in parallel from a parent workspace directory
- map unfamiliar code before editing
- ask for independent role-based review, e.g. backend reviewer, frontend reviewer, migration reviewer
- run independent investigations in the background
- keep parent-session context focused on decisions and edits

Bad uses:

- making file changes
- running commands/tests that require bash
- async work whose result is required before the next step
- tasks that rely on parent-session memory but do not include the needed context

---

## Tools

## `subagent(role, task, cwd?, model, tools)`

Run one fresh sub Pi agent synchronously. Use when the next parent-agent step depends on the result.

Arguments:

| Field | Required | Meaning |
|---|---:|---|
| `role` | yes | Bespoke role/job framing for this subagent |
| `task` | yes | Self-contained task and all context needed |
| `cwd` | no | Working directory for `read_only` subagents; defaults to parent cwd |
| `model` | yes | Fixed model preset: `fast`, `smart`, or `coder` |
| `tools` | yes | Tool policy: `none` or `read_only` |

Example:

```text
subagent(
  role="You are a staff backend reviewer focused on API compatibility and database safety.",
  task="Review this repo's current change for correctness risks, missing tests, and integration concerns. Cite files.",
  cwd="./payroll-api",
  model="coder",
  tools="read_only"
)
```

---

## `subagents_parallel(tasks)`

Run multiple fresh sub Pi agents concurrently and wait for every result before returning. Use this when the parent needs the complete set of findings before continuing.

```text
subagents_parallel({
  tasks: [
    {
      role: "You are a backend reviewer.",
      task: "Review the API changes for correctness risks.",
      model: "coder",
      tools: "read_only"
    },
    {
      role: "You are a test reviewer.",
      task: "Review test coverage and missing regression cases.",
      model: "smart",
      tools: "read_only"
    }
  ]
})
```

This is a synchronization barrier. It runs the children in parallel, but the parent cannot continue until all children finish or the parent aborts.

---

## `subagents_async(tasks, deliver?, handoff?)`

Launch one or more fresh sub Pi agents in the background. Use for independent work that can run while the parent agent continues.

Arguments:

| Field | Required | Meaning |
|---|---:|---|
| `tasks` | yes | Array of subagent tasks |
| `deliver` | no | `followUp` or `steer`; defaults from config |
| `handoff` | no | If true, end the parent turn after launch; results arrive later as one grouped completion |

Each task has:

| Field | Required | Meaning |
|---|---:|---|
| `tag` | no, recommended | Stable async job id, e.g. `payroll-pr-review` |
| `role` | yes | Bespoke role/job framing |
| `task` | yes | Self-contained task |
| `cwd` | no | Working directory for `read_only` subagents |
| `model` | yes | `fast`, `smart`, or `coder` |
| `tools` | yes | `none` or `read_only` |

Example: review three repos from a parent workspace directory:

```text
subagents_async(
  tasks=[
    {
      tag="payroll-pr-review",
      cwd="./payroll-api",
      model="coder",
      tools="read_only",
      role="You are a staff backend engineer reviewing a payroll service PR.",
      task="Review this repo's current change for correctness risks, edge cases, missing tests, and integration issues. Cite files."
    },
    {
      tag="benefits-pr-review",
      cwd="./benefits-api",
      model="coder",
      tools="read_only",
      role="You are a staff backend engineer reviewing a benefits service PR.",
      task="Review this repo's current change for data consistency, API compatibility, migration risk, and missing tests. Cite files."
    },
    {
      tag="employee-web-pr-review",
      cwd="./employee-web",
      model="coder",
      tools="read_only",
      role="You are a senior frontend engineer reviewing a web app PR.",
      task="Review this repo's current change for UI regressions, state bugs, component misuse, and missing tests. Cite files."
    }
  ],
  deliver="followUp"
)
```

The launch response includes a `groupId` for collecting the whole batch. Completion results arrive later as one grouped user message after every job in the batch reaches a terminal state:

```md
Launched 3 async subagents in group g-abc123:
- #payroll-pr-review coder read_only (followUp)
- #benefits-pr-review coder read_only (followUp)
- #employee-web-pr-review coder read_only (followUp)
Use subagents_wait({ groupId: "g-abc123" }) before using these results.
```

The grouped completion normally has all child results together. If the parent successfully collects a subset with `subagents_wait`, those already-collected results may be omitted from the later notification and are called out in its header:

```md
Subagent group g-abc123 completed: 3/3 finished.
All results are included below.

### #payroll-pr-review completed
...

---

### #benefits-pr-review completed
...
```

---

## `subagents_wait(groupId?, tags?, all?, timeoutMs?)`

Wait for async subagent jobs to finish and return their results in the current tool result. This is a real synchronization barrier; it does not cancel children when the wait times out or is aborted.

Use the `groupId` returned by `subagents_async` when the next phase depends on the complete batch:

```text
subagents_wait(groupId="g-abc123")
```

Other selectors:

- `tags: ["api-review", "test-review"]` — wait for specific jobs
- `all: true` — wait for every async job active when the wait begins in this parent session
- `timeoutMs: 600000` — stop waiting after ten minutes; active children continue running

If the wait is aborted or times out, the child jobs keep running and the grouped completion remains available. Use `subagents_wait` again or `subagent_status` rather than launching duplicate replacements.

---

## `subagent_status(tag?, groupId?)`

Check async job status. Completed jobs are retained in bounded history for the current Pi session and can be collected later with `subagents_wait`.

Examples:

```text
subagent_status()
subagent_status(tag="payroll-pr-review")
subagent_status(groupId="g-abc123")
```

---

## `subagent_cancel(tag)`

Cancel a running async job.

Example:

```text
subagent_cancel(tag="payroll-pr-review")
```

---

## Tool policies

Subagents require an explicit tool policy.

| Policy | Tools | Use |
|---|---|---|
| `none` | no tools | Reasoning over context included in the task |
| `read_only` | `read`, `grep`, `find`, `ls` | Codebase inspection without mutation |

`read_only` subagents cannot run bash. For PR review, either ask them to inspect files directly or have the parent agent provide diffs in the task. A future policy may add constrained read-only git tools.

---

## Fixed model presets

The API uses three fixed semantic model presets:

| Preset | Meaning | Typical backing model |
|---|---|---|
| `fast` | Cheap, quick, disposable reconnaissance | Haiku / small fast model |
| `smart` | Balanced/default exploration and reasoning | Sonnet / strong general model |
| `coder` | Code-heavy analysis, implementation review, subtle debugging | Codex / Opus / strongest code model |

The preset names are intentionally fixed. The backing provider/model IDs are configurable.

Every subagent task requires an explicit `model`. There is no default.

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

Each configured provider/model pair must be available through one of:

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

Use `pi --list-models`, `/model`, or your provider extension docs to confirm provider/model IDs before putting them in `subagents.json`.

---

## Async delivery modes

`subagents_async` accepts optional `deliver`:

| Value | Behavior |
|---|---|
| `followUp` | Wait until the primary agent is idle before delivering the grouped result. Safest default. |
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

1. the launch tool starts background tasks
2. the launch tool immediately returns job ids
3. the parent agent continues
4. the group later injects one grouped user message after every child reaches a terminal state

The parent agent **cannot await an async result in the same reasoning chain** unless it explicitly calls `subagents_wait`. Use sync `subagent` for one dependent task, or use `subagents_parallel` / `subagents_async` followed by `subagents_wait({ groupId })` for a dependent batch.

Do not use `subagents_async` for work whose result you immediately need, and do not repeat an async subagent's investigation while it is running. Continue only with unrelated work or wait at the dependency boundary. Set `handoff: true` when the parent should end its current turn after launching instead of doing unrelated follow-up work; handoff ends the turn but does not itself wait.

---

## UI

`pi-subagents` renders custom tool rows showing:

- tool kind and model preset
- tool policy
- job id/tag and group id for async calls
- role and task preview
- cwd
- running/done/error status and retained completion state
- elapsed time
- token/cost summary
- read-only tool-call count
- expandable markdown answer

Async jobs appear in a persistent widget while running. Terminal results remain available through `subagent_status` and `subagents_wait` for the current Pi session:

```text
Subagents
⏳ #payroll-pr-review coder read_only 0:22 5 tools
✓ #migration-risk-review coder none 0:41 reasoning
```

---

## Prompting guidance for primary agents

Good parent-agent instructions:

```md
Use `subagent`/`subagents_async` aggressively for scoped work.

- Use `subagent` when the next step depends on one result.
- Use `subagents_parallel` when several parallel results are required before continuing.
- Use `subagents_async` only for work that is genuinely independent of the current task; parallelizable does not mean independent.
- If the next action depends on an async batch, call `subagents_wait` with its returned groupId before starting that action.
- Do not repeat an async subagent's investigation while it is running. Continue only with unrelated work or wait at the dependency boundary.
- Always provide a bespoke `role` and self-contained `task`.
- Always choose `model`: `fast`, `smart`, or `coder`.
- Always choose `tools`: `none` or `read_only`.
- Use `fast` for cheap reconnaissance, `smart` for balanced exploration/reasoning, and `coder` for code-heavy review/debugging.
- Use clear async tags when launching multiple subagents.
- Set `handoff: true` on `subagents_async` when the parent should end its current turn instead of doing unrelated follow-up work.
```

---

## Security model

`tools="none"` subagents are single no-tool model calls.

`tools="read_only"` subagents run isolated in-process Pi sessions with only read-only tools enabled:

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
