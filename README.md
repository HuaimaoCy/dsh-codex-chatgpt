# dsh-codex-chatgpt

Use the ChatGPT models from the **local Codex desktop app** inside DeepSeek Harness.

The plugin registers one first-class DSH LLM provider route backed by `codex app-server`, reusing the ChatGPT sign-in the desktop app already holds. It also ships three read-only tools for inspecting Codex conversations.

| | |
|---|---|
| Provider route id | `codex-chatgpt` |
| Display name | `ChatGPT (Codex)` |
| Plugin version | 0.1.0 |
| Measured against | `codex-cli 0.155.0-alpha.16.4` |
| Half | Host only (no browser half, no HMR for this plugin) |

## What it does

- **Registers a provider route.** The ChatGPT models served by the local app-server become selectable as a DSH session's model, and can be dispatched to a subagent by model id like any other provider.
- **Reuses the desktop app's ChatGPT login.** The plugin never holds a token of its own: it copies the credential file `auth.json` from the desktop app's directory into a private `CODEX_HOME` that the plugin owns (`src/config.js`).
- **Never touches `~/.codex`.** The running desktop app holds that directory's sqlite state runtime exclusively; a second app-server pointed there fails with `failed to initialize state runtime`. The plugin builds a private home instead.
- **Never copies `config.toml`.** The desktop config enables marketplaces, plugins and MCP servers, each of which would add startup cost and side effects to every DSH model call. Only the credential is inherited, and an empty `config.toml` is written unconditionally so a stale one cannot steer the private home.
- **Reuses one Codex thread per DSH session**, because thread reuse is the difference between a usable provider and an unusable one (see [Latency](#latency-why-threads-are-reused)). Reuse is conservative: a wrong "rebuild" only costs latency, a wrong "reuse" would corrupt the conversation, so `src/plan.js` proves the cached thread is still a prefix of the DSH transcript before anything is appended.
- **Adds three conversation-access tools** over the app-server's stored threads and the desktop app's session index.

## Requirements

- **Codex desktop app installed and signed in** with a ChatGPT plan. Verified locally with **ChatGPT Plus**.
- **Windows for automatic executable discovery.** Auto-detection looks for `%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe` and takes the highest build name. On other platforms (or a non-default install) set `codexExecutable` explicitly.
- **Node.js >= 22.5.0** (`engines` in `package.json`).
- **A DSH profile** that loads this plugin. This plugin injects only `llm`; when no `tools` service exists, the provider route still registers and the three tools are skipped.

## Models

`listModels` never blocks on the app-server — it is called while a model picker renders, and a cold handshake is far too slow to await. Until a live `model/list` reply arrives, the built-in list below is what the picker shows (`FALLBACK_MODELS` in `src/adapter.js`). A successful interrogation replaces it; the result is refreshed at most once per 10 minutes and hidden models are filtered out.

| Model id | Name | Note |
|---|---|---|
| `gpt-6-astra` | GPT-6-Astra | Default Codex model on a ChatGPT plan |
| `gpt-6-sol` | GPT-6-Sol | Codex code-reasoning model |
| `gpt-6-luna` | GPT-6-Luna | Codex general model |
| `gpt-5.6-sol` | GPT-5.6-Sol | Previous generation |
| `gpt-5.6-terra` | GPT-5.6-Terra | Previous generation |
| `gpt-5.6-luna` | GPT-5.6-Luna | Previous generation |
| `gpt-5.5` | GPT-5.5 | Previous generation |

These seven are the models observed on this machine's ChatGPT Plus account. The account's real catalog comes from the app-server's `model/list`; an account with different entitlements can legitimately advertise a different set.

Metadata reported per model:

- **Input modalities**: `['text']` only.
- **Context window**: whatever `model/list` reports, otherwise an assumed `258400` (`DEFAULT_CONTEXT_WINDOW`).
- **Reasoning efforts**: whatever the model advertises, otherwise `low`, `medium`, `high`, `xhigh`, `ultra`, `max`.

## Install

From the checkout that provides the `dsh` CLI:

```powershell
# 1. Add the plugin to the web profile (absolute path to this directory).
pnpm dsh plugin --profile web add "C:\path\to\dsh-codex-chatgpt"

# 2. Verify the layer is in the composed config.
pnpm dsh --profile web --dump-config
```

Then **restart the `dsh web` process** — the same command you use to start the GUI.

Step 2 is the cheap check that the install took: the composed config should show an inserted layer whose `name` is `dsh-codex-chatgpt` and whose config is the contents of [`cordis.patch.yml`](./cordis.patch.yml).

### Why a restart is mandatory

This plugin is **host-side**. Host plugin code is loaded when the `dsh web` process starts; there is no hot path for it, and this plugin has no browser half to hot-reload. Only browser-side (client plugin) changes go through HMR. Every host-side edit — including edits to `index.js` and `src/` — needs a full restart of `dsh web`.

Once running, pick the provider in DSH's model picker (route `codex-chatgpt`, display name `ChatGPT (Codex)`).

## Configuration

All keys are optional; the defaults below are what [`cordis.patch.yml`](./cordis.patch.yml) ships and what `CONFIG_DEFAULTS` in `src/config.js` encodes. `approvalPolicy`, `sandbox`, `turnTimeoutMs` and `startupTimeoutMs` are validated and rejected at load when invalid.

| Key | Default | Meaning |
|---|---|---|
| `provider` | `codex-chatgpt` | Provider route key registered on `ctx.llm`. Non-empty string. |
| `providerName` | `ChatGPT (Codex)` | Display name shown in the model picker. Non-empty string. |
| `codexExecutable` | `''` (auto-detect) | Absolute path to the Codex executable. Resolution order: configured value → `DSH_CODEX_EXECUTABLE` env var → newest build under `%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe`. |
| `codexHome` | `''` → `~/.dsh/codex-chatgpt` | Private `CODEX_HOME`. Must **not** be `~/.codex`; the desktop app holds that directory's sqlite state runtime exclusively. |
| `authSource` | `''` → `~/.codex` | Directory the ChatGPT credential (`auth.json`) is copied from. Also the directory `codex_desktop_sessions` reads `session_index.jsonl` from. |
| `cwd` | `''` → `process.cwd()` | Workspace passed to `thread/start` and used as the child's working directory. Resolved to an absolute path. |
| `approvalPolicy` | `never` | One of `never`, `on-request`, `on-failure`, `untrusted`. |
| `sandbox` | `read-only` | One of `read-only`, `workspace-write`, `danger-full-access`. |
| `reasoningEffort` | `''` (inherit) | Default effort for a turn when the DSH request does not name one. Empty means "inherit the model's own default". A per-request effort always wins. |
| `baseInstructions` | `null` | Fallback system prompt for a thread when the request carries none. `null` means Codex uses its own agent system prompt. |
| `turnTimeoutMs` | `900000` (15 min) | Hard ceiling for one Codex turn. Positive finite number. |
| `startupTimeoutMs` | `120000` (2 min) | Ceiling for the handshake, for `thread/start`, and for each individual protocol request such as `turn/start` and `model/list`. Positive finite number. |
| `ephemeralThreads` | `true` | When true, `thread/start` is asked for an ephemeral thread, keeping DSH-driven conversations out of the app's shared thread history. Any value other than exactly `false` resolves to true. |
| `environmentId` | `null` | Optional app-server environment selector, passed to `thread/start` only when it is a non-empty string. |
| `httpTransport` | `true` | When true, the private `CODEX_HOME`'s `config.toml` declares a provider with `supports_websockets = false`, so Codex goes straight to HTTPS and skips the 115-second WebSocket prewarm wait that used to precede the first turn of every session. When false the file is written empty, restoring upstream behaviour. Must be a boolean. |

### The system prompt

A request's system text is taken from `options.system` first, then from a leading `system` message. It becomes the Codex thread's `baseInstructions`, which **replaces Codex's own agent system prompt** for that thread. When the request carries no system text, `baseInstructions` from the config is used instead; when that is `null` or empty, nothing is sent and Codex applies its own prompt.

Because the system text is part of the thread's identity, changing the DSH system prompt invalidates the cached thread and forces a new one.

## Latency: why the first turn used to cost 115 seconds

Measured against `codex-cli 0.155.0-alpha.16.4` (same machine, same day):

| Phase | Before (WebSocket transport on) | After (`httpTransport: true`, the default) |
|---|---|---|
| Process start → first protocol frame | 342 ms | 309 ms |
| **First turn: `turn/start` → first token** | **115821 ms** | **8955 ms** |
| First turn to completion | 115989 ms | 9186 ms |
| Turns 2 / 3 on the same thread | 5240 / 3325 ms | 5334 / 3181 ms |
| **First turn of a second thread in the same process** | full cost, every new thread | **6943 ms** |

Over the whole plugin path (real login, real `codex.exe`) the first turn measured **4742 ms** and the second **4051 ms**.

### Root cause

Codex's ChatGPT subscription channel prefers a Responses-over-WebSocket transport. It performs a **prewarm** before the first turn of a session — a `generate=false` `response.create` — and **blocks until that prewarm completes** so the following request can reuse the connection. Upstream, in `core/src/client.rs`:

> WebSocket prewarm is a v2-only `response.create` with `generate=false`; it waits for completion so the next request can reuse the same connection and `previous_response_id`.

On this machine that handshake never completes, so Codex retries until the budget runs out (`websocket_connect_timeout_ms` defaults to 15000 ms, `request_max_retries` to 4, so five attempts — the `Reconnecting... 2/5` … `5/5` and request timeouts the desktop app shows), and only then falls back to HTTPS. **All 115 seconds sit between sending `turn/start` and receiving the first token**, and `codex.exe` writes nothing to stderr, which is why it looks exactly like a hang.

The fallback is **session-scoped**: once a turn activates HTTPS, every later turn in that process uses HTTPS, which is why turns 2 and 3 take about 3 seconds. The fallback itself is upstream's designed safety net, not error recovery.

### The fix

The plugin writes a `config.toml` into its private `CODEX_HOME` declaring a provider with **no WebSocket transport**, so Codex starts on HTTPS instead of burning 115 seconds first:

```toml
model_provider = "codex-http"

[model_providers.codex-http]
name = "OpenAI (HTTPS only)"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

Two implementation details that matter:

- **The key cannot be `openai`.** User-defined providers are merged into the built-in table with `entry(key).or_insert(provider)`, so a same-named entry **cannot override the built-in `openai`**; the entry needs its own key, selected by the top-level `model_provider`.
- `ModelProviderInfo` carries `#[schemars(deny_unknown_fields)]`, so a mistyped field fails the whole config parse, and `name` is required.

`httpTransport: false` restores upstream behaviour (an empty `config.toml`). That is only worth doing if the WebSocket handshake genuinely completes on your machine, in which case its incremental continuation can save tokens.

### Keeping threads warm still matters

The first turn is no longer expensive, but reuse is still right: it avoids replaying the whole conversation whenever a thread is rebuilt. The plugin therefore:

- keys one thread per DSH session (`session:<sessionId>`), and keys auxiliary one-shot calls without a session id by a digest of their own provider, model, purpose and transcript (`oneshot:<hash>`);
- reuses a thread only when the session matches, the app-server client instance is the same, the system text is byte-identical, the model is identical, and the rows the thread already received are a prefix of the current request's rows;
- only counts messages the thread actually consumed as input (`user` and `tool` rows). An assistant message is the model's own output and is never replayed to it as input, so it cannot stall the prefix comparison;
- sends a fresh thread the earlier conversation packed into one turn (`Conversation so far:` transcript plus the final user message);
- drops the thread whenever a turn fails or ends without a terminal status, so the next call rebuilds from the DSH transcript, which is always correct even when it is slower;
- evicts a cached thread after **30 minutes idle** and keeps at most **16 threads** per plugin instance (LRU eviction).

A turn that gets retried by the harness re-enters the app-server on a thread that may have been invalidated, so it rebuilds; this route deliberately adds no retry policy of its own (`providerRetryPolicy` returns `undefined`, meaning "use the harness defaults").

## Tools

Registered only when the `tools` service is present. All three are read-only, and all three accept object-rooted JSON Schemas because DSH forwards `parameters` to the provider verbatim.

| Tool | Purpose |
|---|---|
| `codex_threads_list` | List conversations stored by the local Codex app-server, for finding one to read. |
| `codex_thread_read` | Read one stored conversation by id, in order. Reasoning items are omitted. |
| `codex_desktop_sessions` | List the session index written by the Codex desktop app, newest first. |

### `codex_threads_list`

| Argument | Type | Default | Notes |
|---|---|---|---|
| `limit` | number | 20 | Capped at 200. |
| `query` | string | — | Case-insensitive substring filter on conversation names, forwarded to the app-server. |
| `archived` | boolean | — | When true, list archived conversations instead of active ones. |

Returns `{ count, threads }`; each row carries `id`, `name`, `updatedAt`, `cwd` and `ephemeral`. Rows without an id are dropped.

### `codex_thread_read`

| Argument | Type | Default | Notes |
|---|---|---|---|
| `threadId` | string | — | **Required.** Get it from `codex_threads_list` or `codex_desktop_sessions`. |
| `maxItems` | number | 80 | Capped at 200. The newest messages are kept. |

Returns `{ threadId, count, messages }`, where each message is `{ role, text }` with `role` being `user` or `assistant` (`phase` is added when the app-server reports one). Reasoning items, non-message items and empty messages are dropped. A missing `threadId` throws.

### `codex_desktop_sessions`

| Argument | Type | Default | Notes |
|---|---|---|---|
| `limit` | number | 30 | Capped at 2000. |

Reads `<authSource>\session_index.jsonl`, sorts by `updated_at` descending (string comparison), and returns `{ count, sessions }` with `{ id, name, updatedAt }` per row. A malformed line is skipped with a diagnostic instead of failing the call; a missing index file returns `{ count: 0, sessions: [], note: "no session index at <path>" }`.

## Security posture

- **No approval can be answered.** This is a headless provider: no UI exists to surface an approval prompt. `approvalPolicy` therefore defaults to `never` and `sandbox` to `read-only`, so the Codex agent is never granted file or command authority by default.
- **Every server-initiated request is refused conservatively.** If the app-server asks anyway (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`), the plugin answers `decline`, empty permissions, or empty answers — never "allow". Guessing "allow" would silently grant authority the user never gave.
- **The plugin never holds a token.** It copies the desktop app's credential file so the child process can use the existing sign-in; the credential is read to be copied, never parsed, logged, or returned.
- **Diagnostics do not identify the account.** Account facts are reported as `<type>/<planType>` only; the email is deliberately not logged.
- **`cordis.patch.yml` is safe to commit and share**: it contains only non-secret policy.

## Design boundaries

- **DSH tool schemas are not forwarded to Codex.** Codex runs its own agent loop with its own tool set inside the app-server; DSH's schemas would describe functions this transport never invokes. The adapter declares no tools and reports how many were withheld in diagnostics, so the limitation is visible instead of looking like a model that ignores tool calls.
- **Reasoning is not streamed.** Measurement across the seven models produced no `item/reasoning/*` notifications on the app-server protocol, so no `reasoning-delta` chunk is emitted. Emitting an empty reasoning block would fabricate content the provider never sent.
- **Block text is assembled locally.** The app-server streams deltas and a final item, but the harness contract requires every `block-start` to be closed by a `block-end` carrying the assembled block, so the text is accumulated as it is forwarded.

## Known limitations

1. **Text only.** Image attachments are not forwarded; an `image` block becomes the literal placeholder `[image omitted: this provider route does not forward attachments yet]`. File attachments are reduced to their name (`[file attached: <name>]`) — the content is not transmitted.
2. **Tool use is not driven by DSH.** DSH cannot call its own tools through this route, and Codex's tool activity is not surfaced to DSH.
3. **The first turn still costs ~5 s.** The WebSocket prewarm is gone (see Latency above), but the first turn still pays TLS, auth and the startup of Codex's own agent loop; later turns on that thread cost ~3 s. Long gaps or model/system-prompt changes push you back onto the first-turn path through idle eviction, the 16-thread ceiling, or invalidation.
4. **Reasoning is invisible.** No reasoning deltas are streamed; reasoning tokens are only reported in usage when the app-server includes them.
5. **Cold start is bounded by timeouts, not by progress.** `startupTimeoutMs` (default 120 s) also bounds the `turn/start` *request* itself, and `turnTimeoutMs` (default 900 s) bounds the whole turn. A turn that exceeds its ceiling fails and drops the thread.
6. **DSH conversations stay out of the app's history** while `ephemeralThreads` is true (the default) — that is the intent, but it also means DSH-driven conversations will not appear in `codex_threads_list`.
7. **Automatic discovery is Windows-specific**, and it picks by build directory name, not by verified version.
8. **Failure loses the thread.** Any failed, cancelled or unfinished turn drops the session's thread, so the next call rebuilds the thread and replays the transcript — one turn of cost, no longer 115 seconds.

## Diagnostics and troubleshooting

Diagnostics are emitted through the plugin logger with the prefix `dsh-codex-chatgpt:`; most are debug level, load failures are warnings.

Warnings raised at load, and what they mean:

| Message (abridged) | Meaning |
|---|---|
| `no Codex executable found. Install the Codex desktop app, or set codexExecutable to the codex.exe path, then reload this plugin.` | Discovery failed; **the provider route is not registered** and `apply` returns early. |
| `cannot prepare the private CODEX_HOME at <path>: <reason>` | The private home could not be created or seeded; **the provider route is not registered**. |
| `no ChatGPT credential found in <authSource>. Sign in with the Codex desktop app first, or point authSource at the directory holding auth.json.` | The home exists but has no credential; the route still registers and will fail on the first real call. |

Debug-level facts worth looking for: whether the harness `LlmAdapter` base class was resolvable (otherwise a structurally compatible adapter is registered), the `registered provider "..." via <exe> (home ..., sandbox ...)` line, `codex app-server started (account: <type>/<planType>)`, `created codex thread <id> for session <key>`, `reusing codex thread <id> for session <key> (+N messages)`, `model catalog refreshed: <ids>`, thread eviction lines, `withholding N DSH tool schema(s)`, `codex turn failed: <message>`, and child-process stderr/exit notices.

## Tests

From this directory:

```powershell
node --test --experimental-test-isolation=none tests/provider.test.js
```

`--experimental-test-isolation=none` is required in the sandboxed environment. Node's test runner otherwise runs each test file in a child process, which needs named pipes; the file sandbox denies them and the run fails with `EPERM`. Running without isolation keeps the suite in one process. The `test` script in `package.json` (`node --test tests/`) does not pass that flag.

The suite never starts a real app-server: every case injects a scripted fake through the adapter's `spawn` seam (`tests/fake-app-server.js`), so what is under test is the plugin's own logic — request planning, streaming order, thread reuse, usage mapping, failure and cancellation paths, model discovery, and the three tools.

## Repository layout

```
index.js              plugin entry: name, inject, Config validator, apply()
cordis.patch.yml      the bundle patch inserted into a profile's layer stack
src/config.js         config defaults/validation, executable discovery, private CODEX_HOME
src/plan.js           pure request planning: prefix check, reuse boundary, tool-schema withholding
src/threads.js        per-session thread registry, idle/LRU eviction, effort selection
src/client.js         app-server child lifecycle, thread creation, one turn, unattended answers
src/transport.js      line-delimited JSON transport over the child's stdio
src/adapter.js        the LLM adapter: provider info, model catalog, chunk streaming, usage mapping
src/tools.js          the three conversation-access tools
tests/                node:test suite plus the scripted fake app-server
```

## License and scope

This is a local integration for a personal ChatGPT login. It is not affiliated with OpenAI; it talks to the app-server shipped with the Codex desktop app on the same machine, and it depends on that app being installed, running, and signed in.
