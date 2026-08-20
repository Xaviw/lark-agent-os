# AGENTS.md（lark-agent-os）

面向 coding agent 的项目上下文与操作说明。人类文档见 `README.md`；功能目标态见 `PRD.md`。

## 项目概览

- **定位**：国内版飞书（`open.feishu.cn`）× pi coding agent 的网关。飞书群聊 / 私聊消息交给 pi 处理，卡片完成会话 / 模型 / 命令 / 项目群操作。
- **技术栈**：Node.js ≥ 22.19 / TypeScript（strict）/ pnpm；`@larksuite/channel`（飞书 WebSocket 接入）、`@earendil-works/pi-coding-agent`（pi SDK）、`dotenv`。
- **单进程模型**：入口 `src/main.ts`（约 110 行）为唯一组装点；启动时校验必填 env → 加载 state → 获取单实例锁 → 装配 AppContext → 连接飞书 → reconcile → 刷新公告。业务逻辑按域拆分到独立模块（见下表）。

## 开发命令与验证

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | tsx 直接运行 `src/main.ts`（需 `LARK_APP_ID` / `LARK_APP_SECRET`，会真实连接飞书） |
| `pnpm dev:watch` | 热重载运行 |
| `pnpm typecheck` | `tsc --noEmit`，**每次改动后必须通过** |
| `pnpm build` | 编译到 `dist/`（`noEmitOnError`） |
| `pnpm start` | 运行 `dist/main.js` |

- **无测试框架 / 无 lint 脚本**。验证手段：
  1. `pnpm typecheck` + `pnpm build`；
  2. 纯逻辑（如 `selectSyncTurns`、`truncateSyncRows`、节流、卡片构建）用**临时 tsx 脚本**直接 import 项目模块验证边界，通过后删除，不留项目内；注意 `config.ts` 顶层会解析 env（缺 `LARK_APP_ID` 抛错），脚本需先设 `LARK_APP_ID` / `LARK_APP_SECRET` 再动态 import（ESM 静态 import 先于赋值执行）；
  3. 端到端需真实飞书凭据，无法在本地自动验证——依赖上一步的逻辑测试 + 仔细的代码审查。
  4. **扩展绑定冒烟**（pi SDK 升级后复用）：临时 tsx 先设 `LARK_APP_ID` / `LARK_APP_SECRET` 再动态 import `PiSessions`（避免 `config.ts` 顶层校验）→ `ensure` → `status`（内部走 getOrOpen + `bindExtensions`）→ 从 `(pi as any).sessions` 取实例执行 `mcp({ status: true })` 断言不含 "MCP not initialized" → `dispose` 无挂起。
- 抽纯函数便于验证：把副作用（state/lark 调用）与决策逻辑分离（参考 `selectSyncTurns` 模式）。纯函数模块（`sync/select-turns.ts` / `sync/truncate.ts` / `utils/format.ts`）不依赖 state / lark，可独立 import 验证。

## 架构与模块

