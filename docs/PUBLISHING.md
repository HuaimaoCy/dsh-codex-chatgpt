# dsh-codex-chatgpt 上架与发布手册

面向本机操作者（Windows / PowerShell）。目标：把本插件发布到 GitHub，并具备登上 DSH 插件市场（`dshmarket`）的条件。

**本文件只描述操作，不修改任何代码。** 文中给出的 `package.json` 建议一律是"建议"，需要你自己决定后再改。

## 0. 依据与标记约定

核对时间：本机当前状态。每条结论后面都指向具体文件、行号或本机命令输出。

- ✅ 已实测：本次在本机跑过命令，附输出要点。
- ⚠️ 未验证：无法在本机验证（需要网络写权限、需要改 profile、或属于上游 CI 行为）——已明确标出，不要当成事实。

权威来源（都读过）：

| 来源 | 作用 |
| --- | --- |
| `~/.dsh/profiles/web/node_modules/dshmarket/README.md` | 市场本身的行为与"投稿到哪里" |
| `~/.dsh/profiles/web/node_modules/dshmarket/lib/discovery-compatibility.js`、`sources.js`、`check.js` | 市场怎么判定兼容、怎么选安装目标（源码，最可信） |
| `<dsh-checkout>/docs/user/develop/basic/publish.md` | 官方 bundle/安装规范 |
| `<dsh-checkout>/packages/boot/plugin-manager/README.md` | 安装准入、version-exemptions |
| `<dsh-checkout>/packages/boot/app-boot/src/plugin-compatibility.ts` | **DSH 真正的 peerDependencies 准入实现** |
| [awesome-dsh-plugin/contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) | 收录的硬性条件与 CI 检查项（唯一权威） |

## 1. 本仓库现状快照

| 项 | 现状 | 依据 |
| --- | --- | --- |
| 包名/版本 | `dsh-codex-chatgpt@0.1.0` | `package.json:2-3` |
| `dsh.bundle.patch` | 已声明，指向 `./cordis.patch.yml` | `package.json:19-23` |
| 根目录 `cordis.patch.yml` | 存在，35 行，`insert` 一行 `id: codex-chatgpt` / `name: 'dsh-codex-chatgpt'` | `cordis.patch.yml:6-8` |
| `files` 白名单 | `index.js`, `src`, `cordis.patch.yml`, `README.md`, `README.zh.md` | `package.json:12-18` |
| 是否有构建步骤 | 无。`scripts` 里只有 `test`，无 `dependencies`、无 `prepare` | `package.json:24-29` |
| `peerDependencies` | 字段不存在（空） | `package.json` 全文 |
| `engines` | `node >=22.5.0`（无 `dsh`） | `package.json:27-29` |
| `repository` / `license` | 都没有 | `package.json` 全文 |
| `private` | `true` | `package.json:4` |
| 是否 git 仓库 | **不是**：本目录和父目录都没有 `.git` | ✅ `Test-Path .git` → `False` |
| 本机 gh | `gh` 已登录的账号名（`gh auth status` 可查） | ✅ |
| git 全局身份 | **空**（`git config --global --get user.name` 无输出，退出码 1）→ 每个仓库要单独设置 | ✅ |
| 本机 DSH 运行时版本 | `0.1.7-rc.2` | `<dsh-checkout>/packages/boot/app-boot/package.json` 的 `version` |
| README | `README.md` / `README.zh.md` 已存在，且都在 `files` 里；`npm pack` 实测两者都进包 | ✅ 见 §4 |
| 本机安装状态 | **已落地**：profile 的 `package.json` 有 `"dsh-codex-chatgpt": "link:C://…/dsh-codex-chatgpt"`，`dsh.profile.bundles` 末项为 `dsh-codex-chatgpt`；profile 的 `node_modules/dsh-codex-chatgpt` 是 **Junction** | ✅ 实读 profile `package.json` 与 `Get-Item -Force` 的 `LinkType` |
| 插件自身 `node_modules` | 只有 `@deepseek-ai/`，其中 `dsh-llm` 是指向 checkout `packages\llm\llm` 的 **Junction**；`npm pack` 实测仍只有 12 个条目，**不含** `node_modules` | ✅ `Get-Item -Force`；`npm.cmd pack --dry-run` |

