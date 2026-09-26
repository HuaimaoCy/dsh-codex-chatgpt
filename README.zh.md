# dsh-codex-chatgpt

在 DeepSeek Harness 里使用**本机 Codex 桌面应用**的 ChatGPT 模型。

插件以 `codex app-server` 为后端，注册一条 DSH 一等 LLM provider 路由，复用桌面应用已有的 ChatGPT 登录态；同时附带三个只读工具，用于查看 Codex 会话。

| | |
|---|---|
| Provider 路由 id | `codex-chatgpt` |
| 显示名 | `ChatGPT (Codex)` |
| 插件版本 | 0.1.0 |
| 实测对象 | `codex-cli 0.155.0-alpha.16.4` |
| 形态 | 仅 Host 侧（没有浏览器侧，因此本插件没有 HMR 通路） |

## 它做什么

- **注册一条 provider 路由。** 本机 app-server 提供的 ChatGPT 模型可以作为 DSH 会话的模型被选中，也可以像其他 provider 一样按模型 id 派发给子代理。
- **复用桌面应用的 ChatGPT 登录态。** 插件自己从不持有 token：它把凭据文件 `auth.json` 从桌面应用目录复制进一个由插件自有的私有 `CODEX_HOME`（`src/config.js`）。
- **绝不碰 `~/.codex`。** 正在运行的桌面应用独占该目录的 sqlite state runtime，第二个指向它的 app-server 会以 `failed to initialize state runtime` 失败。插件因此自建私有 home。
- **绝不复制 `config.toml`。** 桌面应用的配置会启用 marketplace、插件与 MCP server，每一项都会给每次 DSH 模型调用带来启动开销和副作用。插件只继承凭据，并无条件写入一个空的 `config.toml`，以免上一次运行残留的配置继续左右这个私有 home。
- **按 DSH 会话复用一个 Codex 线程**，因为线程是否被复用直接决定这个 provider 可用还是不可用（见 [延迟](#延迟为什么必须复用线程)）。复用判定是保守的：错误地“重建”只损失延迟，错误地“复用”会污染对话，所以 `src/plan.js` 会先证明缓存线程仍是 DSH 会话记录的忠实前缀，才追加内容。
- **附带三个会话访问工具**，覆盖 app-server 存储的线程与桌面应用的会话索引。

## 运行要求

- **已安装并登录 Codex 桌面应用**，账号为 ChatGPT 计划。本机以 **ChatGPT Plus** 验证。
- **自动发现可执行文件需要 Windows。** 自动发现会查找 `%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe`，取构建目录名最大的那个。其他平台或非默认安装请显式设置 `codexExecutable`。
- **Node.js >= 22.5.0**（`package.json` 的 `engines`）。
- **一个会加载本插件的 DSH profile。** 本插件只 inject `llm`；当环境里没有 `tools` 服务时，provider 路由照常注册，三个工具则跳过。

## 可用模型

`listModels` 绝不阻塞等待 app-server —— 它是在模型选择器渲染时被调用的，而冷启动握手慢到不能拿来等。在实时的 `model/list` 回复到达之前，选择器显示的是下表这份内置清单（`src/adapter.js` 的 `FALLBACK_MODELS`）。一次成功的探测会替换它；结果最多每 10 分钟刷新一次，`hidden` 的模型会被过滤掉。

| 模型 id | 名称 | 说明 |
|---|---|---|
| `gpt-6-astra` | GPT-6-Astra | ChatGPT 计划下的 Codex 默认模型 |
| `gpt-6-sol` | GPT-6-Sol | Codex 代码推理模型 |
| `gpt-6-luna` | GPT-6-Luna | Codex 通用模型 |
| `gpt-5.6-sol` | GPT-5.6-Sol | 上一代 |
| `gpt-5.6-terra` | GPT-5.6-Terra | 上一代 |
| `gpt-5.6-luna` | GPT-5.6-Luna | 上一代 |
| `gpt-5.5` | GPT-5.5 | 上一代 |

这 7 个是本机 ChatGPT Plus 账号上实测到的模型。账号真实的清单来自 app-server 的 `model/list`；权限不同的账号完全可能给出不同的一组。

每个模型上报的元数据：

- **输入模态**：仅 `['text']`。
- **上下文窗口**：以 `model/list` 上报为准，否则假定为 `258400`（`DEFAULT_CONTEXT_WINDOW`）。
- **推理强度（reasoning effort）**：以模型自己上报为准，否则为 `low`、`medium`、`high`、`xhigh`、`ultra`、`max`。

## 安装

在提供 `dsh` CLI 的 checkout 下执行：

```powershell
# 1. 把插件加入 web profile（用本目录的绝对路径）。
pnpm dsh plugin --profile web add "C:\path\to\dsh-codex-chatgpt"

# 2. 验证 layer 已经进入合成后的配置。
pnpm dsh --profile web --dump-config
```

随后**重启 `dsh web` 进程** —— 即你平时启动 GUI 所用的同一条命令。

第 2 步是确认安装生效的廉价检查：合成配置里应出现一个被 insert 的 layer，其 `name` 为 `dsh-codex-chatgpt`，config 即 [`cordis.patch.yml`](./cordis.patch.yml) 的内容。

### 为什么必须重启

本插件属于 **Host 侧**。Host 插件代码在 `dsh web` 进程启动时加载，没有热更新通路，而本插件也没有浏览器侧可热重载。只有浏览器侧（client 插件）的改动才走 HMR。任何 Host 侧改动——包括对 `index.js` 和 `src/` 的修改——都需要完整重启 `dsh web`。

启动后，在 DSH 的模型选择器里选择该 provider（路由 `codex-chatgpt`，显示名 `ChatGPT (Codex)`）。

## 配置项

所有键都是可选的；下表的默认值既是 [`cordis.patch.yml`](./cordis.patch.yml) 随插件提供的值，也是 `src/config.js` 中 `CONFIG_DEFAULTS` 的取值。`approvalPolicy`、`sandbox`、`turnTimeoutMs`、`startupTimeoutMs` 会在加载时校验，非法值直接拒绝。

| 键 | 默认值 | 含义 |
|---|---|---|
| `provider` | `codex-chatgpt` | 注册到 `ctx.llm` 的 provider 路由键。非空字符串。 |
| `providerName` | `ChatGPT (Codex)` | 模型选择器中显示的名称。非空字符串。 |
| `codexExecutable` | `''`（自动发现） | Codex 可执行文件的绝对路径。解析顺序：配置值 → 环境变量 `DSH_CODEX_EXECUTABLE` → `%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe` 下构建目录名最大的那个。 |
| `codexHome` | `''` → `~/.dsh/codex-chatgpt` | 私有 `CODEX_HOME`。**绝不能**设为 `~/.codex`，桌面应用独占该目录的 sqlite state runtime。 |
| `authSource` | `''` → `~/.codex` | ChatGPT 凭据（`auth.json`）的复制来源目录。`codex_desktop_sessions` 也从这个目录读 `session_index.jsonl`。 |
| `cwd` | `''` → `process.cwd()` | 传给 `thread/start` 的工作区，同时也是子进程的工作目录。会解析为绝对路径。 |
| `approvalPolicy` | `never` | 取值为 `never`、`on-request`、`on-failure`、`untrusted` 之一。 |
| `sandbox` | `read-only` | 取值为 `read-only`、`workspace-write`、`danger-full-access` 之一。 |
| `reasoningEffort` | `''`（继承） | 当 DSH 请求没有指定推理强度时，本轮的默认强度。空表示“继承模型自身的默认值”。请求里带的强度始终优先。 |
| `baseInstructions` | `null` | 请求没带系统提示时，线程使用的兜底系统提示。`null` 表示让 Codex 使用它自己的 agent 系统提示。 |
| `turnTimeoutMs` | `900000`（15 分钟） | 单个 Codex 轮的硬上限。必须为正的有限数值。 |
| `startupTimeoutMs` | `120000`（2 分钟） | 握手、`thread/start`，以及每个单独协议请求（如 `turn/start`、`model/list`）的上限。必须为正的有限数值。 |
| `ephemeralThreads` | `true` | 为 true 时，`thread/start` 会要求创建 ephemeral 线程，使 DSH 驱动的对话不出现在应用的共享线程历史里。除恰好等于 `false` 外的任何取值都解析为 true。 |
| `environmentId` | `null` | 可选的 app-server environment 选择器，仅当它是非空字符串时才传给 `thread/start`。 |
| `httpTransport` | `true` | 为 true 时，私有 `CODEX_HOME` 的 `config.toml` 会声明一个 `supports_websockets = false` 的 provider，让 Codex 直接走 HTTPS，跳过每次会话首轮那 115 秒的 WebSocket prewarm 等待。为 false 时写一个空的 `config.toml`，回到上游默认行为。必须是布尔值。 |

### 系统提示

请求的系统文本先取 `options.system`，再取开头的 `system` 消息。它会成为 Codex 线程的 `baseInstructions`，从而**替换该线程上 Codex 自带的 agent 系统提示**。当请求没有携带系统文本时，改用配置里的 `baseInstructions`；当它也是 `null` 或空时，什么都不发，由 Codex 使用自己的提示。

由于系统文本属于线程身份的一部分，改动 DSH 的 system prompt 会使缓存线程失效并强制新建。

## 延迟：首轮为什么曾经是 115 秒

针对 `codex-cli 0.155.0-alpha.16.4` 的实测（同一台机器、同一天）：

| 阶段 | 修复前（WebSocket 传输开启） | 修复后（`httpTransport: true`，默认） |
|---|---|---|
| 进程启动 → 首个协议帧 | 342 ms | 309 ms |
| **首轮：`turn/start` → 第一个 token** | **115821 ms** | **8955 ms** |
| 首轮完成 | 115989 ms | 9186 ms |
| 同线程第 2 / 3 轮 | 5240 / 3325 ms | 5334 / 3181 ms |
| **同一进程内另一个新线程的首轮** | 每个新线程都付满额 | **6943 ms** |

真机走完整插件链路（真实登录态、真实 `codex.exe`）时，首轮 **4742 ms**、第二轮 **4051 ms**。

### 根因

Codex 的 ChatGPT 订阅通道优先使用 Responses-over-WebSocket。它在**每次会话的首轮之前做一次 prewarm**（一个 `generate=false` 的 `response.create`）并**阻塞等待它完成**，好让随后的正式请求复用同一条连接。见上游 `core/src/client.rs`：

> WebSocket prewarm is a v2-only `response.create` with `generate=false`; it waits for completion so the next request can reuse the same connection and `previous_response_id`.

本机上这个握手永远完不成，于是 Codex 一路重试到预算耗尽（`websocket_connect_timeout_ms` 默认 15000ms × `request_max_retries` 默认 4，共 5 次尝试 → 界面上就是 `Reconnecting... 2/5` … `5/5` 与 request timeout），才回退到 HTTPS。**115 秒全部发生在「已发出 turn/start」与「第一个 token」之间**，而 `codex.exe` 的 stderr 一句都不输出——所以它看起来完全像卡死。

这个回退是**会话级**的：一旦某一轮启用了 HTTPS，该进程之后的轮次都走 HTTPS，因此同一线程的第 2、3 轮只要约 3 秒。回退本身是上游设计好的兜底路径，不是故障恢复。

### 修复

插件往自己的私有 `CODEX_HOME` 写一份 `config.toml`，声明一个**不用 WebSocket** 的 provider，让 Codex 一开始就走 HTTPS，不必先烧掉 115 秒：

```toml
model_provider = "codex-http"

[model_providers.codex-http]
name = "OpenAI (HTTPS only)"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

两个必须注意的实现细节：

- **不能用 `openai` 这个 key。** 用户自定义 provider 与内置表的合并是 `entry(key).or_insert(provider)`，同名条目**无法覆盖内置的 `openai`**，所以必须另起一个 key，再用顶层 `model_provider` 指过去。
- `ModelProviderInfo` 带 `#[schemars(deny_unknown_fields)]`，写错字段名会让整个 config 解析失败；`name` 是必填项。

用 `httpTransport: false` 可以回到上游默认行为（写一个空的 `config.toml`）。只有在 WebSocket 握手在你这台机器上确实能完成时才值得这么做——那种情况下 WebSocket 的增量续传会更省 token。

### 保住线程仍然重要

首轮不再昂贵，但复用线程依然是正确的：它避免了每次重建线程都要重放整段对话，也避免了空转的 prewarm。插件据此：

- 按 DSH 会话为线程建键（`session:<sessionId>`）；没有 session id 的辅助一次性调用，按自身的 provider、model、purpose 与对话内容摘要建键（`oneshot:<hash>`）；
- 仅在会话相同、app-server 客户端实例相同、系统文本逐字节相同、模型相同，且线程已收到的行是当前请求行的前缀时，才复用线程；
- 只统计线程真正作为输入消费过的消息（`user` 与 `tool` 行）。assistant 消息是模型自己的输出，永远不会被当作输入回放，因此不会卡住前缀比较；
- 新建线程时把此前的对话压进一轮（`Conversation so far:` 转录 + 最后一条用户消息），而不是为每条消息各付一次冷启动；
- 一旦某轮失败或没有终态，就丢弃该线程，下次调用从 DSH 的会话记录重建——即使更慢，也总是正确的；
- 线程闲置 **30 分钟**后淘汰，单插件实例最多保留 **16 个**线程（LRU 淘汰）。

被 harness 重试的轮次会带到一个可能已失效的线程上，因此会再次付冷启动；本路由刻意不额外添加重试策略（`providerRetryPolicy` 返回 `undefined`，含义是“使用 harness 默认值”）。

## 工具

仅当 `tools` 服务存在时注册。三个工具都是只读的；三者都声明以 object 为根的 JSON Schema，因为 DSH 会把 `parameters` 原样转发给 provider。

| 工具 | 用途 |
|---|---|
| `codex_threads_list` | 列出本机 Codex app-server 存储的对话，用于挑一个来读。 |
| `codex_thread_read` | 按 id 顺序读取一个已存储的对话。推理项被略过。 |
| `codex_desktop_sessions` | 列出 Codex 桌面应用写入的会话索引，最新的在前。 |

### `codex_threads_list`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `limit` | number | 20 | 上限 200。 |
| `query` | string | — | 对对话名做大小写不敏感的子串过滤，转发给 app-server。 |
| `archived` | boolean | — | 为 true 时列出已归档对话而非活动对话。 |

返回 `{ count, threads }`；每行含 `id`、`name`、`updatedAt`、`cwd`、`ephemeral`。没有 id 的行会被丢弃。

### `codex_thread_read`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `threadId` | string | — | **必填。** 来自 `codex_threads_list` 或 `codex_desktop_sessions`。 |
| `maxItems` | number | 80 | 上限 200。保留最新的若干条消息。 |

返回 `{ threadId, count, messages }`，每条消息为 `{ role, text }`，`role` 为 `user` 或 `assistant`（app-server 上报 `phase` 时会附带该字段）。推理项、非消息项以及空消息都会被丢弃。缺少 `threadId` 会抛错。

### `codex_desktop_sessions`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `limit` | number | 30 | 上限 2000。 |

读取 `<authSource>\session_index.jsonl`，按 `updated_at` 字符串降序排序，返回 `{ count, sessions }`，每行含 `{ id, name, updatedAt }`。单行格式错误会被跳过并记一条诊断，而不会让整个调用失败；索引文件缺失时返回 `{ count: 0, sessions: [], note: "no session index at <path>" }`。

## 安全说明

- **没有审批能被应答。** 这是一个无头 provider：不存在可以弹出审批提示的 UI。因此 `approvalPolicy` 默认 `never`、`sandbox` 默认 `read-only`，默认情况下 Codex agent 拿不到文件或命令权限。
- **所有服务端发起的请求都被保守拒绝。** 如果 app-server 仍然发起请求（`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`），插件一律回答 `decline`、空权限或空答案——从不“允许”。猜一个“允许”等于悄悄授予用户从未给过的权限。
- **插件从不持有 token。** 它复制桌面应用的凭据文件，好让子进程复用已有登录态；凭据只被读取用于复制，从不被解析、打印或返回。
- **诊断不暴露账号身份。** 账号信息只以 `<type>/<planType>` 形式上报，邮箱被刻意排除在日志之外。
- **`cordis.patch.yml` 可以安全地提交与分享**：其中只有非机密的策略配置。

## 设计边界

- **不向 Codex 转发 DSH 的工具 schema。** Codex 在 app-server 内跑自己的 agent loop 与自己的工具集；DSH 的 schema 描述的是这条传输永远不会调用的函数。适配器不声明任何工具，并在诊断里报告被扣下了多少个，使这一限制可见，而不是表现为模型莫名忽略工具调用。
- **不流式输出 reasoning。** 对 7 个模型的实测中，app-server 协议上没有产生任何 `item/reasoning/*` 通知，因此不发出 `reasoning-delta` 分片。发一个空的 reasoning 块等于凭空编造 provider 从未发送的内容。
- **块文本在本地拼装。** app-server 会流式发送增量，并在最后给出完整 item；但 harness 契约要求每个 `block-start` 都由一个携带完整块的 `block-end` 收尾，所以文本在转发过程中被累积。

## 已知限制

1. **仅文本。** 图片附件不会被转发；`image` 块会变成字面占位符 `[image omitted: this provider route does not forward attachments yet]`。文件附件会退化为文件名（`[file attached: <name>]`）——内容不传输。
2. **工具调用不由 DSH 驱动。** DSH 无法通过这条路由调用自己的工具，Codex 的工具活动也不会呈现给 DSH。
3. **首轮仍有约 5 秒。** WebSocket prewarm 已经关掉（见上文「延迟」），但首轮仍要付 TLS/鉴权与 Codex 自身 agent 循环的启动开销；同线程后续轮次约 3 秒。长时间空闲、切换模型或改动系统提示，都会因闲置淘汰、16 线程上限或缓存失效而把你推回首轮路径。
4. **reasoning 不可见。** 不流式输出 reasoning 增量；只有当 app-server 的用量里带上时，推理 token 数才会被报告。
5. **冷启动由超时约束，而不是由进度约束。** `startupTimeoutMs`（默认 120 秒）也约束 `turn/start` **请求本身**，`turnTimeoutMs`（默认 900 秒）约束整轮。超出上限的轮次会失败并丢弃线程。
6. **DSH 对话不会出现在应用的线程历史里**（`ephemeralThreads` 默认为 true 时）——这是本意，但也意味着 DSH 驱动的对话不会在 `codex_threads_list` 中出现。
7. **自动发现仅限 Windows**，且按构建目录名而不是经过校验的版本号挑选。
8. **失败即丢线程。** 任何失败、被取消或未完成的轮次都会丢弃该会话的线程，下次调用需重建线程并重放对话——代价是一轮，不再是 115 秒。

## 诊断与排错

诊断通过插件 logger 输出，前缀为 `dsh-codex-chatgpt:`；大多数是 debug 级别，加载失败是 warning。

加载时可能出现的 warning 及其含义：

| 消息（节选） | 含义 |
|---|---|
| `no Codex executable found. Install the Codex desktop app, or set codexExecutable to the codex.exe path, then reload this plugin.` | 未发现可执行文件；**provider 路由不会被注册**，`apply` 提前返回。 |
| `cannot prepare the private CODEX_HOME at <path>: <reason>` | 私有 home 无法创建或写入；**provider 路由不会被注册**。 |
| `no ChatGPT credential found in <authSource>. Sign in with the Codex desktop app first, or point authSource at the directory holding auth.json.` | home 存在但没有凭据；路由仍会注册，首次真实调用会失败。 |

值得关注的 debug 事实：harness 的 `LlmAdapter` 基类是否解析成功（否则注册的是结构兼容的适配器）、`registered provider "..." via <exe> (home ..., sandbox ...)`、`codex app-server started (account: <type>/<planType>)`、`created codex thread <id> for session <key>`、`reusing codex thread <id> for session <key> (+N messages)`、`model catalog refreshed: <ids>`、线程淘汰日志、`withholding N DSH tool schema(s)`、`codex turn failed: <message>`，以及子进程的 stderr 与退出通知。

## 测试

在本目录下执行：

```powershell
node --test --experimental-test-isolation=none tests/provider.test.js
```

在沙箱环境中 `--experimental-test-isolation=none` 是必需的。Node 的测试运行器默认会为每个测试文件派生子进程，而这需要命名管道；文件沙箱禁止命名管道，运行会以 `EPERM` 失败。关闭隔离后整个测试套件在同一个进程里运行。`package.json` 中的 `test` 脚本（`node --test tests/`）没有带这个参数。

测试套件从不启动真实的 app-server：每个用例都通过适配器的 `spawn` 接缝注入一个脚本化的假实现（`tests/fake-app-server.js`），因此被测的是插件自身的逻辑——请求规划、流式顺序、线程复用、用量映射、失败与取消路径、模型发现，以及三个工具。

## 仓库结构

```
index.js              plugin 入口：name、inject、Config 校验器、apply()
cordis.patch.yml      插入 profile 层栈的 bundle patch
src/config.js         配置默认值与校验、可执行文件发现、私有 CODEX_HOME
src/plan.js           纯函数请求规划：前缀判定、复用边界、工具 schema 处理
src/threads.js        按会话的线程注册表、闲置/LRU 淘汰、强度选择
src/client.js         app-server 子进程生命周期、线程创建、单轮执行、无 UI 应答
src/transport.js      基于子进程 stdio 的行分隔 JSON 传输
src/adapter.js        LLM 适配器：provider 信息、模型目录、分片流式输出、用量映射
src/tools.js          三个会话访问工具
tests/                node:test 测试套件与脚本化假 app-server
```

## 许可与范围

这是一个面向个人 ChatGPT 登录态的本机集成，与 OpenAI 无关；它只与本机 Codex 桌面应用自带的 app-server 通信，并依赖该应用已安装、在运行且已登录。