按「模块化单体 + 单一组装点」组织：`main.ts` 只做装配，业务按域拆分。共享依赖通过 `AppContext`（`src/app-context.ts`）传递；`AgentRunManager` ↔ `SessionSyncWatcher` 的交叉引用由 main.ts 组装点 `attach` 注入打破循环依赖。

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 唯一组装点：启动引导、ctx 装配 + attach、事件接线、shutdown、单实例锁（约 110 行） |
| `src/config.ts` | env 解析（`LARK_*`）+ 业务常量（`*_LIMIT` / `*_INTERVAL_MS` / `SYNC_*`） |
| `src/app-context.ts` | `AppContext` 类型：全局共享依赖（state / pi / api / lark / 任务容器 / agentRuns / sessionSyncWatcher） |
| `src/types.ts` | 共享类型（`ChatBinding` / `SessionSyncState` / `AgentRun` / `CommandTask` / `BackgroundTask` / `ComputerTurn` 等） |
| `src/pi.ts` | `PiSessions`：pi SDK 封装（按 sessionFile 串行写操作、32 个空闲实例 LRU；prompt / abort / models / thinkingLevel / rename / compact / status / statusAt）；会话打开后 `bindExtensions({ mode: 'print' })` 触发扩展 session_start（SDK 纯路径不会自动发，pi-mcp-adapter 依赖它初始化 MCP，否则 mcp 工具调用返回 "MCP not initialized"），释放前（LRU 淘汰 / dispose）emit session_shutdown 停止扩展 MCP runtime 防 server 进程泄漏；`statusFor` 状态栏；构造可注入 `backgroundTaskCountProvider` |
| `src/cards.ts` | 全部飞书卡片 schema（JSON 2.0：help / 欢迎卡 / 表单 / 选择器 / 状态卡 / `bgTaskListCard`） |
| `src/state.ts` | `StateStore`：state.json 原子写入（tmp + rename、串行 flush）、`delete(chatId)`（群失效清理）、旧字段迁移 |
| `src/lark-api.ts` | tenant token 缓存 + 群公告 Docx API |
| `src/agent/run-manager.ts` | `AgentRunManager`：每群队列 + 状态机（queued → running → succeeded / failed / cancelled，含 stopping 过渡）；`cancelChat(chatId)`（群失效清理：复用 stop 语义） |
| `src/agent/prompt.ts` | `runPrompt` / `promptWithReplyContext` / `useNewSession`（引用消息上下文、飞书来源标记） |
| `src/agent/ask.ts` | 快速提问（一次性无上下文 agent 问答）：编排（懒创建独立 session → agent 队列 prompt → 卡链直接呈现回复，无提示词注入 / 无解析 / 无命令转交） |
| `src/commands/shell.ts` | 命令执行（平台感知 shell：Windows `cmd.exe /d /s /c`、POSIX `$SHELL -lc`、超时、常驻任务、`terminateProcessGroup`；`decodeCommandLine` 逐行双解码（UTF-8 + GBK 兜底，纯函数，仅 Windows）/ `createOutputDecoder` 流式解码器（平台路由 + 无换行超长输出缓冲上限保护）） |
| `src/sync/session-entries.ts` | session JSONL 解析（轮次划分 / 可发布判断 / 可重试错误）+ `sessionBranchEntries` / `extractText`（纯函数） |
| `src/sync/select-turns.ts` | `selectSyncTurns`：方案 B 轮次选择（纯函数） |
| `src/sync/truncate.ts` | `truncateSyncRows`：28KB 按行截断（纯函数，头 1/3 行 + 尾 2/3 行，超长单行退化为字符截断） |
| `src/sync/sync-service.ts` | `syncComputerSessions` / `ensureAutoBaseline` / `markFeishuOrigin` / `workspaceForChat` |
| `src/sync/watcher.ts` | `SessionSyncWatcher`：fs.watch + 轮询 + 防抖 + 退避（电脑端 → 飞书单向同步）；`forget(chatId)`（群失效清理挂起调度） |
| `src/utils/instance-lock.ts` | 原子发布 PID 实例锁、存活探测、陈旧锁清理与属主校验释放 |
| `src/lark/chat-lifecycle.ts` | 群生命周期：`isChatUnreachable`（群不可达判定，纯函数）/ `sendChat`（发送 + 群失效兜底）/ `handleChatGone` / `cleanupChat`（幂等清理：取消 agent run、终止命令、清 pending、停同步、删 binding） |
| `src/lark/messages.ts` | `handleMessage` + 私聊绑定 / `handleBotAdded`（加群自动绑定 + 欢迎卡）/ help / session 选择卡 |
| `src/lark/topics.ts` | 话题（thread）支持层：懒初始化独立 session（`ensureThreadSession`）、消息会话解析（`sessionFileForMessage`）、卡片消息反查 threadId（`cardThreadId`，带缓存） |
| `src/lark/card-actions.ts` | `handleCardAction`：全部 cmd 分支 + 表单解析（`cardFormValue` / `cardFormFlag` / toast / `parseCommandTimeout`） |
| `src/announcement.ts` | 群公告 Docx 更新 + session 元数据读取 |
| `src/utils/card-update.ts` | `createCardUpdater` / `updateCardWithRetry`（带 chatId，失败时判定群失效）/ `createThrottledUpdate` |
| `src/utils/format.ts` | `commandOutputMarkdown` / `elapsedSince` / `agentFailureContent` / `defaultProjectName` / `resolveWorkspacePath`（解析 + 平台语法校验，纯函数） |
| `src/utils/workspace.ts` | `validatePathSyntax`（平台感知路径语法校验，纯函数）/ `assertWorkspaceDirectory`（存在且为目录校验，异步；非安全边界，仅提交时即时反馈） |