> 注意：`package.json` 由其他协作者在本次文档写作期间更新过（`files` 加了 `README.zh.md`，`scripts.test` 加上了 `--experimental-test-isolation=none --test-timeout=30000`）。上表的行号已按当前版本重新核对；若之后再改，行号需要重新对。

## 2. 上架市场的真实门槛（逐条核对）

市场 `dshmarket` **本身不收投稿**——它实时读取精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（`dshmarket/README.md:89`、`:99`）。**上架 = 往那个仓库提一个文件**：`data/plugins/<owner>__<repo>.yml`。

### 2.1 硬性门槛（CI 会查）

上游 `contributing.md` 的 "What CI checks" 一节列出的检查项就是全部：**条目数、`dsh.bundle`、仓库年龄、awesome-lint 与站点构建**。

| # | 门槛 | 本仓库现状 | 未满足时的命令 |
| --- | --- | --- | --- |
| 1 | 仓库根 `package.json` 声明 `dsh.bundle`（只声明 `dsh.client` 会被拒——上游原话："最常见的被拒原因"） | ✅ 已满足（`package.json:19-23`） | — |
| 2 | 仓库根有 `cordis.patch.yml` | ✅ 已满足（`cordis.patch.yml`） | — |
| 3 | 仓库**创建满 1 天**（CI 自动检查，"过滤 PR 前几分钟才建好的仓库"） | ❌ 仓库还不存在 | 先建仓；**隔天再发 PR**（见 §5，注意这一条只影响 PR，不影响发 Release） |
| 4 | 仓库有 `dsh-plugin` topic | ❌ 仓库还不存在 | `gh repo edit <owner>/<repo> --add-topic dsh-plugin`（`gh repo create` 没有 topic 参数，已核对 `gh repo create --help`，⚠️ 该命令需要提权） |
| 5 | 仓库有真实可用代码（非占位/纯 README） | ✅ `src/` 7 个模块 + `tests/` | — |
| 6 | 项目处于活跃维护 | ✅（发布后自行保持） | — |
| 7 | 一个 PR 最多 3 条 | ✅ 本插件提 1 条 | — |
| 8 | 不是纯聚合包（只有依赖清单的 bundle 不收录） | ✅ 自带完整实现 | — |
| 9 | 描述必须属实（评审逐条对着代码核数字与 API 名） | 提交时自行保证 | — |
| 10 | 分类取 23 个取值之一 | 建议 `model`（Models & Providers） | — |

`category` 合法取值（`contributing.md`）：`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`。

### 2.2 可选但强烈建议

| 项 | 说明 | 依据 |
| --- | --- | --- |
| Release tarball | 不发 npm 就靠它。**不是**硬门槛，但上游把"仓库无法从源码安装"列为必须 | `contributing.md` "Recommended for a better install experience" |
| 发 npm | 可选，不影响收录；只有发了 npm，市场才会展示下载量 | 同上 |
| `screenshots.json` | 仓库根放 1–8 张相对路径图片；不声明则市场自动从 README 抽图 | 同上 |

### 2.3 这不是门槛，但会影响安装体验

- **`peerDependencies` 不是上架硬门槛**。上游 CI 不检查它，只在"推荐"一节要求官方 `@deepseek-ai/*` 用 `peerDependencies` 而非 `dependencies`。本插件根本没有 `@deepseek-ai/*` 依赖（`package.json` 里没有 `dependencies`），所以现在**不需要**为了上架加它。要不要加，见 §3。
- **`dsh.bundle` 缺失时的行为**：`publish.md:64` 说明"没有 `dsh.bundle` 声明的包仍能安装，但只作为普通依赖，`dsh plugin` 会警告且不激活任何 layer"——所以 CI 那条检查是实打实的。

