# dsh-codex-chatgpt 优化方案与整体评估

> 范围：`index.js` + `src/{config,transport,client,threads,plan,tools,adapter}.js`（约 2400 行）。
> 结论先行：**架构健康，无需重写**。分层清晰（transport→client→threads→plan→adapter），注释把协议事实（~115s 冷启动、turn/started 竞态、usage 去重计费）编码进了代码。下面的问题按优先级排列，P0 是正确性，P1 是性能/健壮性，P2 是结构与功能完善。

## 整体评估

- **正确性设计良好**：线程复用有前缀校验（plan.js）、失败即弃线程（threads.js）、注册永不早退（index.js）、usage 去除 cache 双计费（adapter.js）。这些都是实测驱动的，不要动。
- **主要短板**：① 首轮 ~115s 冷启动没有被任何机制缓解或对用户可见；② 工具不转发导致该路由模型"没有工具"——这是功能完善的最大空间；③ 单 app-server 子进程是全局单例，一条慢通道串行所有会话；④ 部分防御代码有边界 bug（见 P0）。

## P0 — 正确性修复（小改动）

1. **`runTurn` 的 `started` 标志从未被读取**（client.js:545 赋值，finally 分支用 `started && !settled` —— 实际有用，但 `turnId` 在 `started=true` 之前已提交：若 `turn/start` 响应带 turn 而 `turn/started` 通知先到，abort 分支（client.js:511-519）在 `turnId===undefined` 时只置 failure 不发 interrupt，随后 finally 里 `turn/interrupt` 用 `{threadId, turnId: undefined}` 发出**非法请求**。修复：finally 中对 `turnId === undefined` 短路。
2. **`planTurn` 复用时 pending 行不含 assistant 回复**：`deliveredRows` 过滤 assistant，`pending = delivered.slice(held.length)` —— 若 DSH transcript 在 user/assistant 之间插入了非 user/tool 行以外的内容（如 assistant 被编辑），前缀匹配失败会退回重建，正确；但**纯 tool 行连发**（user→tool→tool）时 `input` 把多条 tool 结果合并为一个 user turn，模型侧丢失边界。建议在合并处用 `roleLabel` 前缀标注每段（复用 `freshThreadInput` 的做法）。
3. **`freshThreadInput` 空 transcript 返回 `''`**：threads.js:201 会把空文本作为 turn input 发出，app-server 可能报错。应在 `plan.input.length === 0` 时直接抛出可诊断错误（"request carried no deliverable content"）。
4. **`codex_desktop_sessions` 全量读文件**（tools.js:151）：`session_index.jsonl` 可能很大；`readFileSync` 后再排序整个数组。改为流式/逆序读，或至少在超限时截断提示。（同时它是同步 IO，阻塞事件循环。）
5. **`tools.js` 三处 `render` 假设字段存在**（`thread.name.length`）——execute 返回保证字段，但 note 分支的 `value.note` 路径 ok；真正风险是 `renderThreadRead` 里 `value.threadId` 直取。低风险，加 `?.` 即可。

## P1 — 性能与健壮性

6. **冷启动 ~115s 是最大体验问题**。方案（按成本递增）：
   - a. **预热**：`apply()` 里注册后即触发 `refreshCatalogInBackground()`（它已经会拉起 app-server + `model/list`）——现在只有首次 `listModels` 才触发，而插件装载时用户往往还没打开 picker。一行改动，把 115s 摊到装载期。（注意与 DSH 服务组装的竞态：已知结论"装载期预热会与服务组装竞态：缓存要从需要它的那条路径自愈"，因此预热失败必须静默、可重试，现有 `refreshing=null` 逻辑已满足。）
   - b. **keepalive 心跳**：空闲 >idleTimeoutMs 驱逐线程反而让下一次会话再付 115s。可对"最近 N 分钟内活跃过"的线程发一个廉价 `thread/read` 保活，或把 `DEFAULT_IDLE_TIMEOUT_MS` 提到与 DSH 会话寿命匹配（如 2h）并做成配置项。
   - c. **启动期给用户可见性**：首轮 turn 期间 `stream()` 在 `block-start` 前长时间无输出，harness 侧可能显示挂起。可在等待 `started` 事件时先 `yield` 一个空 text block？不可（会伪造内容）——替代：在 onStart 之前通过 diagnostic 通道报告"negotiating transport (~115s on first turn)"，并把该事实写进 README 的 Known Issues。