## 关键机制（代码事实，维护时勿偏离）

- **卡片交互**：全部为 JSON 2.0（`schema: '2.0'`）。按钮 `behaviors: [{ type: 'callback', value: { cmd, ... } }]`；危险操作按钮（压缩会话 `session.compact`、Agent 运行中停止 `agent.stop`、命令停止 `command.stop`、后台任务停止 `bgTask.stop`）带 `confirm` 二次确认弹窗（`{ title, text }` 均 plain_text；确认后照常回调，客户端行为不影响服务端去重）；排队卡停止按钮**无** confirm（撤销提交无损失）；表单用 `form` 容器 + `input` / `checker`（V7.9+）。`cardFormValue` 只取 string 值并 trim；布尔字段（checker）用 `cardFormFlag` 单独读取。**卡片操作不再使用 nonce**：历史卡片（含二级选择器/表单）可重复使用，唯一限制是飞书卡片 14/30 天交互有效期（超期客户端拦截）与平台连点限流（~10s，客户端提示「操作太频繁」）；`pending` 槽只承载「挂起消息上下文」（`showSessionSetup` 暂存，选中/新建会话后经 `takePendingPrompt`（`utils/pending-prompt.ts`）一次性消费续跑，超 `PENDING_PROMPT_MAX_MS`=30 分钟不续跑并 toast 提示「之前挂起的消息已超过 30 分钟未处理」；消费即删防历史卡重复触发续跑）；历史卡可用性校验：`session.use` 按 `sessions.find` 校验，`session.sync.submit` / `model.select` / `thinkingLevel.select` / `session.rename.submit` 前置 `sessionFileExists`（stat）校验（toast「该会话已不存在，请使用「切换会话」重新选择」）；`model.select` 等失败路径由 SDK 校验 + main.ts 全局兜底 toast 覆盖。`session.create.submit`（新建会话）为 **fire-and-forget**：先回 toast「已创建会话：…，正在初始化。」，后台异步执行 `useNewSession`（pi 初始化 + 公告 + 发消息），失败补发错误消息——飞书 WS 事件需 3s 内 ack（SDK 等 handler 返回才发 ack），重量级链路阻塞 ack 会触发平台重推与客户端「目标回调服务未响应」；挂起消息续跑随之移入后台（消费即删语义不变，续跑结果由处理中卡片呈现）。`useNewSession` 内公告为 `void` 不等待（辅助信息不阻塞会话创建与消息发送）；创建流程有每群 in-flight 守卫（`creatingSessions`），进行中重复点击 toast「正在创建会话，请稍候。」**所有「打开表单/选择器」类按钮**（help / command.form / quickAsk.form / project.create.form / project.bind.form / bgTask.form / session.new.form / session.resume.form / model.form / thinkingLevel.form / session.sync.form / session.rename.form）的卡片发送均为 **fire-and-forget**（`fireSendCard`：先回 toast、后台发送、失败补发消息）；`session.sync.submit` / `project.create.submit` 同模式（含 `syncingChats` / `creatingGroups` 每群守卫）；话题反查 `cardThreadId` 限时 `CARD_THREAD_FETCH_TIMEOUT_MS`=2s（超时按非话题处理、不缓存下次重试）。同样重量级链路均改为 fire-and-forget：`session.sync.submit`（手动同步：解析 session JSONL + `statusAt` 快照初始化模型运行时 + 28KB 富文本发送 + state 落盘）先回 toast「正在同步消息，请稍候。」，后台执行 `syncComputerSessions` 后结果（条数/重试/忙碌/进度重置/无待同步）以消息呈现，失败补发错误消息；`project.create.submit`（建群 + 拉人 + 欢迎消息 + 群公告 Docx 链）先回 toast「正在创建项目群…」，后台执行 `createProject`（成功由新群欢迎消息 + 本群确认消息呈现，失败补发错误消息）。后台化消除了 handler 串行对重复提交的天然拦截，两者均配每群 in-flight 守卫（`syncingChats` / `creatingGroups`，防并发重复同步同一进度、防连点重复建群）。
  - **卡片按钮可重复点击**：`@larksuite/channel` safety 层按 `card:{messageId}:{openId}:{actionId}` 去重，默认 TTL 12h（同一卡片同一按钮只放行一次，实测确认）；已把 `safety.dedup.ttl` 缩短为 3s。快速连点（实测窗口约 10s）由飞书平台限流拦截——客户端提示「操作太频繁」，事件不发出（非服务端文案，无需处理）；防重推由应用层承担：`handleCardAction` 用事件唯一 ID `event_id` 去重（30 分钟窗口，`utils/seen.ts` 的 `createSeenSet`，raw 事件含 `event_id`；长连接无 X-Refresh-Token header）；`handleMessage` 用 messageId 去重（1 小时窗口，补偿 seenCache 缩短后断线重连/平台重推的空隙）。