## 3. 版本与依赖策略

### 3.1 DSH 装得上吗？——空 `peerDependencies` 没有影响（✅ 实测）

DSH 的准入检查实现是 `packages/boot/app-boot/src/plugin-compatibility.ts`：

- `:68` — **没有 `peerDependencies` 字段 → 直接返回"没有冲突"**。
- `:75` — 只检查名字等于 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 peer；`@deepseek-ai/cordis` 之类**不参与**。
- `:77` — 判定用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。
- 全文**不读 `engines`**。`engines.dsh` 不是准入条件（`grep engines packages/boot/**/*.ts` → 0 命中，本机 checkout 0.1.7-rc.2）。

用编译产物（`packages/boot/app-boot/lib/types/plugin-compatibility.js`）在本机实测：

| 插件 manifest | 判定 |
| --- | --- |
| 完全没有 `peerDependencies` | ✅ compatible |
| `peerDependencies: { "@deepseek-ai/cordis": "*" }` | ✅ compatible（名字不在检查范围） |
| `engines: { dsh: "999.0.0" }`（无 peer） | ✅ compatible —— **`engines.dsh` 被忽略** |
| `peerDependencies: { "@deepseek-ai/dsh": "" }` | ❌ 拒绝（空字符串是坑，别写） |
| `peerDependencies: { "@deepseek-ai/dsh": "999.0.0" }` | ❌ 拒绝 |

**结论：`peerDependencies: {}` / 缺字段 = 不检查 = 装得上。** 当前的 `engines.node >=22.5.0` 也不参与任何 DSH 准入路径，保留它只是给人看的元数据（它只在别人 `npm install` 时产生 `EBADENGINE` 警告，⚠️ 未在本机验证 pnpm 侧的具体告警文本）。

### 3.2 市场侧怎么读你的依赖声明

`dshmarket/lib/discovery-compatibility.js`：

- `:56` — 读 **`engines.dsh`**，其次 `dsh.engines.dsh`（顶层优先）。
- `:109-117` — 把 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peer 也当成 host 需求；名字必须命中 `/^@deepseek-ai\/dsh(?:-|$)/` 且在本地 host 包清单里。
- `:119-121` — **两者都没声明 → `status: unknown`，`basis: undeclared`**。这不是"不兼容"：按 `dshmarket/README.md:35`，未声明的条目照常可见，只是不显示兼容标签。

所以：**不写 peer 也不会让市场隐藏你**，只是卡片上少一个 host 兼容标注。

### 3.3 预发布版本：两套语义不一样（这是最容易踩的一条）

上游 `contributing.md` 明确要求：**peer 范围必须带显式 `||` 预发布分支**，否则"看起来宽"的范围会静默排除所有预发布构建，用户会遇到 `ERESOLVE`。

原因与本地实测：

1. **DSH 准入 / 市场发现**走 `includePrerelease: true`（`plugin-compatibility.ts:77`；`discovery-compatibility.js:74`）→ 宽范围也能放行预发布。
2. **市场 profile 诊断**走 npm 默认语义（`dshmarket/lib/check.js:1020` 调 `satisfiesRange()` 不带 options；规则写在 `check.js:362-376`：预发布版本只有当范围里*某个*比较符与它的 `major.minor.patch` 元组相同且自带预发布标签时才放行）。

本机实测（host = `0.1.7-rc.2`，用 `semver@7.8.5` 与 `dshmarket/lib/check.js` 各跑一遍）：

| 范围 | npm 默认语义 | `includePrerelease` |
| --- | --- | --- |
| `*` | ❌ false | ✅ true |
| `>=0.0.1-rc.1 <0.2.0` | ❌ false（元组 `0.0.1` 对不上 `0.1.7`） | ✅ true |
| `^0.1.0-rc.1` | ❌ false（同理） | ✅ true |
| `>=0.1.7-rc.1 <0.2.0` | ✅ true | ✅ true |
| `>=0.1.0-rc.1 <0.2.0 \|\| >=0.1.7-rc.1 <0.2.0` | ✅ true | ✅ true |

