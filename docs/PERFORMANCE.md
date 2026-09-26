# 延迟分析：那个 116 秒的首轮卡顿

本文记录一次实测到的严重首轮延迟：成因测量、当时给出的解释、以及**该解释后来被证伪的过程**。

> ⚠️ 阅读顺序很重要。§1–3 是仍然成立的事实。**§4 是我的错误结论**，§5 是修正后的判断。如果只看一个章节，看 §5。

## 1. 症状

在本机（Windows，Codex 桌面应用已登录 ChatGPT Plus）通过 `codex-app-server` 调用模型时：

- **首轮**在「已发出 `turn/start`」与「第一个 token」之间静默阻塞约 **116 秒**，`codex.exe` 的 stderr **完全为空**。
- 同一线程的**后续轮次**只要 3–5 秒。
- 桌面应用界面上表现为 `Reconnecting... 2/5` … `5/5` 与 request timeout，然后才回复。

因为没有任何输出，它看起来像死机，而不是慢。

## 2. 测量

同机同日，冷启动逐帧打点（`tools/probe-timing.mjs`）：

| 阶段 | 耗时 |
|---|---|
| 进程启动 → 首个协议帧 | 342 ms |
| `thread/start` | < 100 ms |
| **第 1 轮：`turn/start` → 首个 token** | **115821 ms** |
| 第 1 轮：到完成 | 115989 ms |
| 同线程第 2 / 3 轮 | 5240 / 3325 ms |
| `codex.exe` stderr | 空 |

**全部 115.8 秒都落在 `turn/start` 与第一个 token 之间**，启动与建线程都不慢。这是本节唯一真正被证实的定位。

## 3. 仍然成立的两个代码事实

来源：上游 `codex-rs`。

**① 存在一个会阻塞的 WebSocket prewarm**（`core/src/client.rs`）：

> WebSocket prewarm is a v2-only `response.create` with `generate=false`; **it waits for completion** so the next request can reuse the same connection and `previous_response_id`.

**② 回退是会话级的**（`ModelClient::force_http_fallback`）：

```rust
let activated = websocket_enabled && !self.state.disable_websockets.swap(true, Ordering::Relaxed);
```

`disable_websockets` 一旦置位，**该进程后续所有轮次都不再尝试 WebSocket**。这正是「首轮慢、之后快」那个形状的来源——与成因无关。

另有超时与重试默认值（`core/src/model_provider_info.rs`）：`DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000`、`request_max_retries` 默认 4（即 5 次尝试）。

⚠️ 注意：15 s × 5 = 75 s **不等于**实测的 115.8 s。我没有测到重试阶梯本身，所以「超时 × 次数」只是量级解释，不是被验证的算式（见 §7）。

## 4. 当时给出的解释 —— 这是错的

当时我判断：WebSocket 握手在本机永远完不成，于是 Codex 等满重试预算（约 115 秒）才回退 HTTPS。据此在私有 `CODEX_HOME` 的 `config.toml` 里声明了一个 `supports_websockets = false` 的 provider，让 Codex 直接走 HTTPS。

**这个因果链是错的**，证据见下节。

## 5. 修正：那是网络路径的一次瞬时故障，不是必然行为

同样「空 config、WebSocket 允许」的条件下，重新测量：

| 测量时刻 | home | 传输 | 首 token |
|---|---|---|---|
| 21:37 | 原 home | WebSocket 允许 | **115821 ms** |
| 21:54 | 同一个 home | HTTP-only | 7920 ms |
| **22:29** | **同一个 home** | **WebSocket 允许** | **6616 ms** |
| 22:30 | 全新 home | WebSocket 允许 | 6864 ms |

三个关键事实：

1. **同一个 home、同一个空 config，现在只要 6.6 秒**——原测量**无法复现**。
2. 同一天、同一台机器，两个仅差「home 新旧」的环境给出 116 s 与 9 s，说明慢的那次不是由 home 内容决定的。
3. 因此，「WebSocket 握手必然阻塞 115 秒」**不成立**。那 115 秒是一次**网络路径故障**落在了 WebSocket 握手上；故障消失后，同一条路径恢复为几秒。

**我无法确定那次故障的具体内容**，也没有当时的网络层证据（stderr 为空、无抓包）。可排除的是「插件或 Codex 的固有行为」这一解释。

## 6. 那么 `supports_websockets = false` 还有用吗

**有用，但价值要重新描述。**

它**不是**根因修复——它不会让一个连不通的网络变通。它的真实作用是：**当 WebSocket 路径不通时，跳过那条重试阶梯**，不必先烧掉「超时 × 次数」。

证据的诚实版本：

- 在 21:37 那次故障窗口里，它把 115.8 s 降到 7.9 s；
- 之后网络正常，两种配置都是约 7 秒；
- **我没有在故障可复现时做受控 A/B**，因为我没能再次制造出那个故障窗口。

所以这是「在坏窗口里实测有效、在好窗口里无差异」的取舍。保留它，因为代价为零而收益在最坏情况下很大。设 `httpTransport: false` 可以回到上游默认。

## 7. 我未能回答的部分

1. **那次故障的性质**：是 DNS、TLS 握手、代理、还是服务端线路问题——无证据，不猜。
2. **115.8 s 与 75 s 的差额**：40 秒差的来源未测。重试阶梯本身我一次都没抓到（探针在窗口内的 stderr 始终为空）。
3. **它会不会再来**：网络路径故障可能复发。复发时的分诊信号是「首个 token 延迟 ≥ 15 s，且这一阶段 stderr 为空」。

## 8. 复现方法

```powershell
# WebSocket 允许的空 config：测 prewarm 那一跳的真实耗时
node tools/probe-ws-retries.mjs 90 "$env:USERPROFILE\.dsh\codex-bench\stab-ws-a"

# 逐帧时间戳（含 stderr）
node tools/probe-timing.mjs 200
```

`tools/probe-ws-retries.mjs` 会打印 `turn/start` 之后的**每一帧及其间隔**，并给出「最长静默间隔」。它的判读方式写在输出里：多个量级相当的静默间隔 = 重试阶梯；一个间隔吃掉全部等待 = 单次阻塞。

## 9. 结论

- ✅ **已证实**：首轮慢时，时间全部花在 `turn/start` 与首个 token 之间；回退是会话级的，所以后续轮次快。
- ✅ **已证实**：该延迟**不是**每次必然发生，而是随网络状况出现与消失——这推翻了先前的根因判断。
- ⚠️ **未证实**：那次故障的具体成因，以及 `supports_websockets = false` 在故障窗口内的因果贡献（只有时序上的相关性）。