- **卡片更新**：`createCardUpdater`（pending + 单飞队列串行化 + 失败重试一次）；`finish` 不丢弃已排队的 update（补帧预览先发完再发最终卡，避免「中途帧 → 最终卡」内容跳变），多次 finish 由 finishTail 链保序（过渡态 → 最终态）；**事件驱动节流**（750ms，非轮询）——agent 预览与命令输出共用该模式（`createThrottledUpdate`）。内容限制：卡片 6000 字符（`limitedMarkdown` 头 1/3 + 尾），命令输出内存 30KB。命令最终卡输出超 `COMMAND_FOLD_THRESHOLD`（2000 码点）时折叠为「首屏预览 + 默认收起面板」（`collapsible_panel`，展开可见面板内完整输出；首屏为输出前缀、由 `closeCodeFence` 补闭合 fence 保证独立渲染；判定/切分均按码点）；运行中卡不折叠（750ms 全量更新会重置面板展开状态）。
- **Agent 队列状态机**：每群串行 `queued → running → succeeded / failed / cancelled`（含 `stopping`）；停止过渡卡带 `run.latestOutput`；`inFlightFeishuRun.beforeEntryIds` 在 sessionFile 锁内、SDK prompt 前采集并持久化，结束后按精确新增 ids 即时标记飞书来源。
- **命令执行**：shell 平台感知（`resolveShell` 纯函数）——Windows 固定 `cmd.exe /d /s /c`（POSIX 命令如 `ls` 不可用，需 cmd 语法；命令前自动前置 `chcp 65001 >nul && `，但 chcp 只改控制台代码页，对 cmd 内建命令的管道/文件输出无效——其输出恒按系统 ANSI 代码页（中文系统 = GBK），内建命令中文由 `createOutputDecoder` 逐行双解码（UTF-8 严格解码 + 异常 Unicode 区块检测 → GBK 兜底，**仅 Windows 启用**，POSIX 直接 UTF-8 透传）还原，外部现代工具（git/node 等）自选 UTF-8 不受影响），macOS / Linux 沿用 `$SHELL`（缺省 `/bin/sh`，`-lc`）；于群绑定 cwd 执行；spawn 带 `windowsHide: true` + `windowsVerbatimArguments: true`（原样传引号，与 cmd 解析一致——默认转义使 `> "path"` 重定向报「语法不正确」）；进程组 SIGTERM → 5s SIGKILL（`terminateProcessGroup`，Windows 退化为单进程 kill）；普通模式输出流式节流更新（无换行超长输出有缓冲上限保护，超出部分强制解码丢弃），输出中的反引号由动态长度 code fence 包裹；Agent 最终回答保留 Markdown 原文；「常驻任务」勾选后注册到 `backgroundTasks`（不进入 `commandTasks`），`shutdown` 时全部终止。后台任务不持久化。
- **快速提问**：help 项目按钮行「快速提问」→ `askFormCard`（单个「问题」输入框，必填）→ `quickAsk.submit`——`runQuickAsk`（`src/agent/ask.ts`）：每群固定「快速提问」session（懒创建持久化 `binding.askSessionFile`，读取兼容旧字段 `aiCommandSessionFile`，首次创建时同步主 session 当前模型；独立于主会话、不参与电脑端同步、不触发公告）；提问任务走 AgentRunManager 每群队列（与主对话互斥、复用停止按钮与 inFlight 防回环）；**一次性、无上下文**：用户输入原样作为 prompt（无提示词注入、无结果解析/命令转交），agent 回复由 agent 卡链直接呈现；话题内同样可用（回复到触发表单卡）。
- **会话同步（方向不对称）**：
  - 电脑端 → 飞书：`SessionSyncWatcher`（fs.watch + 60s 轮询 + 750ms 防抖 + 双 stat 校验 + 指数退避 ≤3 次）单向推送；同一 `activeSessionFile` 被多个群绑定时，任一群的 Agent / 飞书轮次都会让所有绑定群暂缓同步，完成后统一重新调度；
  - 飞书 → 电脑端：**无推送**，pi SDK 直接写共享 session JSONL，电脑端 resume 可见；
  - 防回环（方案 B）：`selectSyncTurns` 把飞书轮次视为已消费并推进进度，`feishuOriginEntryIds` 消费即清理（O(1)，`slice(-1000)` 仅兜底）；
  - 超长：同步消息体按 **28KB（UTF-8 字节）** 截断 + 说明（飞书富文本上限 30KB，错误码 230025）。
  - 同步消息格式：post 行结构——`[User]/[Agent]` 时间戳标题行用 `text` 元素 + `style: ['bold']` 加粗，内容行用 `md` 元素（飞书原生 markdown 渲染，与 agent 回复一致：加粗/代码/链接/标题生效；列表不渲染、段落换行由 md 处理），每条消息后跟一个空 `text` 行渲染为可见空白行（实测确认）。