**建议写法**（两套语义同时通过，且拒绝 0.2.0 线）：

```jsonc
// package.json —— 建议，不要照抄进代码前先想清楚上界
"peerDependencies": {
  "@deepseek-ai/dsh": ">=0.1.0-rc.1 <0.2.0 || >=0.1.7-rc.1 <0.2.0"
}
```

实测矩阵（左侧为 host 版本）：

| host | npm 默认语义 | DSH 准入 |
| --- | --- | --- |
| `0.1.0-rc.5` | ✅ | ✅ |
| `0.1.7-rc.2`（本机当前） | ✅ | ✅ |
| `0.1.7` | ✅ | ✅ |
| `0.2.0-rc.1` | ❌ | ✅ |
| `0.2.0` | ❌ | ❌ |

注意最后两行：**预发布元组推进时要补 `||` 分支**（例如 host 变成 `0.1.8-rc.1` 时，npm 默认语义下会被判为不满足，市场 profile 诊断会显示一条信息性的 peer 不匹配——但准入与发现路径仍然放行，所以不会阻断安装）。上界 `<0.2.0` 一定要留着，否则等于声称兼容未来所有版本。

### 3.4 万一被准入拦下：version-exemptions

`plugin-manager/README.md:65-69`：精确 `package-name@version` → 精确 DSH 运行时版本的豁免，写在 profile 目录的 `compatibility.json`。

```powershell
pnpm dsh plugin --profile web version-exemptions
pnpm dsh plugin --profile web allow-version dsh-codex-chatgpt@0.1.0 --dsh-version 0.1.7-rc.2 --accept-risk
pnpm dsh plugin --profile web revoke-version dsh-codex-chatgpt@0.1.0 --dsh-version 0.1.7-rc.2
```

这是应急手段，不解决 peer 写错的问题。

## 4. 打包（三个已实测的坑）

### 4.1 坑一：`npm pack` 默认缓存会 EPERM（✅ 实测）

```text
npm error code EPERM
npm error path C:\Users\<user>\AppData\Local\npm-cache\_cacache\tmp\39159315
```

**解法：把缓存重定向到你确定可写的目录。** 本次实测 `%TEMP%` 下可写，工作区目录内也可写：

```powershell
# 推荐：缓存放系统临时目录，仓库里不留任何东西
$cache = Join-Path $env:TEMP "npm-cache-dsh-codex-chatgpt"
npm.cmd pack --cache $cache --offline --no-audit --no-fund

# 备选：缓存放仓库内（记得 .gitignore 并事后删掉）
npm.cmd pack --cache .\.npm-cache --offline --no-audit --no-fund
```

### 4.2 坑二：PowerShell 里必须写 `npm.cmd`（✅ 实测）

```text
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is disabled on this system.
```

裸 `npm` 命中的是 `npm.ps1`，被执行策略拒绝（退出码非 0，且没有任何正常输出）。**一律用 `npm.cmd`**（本机版本 10.9.9）。

### 4.3 坑三：`files` 白名单的效果与 tarball 布局（✅ 实测）

`npm pack` 实际内容（`npm.cmd pack --pack-destination <临时目录>` 后用 `tar -tzf` 列目录）：

```text
package/src/adapter.js
package/src/client.js
package/src/config.js
package/index.js
package/src/plan.js
package/src/threads.js
package/src/tools.js
package/src/transport.js
package/package.json
package/README.md
package/README.zh.md
package/cordis.patch.yml
（共 12 条，全部带 package/ 前缀）
```

结论：