7. **串行化瓶颈**：`ThreadRegistry` 只有一个 `CodexClient`；多会话并发 turn 全走同一 stdio 通道（transport 本身支持并发 request，尚可），但一个会话的重试/重建 `invalidateClient` 会清掉**所有**会话的线程缓存（threads.js:127-134）。改进：按 client 记录线程归属，失效时只清属于该 client 的 thread（`record.client === client` 过滤），其他 client 不存在时可整体清。
8. **`evictIdle` 只在 `run()` 入口触发**：空闲会话永不触发。挂一个 `setInterval().unref()` 定时器（dispose 时清理）。
9. **`config.toml` 被无条件写空**（config.js:226）：若用户显式想继承部分桌面配置（如代理、`network_access`）没有出路。建议支持 `inheritConfigKeys: string[]`，从源 config.toml 中白名单复制键值，而不是整体禁止。
10. **凭据时效**：`prepareHome` 每次冷启动重拷 `auth.json`，但 `prepared` 标志一旦为 true 不再刷新——桌面端 refresh token 轮换后，长时间存活的私有 home 里凭据可能过期。建议在 `ensureClient` 冷启动路径上总是重拷（onPrepare 已经 re-verify，但 `prepared===true` 时 `prepare()` 直接 return，index.js:207-211）。改为记录 `preparedAt`，超过如 30min 重拷。

## P2 — 代码结构完善

11. **adapter.js 的 mixin 手法可以简化**：`CodexChatGptAdapterMethods` + `withBase` + 手工 `defineProperty` 循环（~80 行）只为解决"可能没有可 extends 的基类"。可以收敛为：`class CodexChatGptAdapter extends (Base ?? Object)` 直接写方法体，省掉整个 prototype 拷贝循环；`init` 改为构造体内联。行为不变，删 60 行。
12. **client.js `runTurn` 过长（~190 行）**：拆出 `TurnRunner`（事件队列 + abort + timeout 已具备雏形）与 notification 处理器映射表（`{ 'item/agentMessage/delta': fn, ... }`），便于新增 item 类型（见 P3）。
13. **重复的 wake/queue 模式出现两次**（client.js runTurn 与 adapter.js ChunkChannel）：ChunkChannel 可下沉为共享 util 并在 runTurn 内复用。
14. **`classifyTurnFailure` 与 `describeNotice` 重复解析 `codexErrorInfo`**：抽 `errorInfoKey(error)` 工具函数。
15. **测试只覆盖 happy path 为主**：补 (a) transport 半行分帧 + 非法 JSON；(b) turn/start 响应与 turn/started 竞态回放顺序；(c) 前缀失配触发重建；(d) usage cache 双计费回归；(e) abort 在 turnId 提交前/后两条路径。

## P3 — 功能完善方向（按价值排序）

16. **暴露 Codex 的 agentic 能力而不是隐藏**：当前 `unattendedResponse` 一律拒绝审批 + 默认 `sandbox: read-only`，等于把 ChatGPT 模型当纯文本模型用（这与其定位一致，安全默认正确）。完善方向：新增配置 `allowSandbox: 'read-only'|'workspace-write'`，当为 workspace-write 时 `item/fileChange/requestApproval` 自动放行**并在 DSH 侧回放为 tool-call 块**（`item/commandExecution/*` 映射为 DSH 工具调用展示）。这是把"代理执行"变为一等功能的路径，但工作量大、需先实测 item 事件形状。
17. **转发附件**：`plan.js` 对 image/file 只插占位符。app-server `UserInput` 支持 text elements；若支持 image element，可把 DSH image 块映射过去。需探测协议。
18. **新工具**：`codex_thread_search`（跨会话全文检索，用 thread/list + read 缓存）、`codex_account_info`（账号/配额，accountFacts 已有数据）、`codex_thread_archive`。均为 tools.js 内 ~30 行/个。
19. **结构化输出/温度**：`stream()` 忽略 `options` 中的 responseFormat / temperature —— app-server 或不支持；至少在 resolveModel 元数据里声明不支持，避免上层空转。
20. **README 补 Known Issues 表**：冷启动 115s、工具不转发、附件不转发、无 reasoning 流——代码注释里有，文档里没有（README 未见此表，若已有则忽略）。

## 实施顺序建议

1. P0.1/P0.3（各 <10 行，正确性）
2. P1.6a 预热 + P1.10 凭据重拷（体验收益最大）
3. P2.11 mixin 简化 + P2.15 测试补齐（为 P3 铺路）
4. P3.18 小工具（低风险增量）
5. P3.16 sandbox 透传（大特性，需单独设计与实测）

## 风险提示

- 所有改动须保持"注册永不早退"与"失败即弃线程"两条不变式。
- 协议事实（115s、竞态、usage 口径）源自 codex-cli 0.155.0-alpha.16.4 实测；升级 Codex 后应重验。
- 凭据文件只拷贝不解析/不打日志，保持现状。