- **话题窗口（thread）**：话题消息事件与原会话共享 `chat_id`、带 `threadId`。话题内首次 @bot（群）/任意消息（私聊）懒初始化**独立 session**（`src/lark/topics.ts` 的 `ensureThreadSession`，命名 `话题-MM-DD HH:mm`，in-flight 守卫 + 双检防并发重复创建）并绑定 `binding.threadSessions[threadId]`；话题对话不写入主会话、不依赖主会话 activeSessionFile。**cardAction 事件无 threadId**——优先命中**发送侧记录**（`rememberCardThread`：本服务发出卡片时记录 messageId → threadId，普通群卡片链零网络开销），未记录（重启后旧卡）才 `fetchMessage` 反查（`cardThreadId`，in-flight 守卫、失败不缓存按非话题处理）；`handleCardAction` 内**惰性反查**（`resolveThread`，`agent.stop` / `command.stop` 零反查）。话题语义：会话 = 话题 session（切换模型 / 思考强度 / 重命名 / 压缩作用于话题 session）、**不触发公告**（懒初始化与各 updateAnnouncement 调用点均跳过）、**不参与电脑端同步**（watcher 只监听 activeSessionFile，reconcile 仅清理话题 inFlight 不标记）、help 话题模式去「新建会话 / 切换会话 / 绑定项目 / 同步消息」且工作路径固定不可改、群级 cmd 直接拒绝（`TOPIC_BLOCKED_CMDS` 含 session.sync.*，防旧卡 / 直连）。话题内卡片响应 `replyTo` 触发卡（保持在话题窗口内，含命令卡——`startShellCommand` 带 replyTo）；`pending` 仅主会话挂起消息使用（key = `chatId`；话题内群级卡被拒、不产生挂起上下文）。
- **群公告**：Docx API；触发时机 = 新建会话/切换会话/重命名会话、切换模型、设置 thinkingLevel、服务启动（**不含 compact**）；首条创建后 pin；私聊不维护；**话题内操作不触发**。
- **群生命周期（`src/lark/chat-lifecycle.ts`）**：SDK 无 `bot.removed` / `disbanded` 事件订阅，以**外向发送失败信号**驱动清理——所有 `ctx.lark.send` 统一走 `sendChat` 包装（无 replyTo 时 `target_revoked` 视为群不可达；带 replyTo 仅匹配错误文本特征，防回复目标消息被删误伤），卡片更新（`updateCardWithRetry`）与群公告 API 失败同样判定（`isChatUnreachable` 纯函数：`10030` / `232009` / 已解散 / 机器人不在 / 群不存在）；命中即 `cleanupChat`（幂等）：取消该群 agent run（`cancelChat` 复用 stop 语义）→ 终止前台命令 → 清 pending（含话题 key）→ `watcher.forget` + reconcile → `state.delete`。后台任务不按群索引（`BackgroundTask` 无 chatId），不清理。
- **加群欢迎（botAdded）**：main.ts 接线 `im.chat.member.bot.added_v1` → `handleBotAdded`：无 binding 时自动绑定默认工作区（后续可「修改绑定」）并发欢迎卡（`botWelcomeCard`，按钮 cmd `help` → `handleCardAction` 的 `help` 分支复用 `showHelp`）；binding 已存在仅补发欢迎卡。
- **state.json**（默认 `.state/state.json`）：每群 `cwd / chatType / activeSessionFile / feishuOriginEntryIds / sessionSync / inFlightFeishuRun / threadSessions（话题 threadId → { sessionFile, updatedAt }）/ askSessionFile（快速提问专用会话，懒创建；历史数据中的旧字段 aiCommandSessionFile 读取兼容）/ updatedAt`。
- **单实例锁**：`.state/instance.lock` 写 PID；持有进程存活则拒绝启动，ESRCH 自动清理重试；启动获取锁时会清理同目录中已确认所属进程退出的候选 `.tmp` 文件。