- **`package/` 前缀是 npm tarball 的标准布局**，pnpm/npm 能直接装——别自己用 `tar` 重打，那会丢掉前缀。
- **`tests/`、`tools/`、`test-out.txt`、`node_modules/` 都没有被打进包**：`files` 是白名单（`package.json:12-18`），只列了 `index.js`、`src`、`cordis.patch.yml`、`README.md`、`README.zh.md`。这正是想要的结果，**不需要改 `package.json`**。
- `node_modules/` 现在存在（里面是一个 `@deepseek-ai` junction），**实测重跑 `npm pack --dry-run` 仍是 12 个条目、不含它**——npm 从不打包 `node_modules`（`bundledDependencies` 除外），它也不在白名单里。
- `README.zh.md` 现在已显式写进 `files`；即便不写，npm 也会强制包含 `README*`（早先那次打包时它还没写进 `files`，同样进包）。
- 附带一提：`test-out.txt` 等调试输出文件不会被 npm 打包，但**会被 git 提交**（如果不用 `.gitignore`）；建议删掉或 gitignore。

### 4.4 Release 资产命名（上游硬规则）

- 上游要求 tarball 必须是 **GitHub Release 托管的 https `.tgz`**，且必须属于该条目自己的仓库：市场源码 `dshmarket/lib/sources.js:30-51` 会解析 URL，要求 `https`、host 必须是 `github.com`、路径以 `.tgz`/`.tar.gz` 结尾、前两段路径**必须与条目仓库一致**（防止条目指向别人的 Release）。`releases/latest/download/` 与 `releases/download/<tag>/` 两种形式都认（`sources.js:194-210`）。
- **资产名不能带版本号**（`contributing.md`）：`latest/download/` 在请求时解析 `latest`，但文件名是照字面取的——叫 `dsh-codex-chatgpt-0.1.0.tgz` 的资产，下次发版就会 404。用固定的 `plugin.tgz` 或 `dsh-codex-chatgpt.tgz`。
- `npm pack` 产出的是 `dsh-codex-chatgpt-0.1.0.tgz`，上传前改名。
- ⚠️ `gh release create --help` 原文："Release assets cannot be modified or deleted" —— 资产名一次定好；要换名得删掉 Release（或用 `gh release upload --clobber`，该 flag 在 `gh release upload` 上存在，已核对 help）。
- ⚠️ 未验证：GitHub 的 `releases/latest` 只指向最新的**非 draft、非 prerelease** Release（GitHub 规范行为，本机未复现）。因此**不要**用 `--draft` 或 `--prerelease` 发这条 Release，否则市场条目里的 `latest/download` 链接解析不到它。

## 5. 发布步骤（从 git init 到 Release）

### 5.1 提权说明

- **不需要提权**（纯本地写仓库内文件）：`git init/config/add/commit/tag`。
- **需要提权**（网络写操作或写仓库外文件）：`gh auth setup-git`、`git push`、`gh repo create`、`gh repo edit`、`gh release create`。
- **需要一次提权的另一类**：在 workspace-write 沙箱下创建 **symlink / junction** 会被拒——这与 `npm pack` 缓存被拒是同一类限制。本机 `dsh plugin --profile web add <本地目录>` 能落地，是因为 profile 里建的是 **Junction**（`LinkType=Junction`，Windows 下 junction 不需要管理员权限），而这一步已在提权条件下完成；你在普通终端里重跑同样的 `add` 时若报链接创建失败，用管理员终端即可。
- 本会话的审批已关闭，因此下面带 ⬆ 的命令**本会话内无法执行**，需要你在管理员/普通终端里自己跑。

### 5.2 本地准备（不需提权）

```powershell
$repo = "<workspace>\dsh-codex-chatgpt"   # 本仓库所在目录
cd $repo

git init -b main
# 提交身份属于本地配置，不要写进这里：按需在本地执行下面两行。
# git config user.name  "<your name>"
# git config user.email "<your email>"
```

建议先加 `.gitignore`（本文件不替你创建）：

```gitignore
node_modules/
.npm-cache/
*.tgz
*-out.txt
```

```powershell
git add -A
git commit -m "feat: register the Codex desktop app's ChatGPT models as a DSH LLM provider"
```

### 5.3 建仓、加 topic（⬆ 需要提权）

```powershell
gh auth setup-git                                   # 把 gh 的 token 配成 git 凭据助手；会写 ~/.gitconfig

gh repo create <owner>/dsh-codex-chatgpt --public --source . --remote origin --push `
  --description "Use the ChatGPT models of the local Codex desktop app as a first-class DSH LLM provider, plus tools to read Codex threads."

gh repo edit <owner>/dsh-codex-chatgpt --add-topic dsh-plugin
```

`gh repo create` 的关键参数已核对 `gh 2.101.0 --help`：`--public` / `--source` / `--remote` / `--push` / `-d, --description` 都存在；**没有** topic 参数，所以 topic 必须另跑 `gh repo edit`。

> ⚠️ **不要把 `$ErrorActionPreference='Stop'` 和 gh/git 混用。** git 把推送进度写到 stderr，PowerShell 会包成 ErrorRecord，在 `Stop` 下整个脚本当场中断——会出现"仓库建好了、Release 没建"的半成品状态，且退出码看起来像失败（这是本机此前踩过的坑）。用默认的 `Continue` 并逐条检查 `$LASTEXITCODE`，或对预期的 stderr 噪音加 `2>$null`。

### 5.4 打 tag 与发 Release（⬆ 需要提权）

```powershell
cd $repo
git tag v0.1.0
git push origin v0.1.0

# 打包：缓存重定向，资产改名去版本号
$cache = Join-Path $env:TEMP "npm-cache-dsh-codex-chatgpt"
npm.cmd pack --cache $cache --offline --no-audit --no-fund     # 产出 dsh-codex-chatgpt-0.1.0.tgz
Copy-Item .\dsh-codex-chatgpt-0.1.0.tgz .\plugin.tgz -Force

# 发 Release：资产名 plugin.tgz 与 yml 里的 tarball 字段一致
gh release create v0.1.0 .\plugin.tgz --title "v0.1.0" `
  --notes "把 Codex 桌面应用的 ChatGPT 模型注册为 DSH 一等 LLM provider（首个公开发布）。"
```

发完之后 `https://github.com/<owner>/dsh-codex-chatgpt/releases/latest/download/plugin.tgz` 就是市场要用的稳定链接。

### 5.5 提交到 awesome-dsh-plugin（⬆ 需要提权，且**仓库要满 1 天**）

新建 `data/plugins/<owner>__dsh-codex-chatgpt.yml`（文件名 = `<owner>__<repo>.yml`）：

```yaml
url: https://github.com/<owner>/dsh-codex-chatgpt
name: <owner>/dsh-codex-chatgpt
category: model
description:
  en: 'Registers the ChatGPT sign-in of the local Codex desktop app as a first-class DSH LLM provider, plus tools that list and read Codex threads.'
  zh: '把本机 Codex 桌面应用的 ChatGPT 登录态注册为 DSH 一等 LLM provider，并提供列出与读取 Codex 线程的工具。'
tarball: https://github.com/<owner>/dsh-codex-chatgpt/releases/latest/download/plugin.tgz
```

规则（全部出自 `contributing.md`）：

- **只提这一个文件**；两个 README 由脚本生成，**不要手改**，也不要改别人的条目。
- `description.en` 必填，以句号结尾；**含 `: `（冒号+空格）必须加引号**（本次已加引号，无害）。
- 描述里不要出现"7 个模型"这类随账号变化的数字——评审会逐条对着代码核，夸大或不实是主要被打回原因。
- `tarball` 可省略（那市场会退回用 `github:owner/repo` 源码安装；本插件无构建步骤，源码安装其实也能用）。
- **不要在 yml 里手写 `npm:` 字段**，会被校验拒绝；npm 映射由 registry 自动采集，且要求已发布包的 `repository` 指回本仓库。
- 一个 PR 最多 3 条；本插件提 1 条即可。
- 仓库创建满 1 天后 CI 才会过——所以 §5.3 建仓和 §5.5 提 PR 之间**最好隔一天**。tag/Release 不必等。