## 命名与代码约定

- **交流、文档、注释一律简体中文**；标识符 / 错误消息用中文也可，但 `cmd` 值、env 名、字段名保持英文。
- 思考强度用 `thinkingLevel`（**绝不用 `effort`**）。
- `cmd` 命名：`<域>.<动作>`（如 `project.bind.submit`、`session.compact`）；按钮显示文本中文、`cmd` 不变。
- 环境变量：`LARK_APP_ID` / `LARK_APP_SECRET`（必填）、`LARK_DEFAULT_WORKSPACE`（默认进程 cwd）、`LARK_STATE_DIR`（默认 `.state`）、`LARK_PI_STATUS_ENABLED`（默认 true）、`LARK_PI_RETRY_MAX_RETRIES`（默认 3）、`LARK_MEDIA_CACHE_MAX_BYTES`（引用附件缓存上限，默认 512MB）。已删除 `LARK_PI_STATUS_AUTO_COMPACTION`，勿再引入。
- 常量集中在 `src/config.ts`（`*_LIMIT`、`*_INTERVAL_MS`、`SYNC_*` 等）；env 解析也在此（顶层求值，import 即校验必填项）。

## 文档工作流（重要）

- **新需求 / 改动**：先与用户讨论方案、确认后再实施，**不直接改代码**；用户明确指示实施时才改。
- **探索型任务**（如飞书组件能力验证）：由 agent 自行验证（查文档、写临时脚本），无需等用户确认。
- `PRD.md` 为功能目标态规格，随实现同步更新；文档描述必须以**代码事实**为准（如同步方向不对称、`(auto)` 标记固定跟随 session 设置）。

## 批量实施经验