## 6. 提审前建议的 `package.json` 改动（**只是建议，本文件不改代码**）

| 建议 | 理由 | 风险 |
| --- | --- | --- |
| 加 `peerDependencies: { "@deepseek-ai/dsh": ">=0.1.0-rc.1 <0.2.0 \|\| >=0.1.7-rc.1 <0.2.0" }` | 让市场卡片能显示 host 兼容标注（§3.2），并按上游推荐声明官方包 | 必须带 `\|\|` 分支（§3.3）；host 线推进时要补分支；**绝不能写空字符串**（实测会被准入拒绝） |
| 加 `license` + 一个 `LICENSE` 文件（如 MIT） | 公开仓库的常规做法 | 上游 CI（awesome-lint）只在上游仓库跑，⚠️ 未验证它是否检查我们的 license；不影响收录 |
| 加 `repository: { "type": "git", "url": "git+https://github.com/<owner>/dsh-codex-chatgpt.git" }` | 只有在你**发 npm** 时才有意义（上游要求已发布包的 `repository` 指回被收录仓库才会关联）；不发 npm 可以不加 | 无 |
| `private: true` 是否保留 | 见下 | — |
| 加 `screenshots.json`（1–8 张、相对路径、`{"screenshots": [...]}` 亦可） | 市场详情页截图，可选 | 路径不能以 `/` 开头、不能含 `..`；绝对 URL 必须是 GitHub 托管的 https |
| 发版时 bump `version` | 0.1.0 → 0.1.1 …；Release 与 tag 同步 | — |

关于 `private: true`（`package.json:4`）——✅ 本机实测：

- `npm.cmd pack` 不受影响（正常产出 tarball）。
- pnpm 从 tarball 或 `github:owner/repo` 安装依赖时不受影响（`private` 只在发布侧有意义）。
- `npm.cmd publish --dry-run --offline` 在本机**通过了**（exit 0），因为 npm 10.9.9 的 EPRIVATE 拒绝只发生在 workspace 发布路径（`C:\Program Files\nodejs\node_modules\npm\lib\commands\publish.js:136` 的条件是 `workspace && manifest.private`）。
- **结论：不要把 `private: true` 当发布闸门**。要发 npm 就删掉它；不发就留着也无妨。

## 7. 发布后验证

本地 **link 安装已经完成**（✅ 已实测，不是待办）：

```powershell
pnpm dsh plugin --profile web add "<repo>"
```

落地结果（已实读）：

- profile 的 `package.json` 里出现 `"dsh-codex-chatgpt": "link:<repo 的绝对路径>"`，`dsh.profile.bundles` 末项为 `dsh-codex-chatgpt`。
- profile 的 `node_modules/dsh-codex-chatgpt` 是 **Junction**（`LinkType=Junction`，不是 symlink），指向本目录。
- 插件自身 `node_modules/@deepseek-ai/dsh-llm` 也是 **Junction**，指向 checkout 的 `packages\llm\llm`（用于真继承 `LlmAdapter`）。

真机验收（由 Lead 执行，此处仅记录）：10/10 全过——模型 PONG 回复、流式 chunk 顺序、usage、block-end 文本一致、第二轮线程复用约 3.1 s、桌面会话索引 5 条、账号 `chatgpt/plus`。

仍未验证的是 **tarball 形式**的安装（link 与 tarball 是两条不同的安装路径）：

```powershell
# 用本地 tarball 试装（publish.md:184 的官方写法）
pnpm dsh plugin --profile web add "<repo>\plugin.tgz"

# 看 layer 有没有插进来
pnpm dsh --profile web --dump-config

# 重启 dsh web 后生效（Host 侧代码不热重载）
```

线上（⚠️ 未在本机执行）：

```powershell
pnpm dsh plugin --profile web add "https://github.com/<owner>/dsh-codex-chatgpt/releases/latest/download/plugin.tgz"
```