1. **改前做区域关联分析**：多条改动共享代码区域时（如 helpCard 按钮行被 #1/#2/#3/#8 共用、`syncComputerSessions` 被 #10/#11 共用、`runShellCommand` 被 #8/#9 共用），先按区域合并/拆分批次——同区域一次改完，避免反复编辑与互相覆盖。
2. **edit 多块是原子应用**：一次调用中任一 `oldText` 不匹配则**整体失败**，失败后易漏改其他块（本次曾因此残留 `command.output` 分支直到 grep 才发现）。改完必须 grep 验证关键标记（被删除的分支名、新增关键词/常量）确认真正生效。
3. **oldText 唯一性**：同一文本出现多处时（如 `const binding = state.get(event.chatId);` 在 main.ts 出现两次）加长上下文；同一调用内两个 edit 的 `oldText` 不得重叠/嵌套。
4. **核心逻辑 review 边界分支**：涉及进度推进 / 消费 / 截断 / 分组取舍的逻辑，改完检查空集、全排除、单元素等路径（本次方案 B 曾把进度推进写进“有发送”分支，导致纯飞书轮次被排除时进度不推进——review 时发现并移出发送分支）。
5. **复杂算法先写临时边界测试**：用临时 tsx 脚本验证边界（多字节字符切分、临界字节、突发节流、空态、交错轮次），通过后删除脚本；断言要基于**需求语义**（如 auto = 最新电脑端轮次，而非“最新轮”）。副作用与决策分离成纯函数（如 `selectSyncTurns`、`truncateSyncRows`）以便独立测试。
6. **清理要成对**：移除清单类文档的条目时同步插入归档记录；收尾时 `grep -n "^## "` 核对标题完整性（曾漏删正文条目，收尾才统一清理）。
7. **含反引号的归档片段**：用临时文件 + node 拼接写入，避免 shell 模板字符串转义问题。

## 飞书相关文档探索策略

1. **本地优先（权威）**：`node_modules/@larksuite/channel/dist/index.d.mts` 是 `LarkChannel` API 的类型权威——`send / updateCard / createChat / fetchMessage / disconnect` 的签名、`NormalizedMessage`（`chatId / chatType / content / mentionedBot / senderId / replyToMessageId`）、`CardActionEvent`（`action.value / action.formValue / operator / raw`）。`node_modules/@larksuite/channel/README.zh.md` 有中文说明。
2. **在线文档**：飞书开放平台 `https://open.feishu.cn/document/`（**仅国内版，勿用国际版 open.larksuite.com**）。网络受限时先设代理：`$env:HTTP_PROXY="http://127.0.0.1:7897"; $env:HTTPS_PROXY="http://127.0.0.1:7897"`，仍失败则暂停并向用户反馈。
3. **已踩过的关键限制（务必记住）**：
   - 消息体上限：文本 150KB、**富文本 post / 卡片 30KB**，超限错误码 **230025**；
   - 卡片 JSON 2.0 组件：`form / input / button / checker / column_set / hr / markdown`；**checker 需客户端 V7.9+**；
   - 群公告 Docx：block_type 1=page、2=text；`createAnnouncementTextBlock / pinAnnouncement / updateAnnouncement / announcementBlocks`；
   - WebSocket 长连接接入，无需 webhook。
4. **新增 API / 卡片字段时**：先查类型定义确认签名 → 字段语义不明再查在线文档（可用 `fetch_content` 抓取）→ 用临时脚本验证 schema 结构 → 注意错误码与国内版域名差异。

## pi 相关文档探索策略

1. **本地优先（权威）**：
   - SDK 包：`node_modules/@earendil-works/pi-coding-agent/` 的 `README.md`、`docs/`（`sdk.md`、`models.md`、`packages.md`、`compaction.md`、`custom-provider.md`、`environment-variables.md` 等）、`dist/index.d.ts`（`AgentSession` / `SessionManager` / `ModelRuntime` 类型签名）。
   - 项目内封装：`src/pi.ts` 已提炼全部常用操作（prompt / abort / models / setModel / thinkingLevels / setThinkingLevel / rename / compact / status / statusAt / create / ensure / dispose），改交互前先读它。
2. **pi 工具本体文档**（查 pi 自身功能时）：系统安装位置 `C:\Users\70446\AppData\Local\mise\installs\npm-earendil-works-pi-coding-agent\0.84.1\node_modules\.mise\@earendil-works+pi-coding-agent@0.84.1\node_modules\@earendil-works\pi-coding-agent\`（`README.md` + `docs/`，含 sdk / models / packages / custom-provider 等）。
3. **session JSONL 格式**：entry `type` 含 `session` / `message` / `model_change` / `thinking_level_change` / `compaction` 等；`message` 有 `role / content / stopReason / errorMessage / usage`；解析与轮次划分参考 `main.ts` 的 `sessionBranchEntries` / `completedComputerTurns` / `readSessionMetadata`。
4. **常见 API 速查**：`SessionManager.open(file, undefined, cwd)` / `create` / `list` / `getBranch` / `getEntries` / `appendSessionInfo`；`AgentSession.prompt / abort / compact / setModel / setThinkingLevel / getAvailableThinkingLevels / sessionManager / subscribe / dispose`；`ModelRuntime.create().getAvailable()`；状态栏口径见 `statusFor`（`getSessionStats` + `autoCompactionEnabled`）。
5. **验证**：pi 的行为（如 compact 中止运行中任务）为 SDK 既定行为，探索时以类型定义 + 文档为准，必要时写临时脚本实测，避免臆测。

## 运维与注意事项

- **重启警告（重要）**：不要在由同一个 `lark-agent-os` 进程处理的飞书 Agent 请求中执行 `kill -TERM <lark-agent-os-pid>`——服务进入关闭流程后会中止所有正在执行的 Agent run（含当前请求），导致 `Error: This operation was aborted`。应在当前 Agent 请求完成后，从**外部终端**重启服务；如必须以编程方式触发重启，应先启动一个脱离旧服务进程组的 supervisor，再停止服务；supervisor 等待旧 PID 退出后再启动新实例。
- 排查：关键路径日志前缀 `[agent run]` / `[command]` / `[session sync]` / `[announcement]` / `[session watch]` / `[compact]` / `[cardAction]`；状态看 `.state/state.json`；锁文件残留（进程已死）会自动清理。
- **扩展工具面（安全知会）**：飞书会话与 pi CLI 共享用户级扩展（`~/.pi/agent/settings.json` 的 `packages`：pi-mcp-adapter / pi-web-access / pi-subagents 等），`mcp` / `web_search` / `subagent` 等扩展工具对可私聊机器人的成员（`dmMode: 'open'`）可用；`~/.pi/agent/mcp.json` 中 server 的内嵌凭据（如 figma API key）随之暴露给对话方，部署时注意 bot 可见范围与 `approveTools` 等适配器设置。
- 已知边界：Windows 下进程组终止退化为单进程 kill；Windows 固定 `cmd.exe` 执行（POSIX 命令如 `ls` 不可用，需 cmd 语法；已前置 `chcp 65001` 切 UTF-8 代码页，但按 GBK 硬编码输出的老程序仍会乱码；命令内嵌引号经 node spawn Windows 转义后可能原样输出含 `\` 的引号）；后台任务不持久化（重启不恢复）；`checker` 需客户端 V7.9+；群公告无权限时降级为日志；每会话独立 MCP runtime（与 pi CLI 一致）：server 懒连接按需 spawn 进程，LRU 上限 32 个会话可共存多份同款进程，会话淘汰 / 服务关闭时经 `session_shutdown` 清理。
- shutdown 流程：终止 commandTasks + backgroundTasks → 关 watcher → 停止 agent（1.5s 内发「服务正在关闭」卡）→ 等待后台 fire-and-forget 任务（手动同步 / 建群，`pendingBackground` 容器，上限 10s）→ `pi.dispose` → flush state → 断开飞书 → 释放锁退出。