- 市场侧：PR 合并后网站自动重建（`contributing.md`），市场每次打开实时拉 `awesome-dsh-plugin.com/plugins.json`（`dshmarket/README.md:99`），所以合并即可见；⚠️ 具体时延未验证。
- 更新体验：市场优先用"仓库可验证的 npm 包"，其次才是"作者提供的预构建 Release tarball"，最后退回整仓源码下载（`dshmarket/README.md:61`、`dshmarket/lib/sources.js:401-419`）。本例没有 npm 包，所以走 tarball——这正是要发 Release 的原因。

## 8. 可勾选 checklist

**仓库卫生**

- [ ] 决定是否加 `peerDependencies`（§3.3 的写法）与 `license` / `repository`
- [ ] 删除或 gitignore 调试输出（`*-out.txt`）与 `*.tgz`
- [ ] 新建 `.gitignore`（`node_modules/`、`.npm-cache/`、`*.tgz`、`*-out.txt`）
- [ ] 确认 `cordis.patch.yml` 的 `name:` 与 `package.json` 的 `name` 一致
- [ ] 本地跑一次测试：`pnpm test`（`scripts.test` 已带 `--experimental-test-isolation=none --test-timeout=30000`），或直接 `node --test --experimental-test-isolation=none tests/provider.test.js`
      （必须加 `--experimental-test-isolation=none`：默认会为每个测试文件派生子进程，沙箱禁止命名管道会 EPERM）

**打包**

- [ ] `npm.cmd pack --cache <可写缓存目录> --offline --no-audit --no-fund`
- [ ] 确认输出 tarball 的 12 个条目都带 `package/` 前缀，且不含 `tests/`
- [ ] 把 `<name>-<version>.tgz` 复制成**不带版本号**的 `plugin.tgz`

**GitHub（⬆ 提权）**

- [ ] `git init -b main` + 逐仓库 `user.name`/`user.email`
- [ ] 首次提交
- [ ] `gh auth setup-git`
- [ ] `gh repo create <owner>/dsh-codex-chatgpt --public --source . --remote origin --push --description "..."`
- [ ] `gh repo edit <owner>/dsh-codex-chatgpt --add-topic dsh-plugin`
- [ ] `git tag v0.1.0 && git push origin v0.1.0`
- [ ] `gh release create v0.1.0 plugin.tgz --title "v0.1.0" --notes "..."`
      （不要用 `--draft` / `--prerelease`）
- [ ] 浏览器打开 `.../releases/latest/download/plugin.tgz`，确认能下到文件

**上架（⬆ 提权，仓库满 1 天后）**

- [ ] 新建 `data/plugins/<owner>__dsh-codex-chatgpt.yml`（§5.5 模板，只改自己这一个文件）
- [ ] 提 PR：1 条条目、描述与代码一致、`description.en` 以句号结尾
- [ ] PR 通过后（或本地）确认市场详情页能装上

## 9. 未验证事项（不要当事实用）

1. 用 **tarball**（本地 `plugin.tgz` 或 Release URL）真的 `dsh plugin add` 进 web profile —— 未执行；安装路径的正确性依据是 `publish.md:181-184`。已执行的是 **link 形式**的安装（§7），两者不是同一条路径，tarball 还需单独验一次。
2. 所有 GitHub 网络写操作（建仓、push、加 topic、发 Release、提 PR）——本会话审批关闭，未执行；命令参数逐个核对过 `gh 2.101.0` 的 `--help`。
3. 上游 CI 的"仓库满 1 天"自动检查——来自 `contributing.md` 的文字描述，未跑过 CI。
4. GitHub `releases/latest` 与 draft/prerelease 的关系——GitHub 规范行为，未在本机复现。
5. awesome-lint / 站点构建是否检查我们的 `LICENSE`、README 双语——只在上游仓库运行，未验证。
6. 加了显式 `peerDependencies` 后 pnpm 安装时的告警文本——未验证。
