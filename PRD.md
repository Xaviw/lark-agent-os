# lark-agent-os 功能规格说明（PRD）

| 项目 | 内容 |
| --- | --- |
| 产品 | lark-agent-os（飞书 × pi coding agent 网关） |
| 版本 | v2.0（现状实现 + 已确认变更合并后的**目标态**） |
| 技术栈 | Node.js ≥ 22.19 / TypeScript / pnpm；`@larksuite/channel`（飞书 WebSocket）、`@earendil-works/pi-coding-agent`（pi SDK） |

---

## 1. 功能总览

| 模块 | 功能点 | 优先级 |
| --- | --- | --- |
| 消息处理 | 触发规则、`/help` 操作面板、Agent 队列状态机、回复引用 | P0 |
| 会话管理 | 新建 / 切换 / 重命名 / 压缩、群绑定、历史卡复用 | P0 |
| 模型与思考强度 | provider/model 切换、thinkingLevel 设置 | P0 |
| 项目群管理 | 创建项目群、绑定项目（bindProject）、路径解析、群公告 | P0 |
| 命令执行 | 普通命令（流式输出）、常驻任务（后台任务）模式、bgTask 面板 | P0 |
| 会话同步 | 电脑端 → 飞书自动 / 手动同步、防回环、失败轮次 | P0 |
| 状态栏 | usage 状态栏、后台任务数、卡片内容限制 | P1 |
| 配置与生命周期 | 环境变量、state.json、单实例锁、启动 / 优雅关闭 | P0 |

---

## 2. 功能规格

### 2.1 消息处理与操作面板

**触发规则**

- 群聊普通消息须 `@bot`；私聊（p2p）免 `@`，固定使用 `LARK_DEFAULT_WORKSPACE` 且不可切换。
- 文本以 `/` 开头时仅接受 `/help`，其余回复"请在操作面板中完成"。
- 机器人自身消息不处理（防自触发）。
- 消息类型分流（依据 `rawContentType`）：`text` / `post` / `interactive` 按文本处理；`sticker` 静默忽略；`image` / `file` / `audio` / `video` 不直接进入 agent，回复轻提示「已收到 ✅ 引用（回复）该文件并附上需求，即可让我处理」，用户「引用（回复）」该消息并附文字后处理（见「引用附件」）。
- 群未绑定项目 → 回复"该群尚未绑定项目，请使用 `/help` 中的「绑定项目」"。
- 机器人被加入群聊（`im.chat.member.bot.added_v1`，main.ts 接线 `handleBotAdded`）：自动绑定默认工作区（后续可通过「修改绑定」更换）并发送欢迎卡（含「打开操作面板」按钮，cmd `help`）；重复加群（binding 已存在）仅补发欢迎卡、不覆盖已有绑定。
- 话题窗口（thread）消息：事件 `chat_id` 与原会话相同、额外带 `thread_id`。话题消息优先走**话题独立 session**（见「话题窗口（thread）」），不依赖主会话 activeSessionFile（主会话未选 Session 不影响话题）。

**`/help` 操作面板**

- 无需 `@`，唯一文本命令。卡片展示当前工作路径、绑定 / Session 状态提示，按钮**全部主色（primary）**、按组分列（`flex_mode: flow`，超宽自动换行）：

| 组 | 按钮（显示文本 / cmd） |
| --- | --- |
| 1 | 切换模型 `model.form` · 切换思考强度 `thinkingLevel.form` · 重命名会话 `session.rename.form` |
| 2 | 新建会话 `session.new.form` · 压缩会话 `session.compact` · 切换会话 `session.resume.form` · 同步消息 `session.sync.form` · 重新加载 `config.reload` |
| 3 | 执行命令 `command.form` · 快速提问 `quickAsk.form` · 创建项目群 `project.create.form` · 绑定项目 `project.bind.form` · 后台任务 `bgTask.form` |

- 提示语：未绑定群 →"此群尚未绑定项目，请先绑定。"；已绑定未选会话 →"请使用"新建会话"或"切换会话"。"（话题模式不显示绑定 / Session 提示，按钮裁剪见「话题窗口（thread）」）

**Agent 队列与状态机**

- 每群独立队列，同一群同时只执行一个任务；状态：`queued → running → succeeded / failed / cancelled`（含 `stopping` 中间态）。
- 排队：发「Agent 等待处理」卡（含停止按钮，**无确认弹窗**——排队中停止即撤销提交，无损失）；排队中停止 → 取消（"已在开始前取消"）。
- 执行中：原位更新「Agent 正在处理」卡，以 **750ms 节流**刷新回复预览（事件驱动，无新输出不刷新），含停止按钮（**带 `confirm` 二次确认弹窗**）。
- 停止：立即发过渡卡「正在停止 Agent」且**携带当前最新输出**（内容不丢失）；`pi.abort()` 完成后最终卡「Agent 已停止」= 完整输出 + 状态栏。过渡卡移除停止按钮，避免重复 abort。
- 完成 / 失败：最终卡无按钮，标题含耗时（如"Agent 处理完成 - 耗时：23 秒"）；**最终回复只追加**——prompt 返回后先补渲染最新流式帧（节流可能未触发，避免「中途帧 → 最终卡」跳变），最终卡保留中途上下文（`displayPrompt` 请求行，快速提问场景）+ 完整流式累积（含中途已显示内容，不一致时拼接保留），仅追加完成状态；失败 = 已有输出 + 错误信息 + 状态栏。
- 边界：停止后预览节流停止（`state !== running`）；多群并行、每群串行（同一 session 文件被多群共享时，prompt/compact/rename 等写操作跨群同样串行，按 sessionFile 锁）；服务关闭时统一停止并通知（见 2.8）。

**回复引用上下文（含引用附件）**

- 消息带 `replyToMessageId` 时抓取被引用消息：文本 / post 消息截断 12,000 字符后与发送者以 `<quoted_context>` 注入 prompt（纯附件类消息的 normalize 占位不注入）；抓取失败 → 回复原因，本轮不进 agent。
- 被引用消息带资源（图片 / 文件 / 音视频 / 贴纸）时下载到 `<LARK_STATE_DIR>/media`（sha256 命名、同内容复用、mtime LRU 清理，容量上限 `LARK_MEDIA_CACHE_MAX_BYTES` 默认 512MB，下载超时 30s）。**下载在后台异步进行**：消息到达**立即**发「Agent 等待处理」卡（不等文件下载完成），附件就绪后才进入 agent 执行并流式更新；任一附件下载失败 / 超限 → 任务卡以「Agent 处理失败」结束，本轮不进 agent。
- 注入分级：`image/*` 且 ≤10MB 且当前模型支持视觉输入（Model.input 含 image）→ 以 base64 图片附件随 prompt 注入（模型可直接查看）；其余（含超限 / 不支持视觉的图片）→ 注入文件名、大小、mime、本地路径，由 agent 自行读取（会话默认启用 read / bash 等工具）。
- 获取失败（`fetchMessage` 抛错）或内容为空 → **不进入 agent 流程**（不建 run、不设 `inFlightFeishuRun`），以 markdown 回复固定原因「无法读取被引用的消息。」（错误码 1069307 无权限时给专门提示），内部错误详情只进日志。
- 边界：引用消息过长时注入截断版本并标注。

**Agent 发送图片（send_image）**

- Agent 在对话过程中可调用 `send_image` 工具，把一张图片作为**独立图片消息**发送到当前飞书对话（可放大 / 保存 / 转发），并继续用文字说明图片内容。
- **注册**：`AgentSessionConfig.customTools`（SDK 层、进程内，按 session 闭包捕获 sessionFile / cwd）；主会话 / 话题会话 / 快速提问会话统一注册。工具不写 session JSONL（图片消息不进入对话上下文、不参与电脑端同步），也不渗透到电脑端独立启动的 pi agent（电脑端无此工具）。
- **参数**：`target` = 本地图片文件路径（**绝对路径**，或**相对 Agent 命令工作目录**（与 bash 等命令工具所在目录一致）的相对路径；**不限制路径范围**，但拒绝敏感文件）或 http(s) 图片 URL；截图 / 下载等工具返回的本地路径可直接传入。单张 ≤10MB（`SEND_IMAGE_MAX_BYTES`，对齐飞书上传图片接口上限），URL 下载超时 15s（`SEND_IMAGE_DOWNLOAD_TIMEOUT_MS`）。
- **敏感文件拒绝**：本地路径命中黑名单（`.env` 系列、`*.pem` / `*.key` / `*.p12` / `*.pfx`、SSH 私钥名 `id_rsa` 等、任意位置 `.ssh` 目录）时拒绝发送（`isSensitiveLocalPath` 纯函数），缓解 prompt injection 诱导 Agent 外泄凭据的风险；正常图片产物不受影响。
- **发送目标反查**：pi 按 sessionFile 记录当前活跃 run 的 `chatId` + 状态卡 `messageId`（per-session 串行锁保证同一时刻每 sessionFile 至多一个活跃 run，多群共享 session 时也唯一）；图片消息 `replyTo` 状态卡（话题内状态卡在话题窗口 → 图片保持在话题窗口内）。
- **发送链路**：读本地文件 / 下载 URL → Buffer → `channel.send(chatId, { image: { source: Buffer } }, { replyTo })`。Buffer source 不触发 `outbound.allowedFileDirs` 限制；channel 内部上传 `im/v1/images` 后发独立 `image` 消息。
- **失败兜底**：文件不存在 / 路径非文件 / 大小超限 / 下载失败 / 上传失败 / 无活跃 run → 工具结果返回错误文本给 Agent（Agent 在回复中说明），不阻塞本次 prompt。

**Agent 屏幕截图（screenshot）**

- Agent 可调用 `screenshot` 工具截取本机 Windows 系统屏幕，保存为 PNG 文件并返回本地路径；Agent 用 `send_image` 把截图发给用户（或先自行读取分析）。
- **注册**：`AgentSessionConfig.customTools`（与 send_image 同模式，进程内注入、执行器惰性取值）；主会话 / 话题会话 / 快速提问会话统一注册，工具不写 session JSONL、不渗透电脑端独立启动的 pi agent。
- **target 语义**：`primary`=主显示器；`all`=每台显示器各一张（推荐，文件小）；`display:N`=第 N 台（从 1 起，缺省 1，可先 `all` 查列表）；`full`=整块虚拟桌面拼接（多显示器 + 高 DPI 时文件可能很大）；`window`=指定窗口（`windowTitle` 标题关键字模糊匹配 或 `pid` 进程号，两者都不给截前台窗口）。
- **窗口级截图**：`PrintWindow` + `PW_RENDERFULLCONTENT`（可截被遮挡窗口）；**最小化窗口**自动执行「还原 → 移屏外(-32000,-32000) → PrintWindow → 再最小化」技巧（本机实测可截 Windows 11 新版记事本这类 WinUI 应用；少数 UWP / 硬件加速窗口可能失败 → `window-capture-failed`）。
- **DPI**：PowerShell 脚本内 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`，高 DPI（如 200% 缩放）下按物理像素截图（本机实测主屏 2880×1800 物理），避免 GDI 虚拟化导致模糊。
- **不可用场景明确报错**（`screenshotErrorText` 中文映射）：`no-interactive-session`（服务 / Session 0 无法截用户桌面）、`window-not-found`（附当前可见窗口列表）、`display-not-found`（附显示器列表）、`window-capture-failed`、`capture-failed`、`write-failed`、`unsupported-platform`（非 Windows）、`timeout`、`exec-failed`、`parse-failed`、`bad-target`。
- **空白检测**：截图后采样唯一颜色数 + 平均亮度，全黑 / 纯色标记 `blank` 并警告（显示器关闭 / 锁屏 / 无法离屏渲染的启发式提示；物理关屏通常得到陈旧帧或黑屏，无可靠探测 API）。
- **产物与清理**：PNG 写入 `<LARK_STATE_DIR>/screenshots`，保留最近 `SCREENSHOT_KEEP_COUNT`（50）张、超出按 mtime 清理（`pruneScreenshots`）；执行超时 `SCREENSHOT_TIMEOUT_MS`（30s）。
- **实现**：内嵌 PowerShell 脚本（ASCII-only，参数经 UTF-8 JSON 文件传递规避命令行编码问题，ps1 写临时目录带 UTF-8 BOM），spawn `powershell.exe` 执行，解析单行 JSON 结果标记（`parseScreenshotOutput` 纯函数）。
- **失败兜底**：任何错误转为工具结果文本返回给 Agent，不阻塞本次 prompt。

**话题窗口（thread）**

- 飞书「创建话题」后，话题窗口中的消息事件与原会话共享 `chat_id`、额外带 `thread_id`；话题窗口不是独立 chat，但对话归属**独立 session**（不 fork、不继承主会话历史）。
- **懒初始化**：话题内首次 `@bot`（群）/ 任意消息（私聊）时自动新建 session（命名 `话题-MM-DD HH:mm`，电脑端 pi 列表可见）并绑定 `threadId`；之后话题内对话持续写入该 session，与主会话完全隔离（不写入主会话、不依赖主会话已选 Session）。同一 threadId 并发首条消息只创建一次（in-flight 守卫 + 双检）；多个话题各自独立 session；不同群可存在相同 threadId（按 chatId 隔离）。
- 触发规则沿用原会话：群话题内须 `@bot`（`/help` 免 `@`）；私聊话题免 `@`。话题内 `@bot` 而群未绑定项目 → 仍提示先绑定。
- **help 话题模式**：去掉「新建会话 / 切换会话 / 绑定项目 / 同步消息」按钮（话题自动绑定独立 session，无手动会话管理；话题 session 不参与同步）；工作路径显示群绑定 cwd 并标注「话题固定使用该工作路径，不支持修改」（未绑定群仍提示先绑定）；保留模型 / 思考强度 / 重命名 / 压缩 / 重新加载 / 命令 / 快速提问 / 创建项目群 / 后台任务。话题内的会话操作（切换模型、思考强度、重命名、压缩、重新加载）作用于**话题 session** 而非主会话。
- **公告**：话题内不触发群公告（懒初始化建会话、切换模型、设置思考强度、重命名均跳过公告刷新）；话题不会产生独立公告。
- **卡片操作感知**：cardAction 事件无 `threadId`，优先命中**发送侧记录**（本服务发出卡片时记录 messageId → threadId，普通群卡片链零网络开销），未记录（重启后旧卡）才 `fetchMessage(event.messageId)` 反查（in-flight 守卫；失败不缓存、按非话题处理）；`handleCardAction` 内**惰性反查**（`agent.stop` / `command.stop` 零反查）。话题内卡片操作：会话解析为话题 session；响应 `replyTo` 触发卡（保持在话题窗口内，含命令卡）；群级 cmd（新建 / 切换 / 创建 / 使用 session、绑定项目、同步消息）直接拒绝（toast「话题内不支持该操作，请回到群聊使用」，防旧卡 / 直连）；`pending` 仅主会话挂起消息使用（key = `chatId`）。
- **不同步**：话题 session 不参与电脑端 → 飞书同步（watcher 只监听主会话 activeSessionFile）；同步游标 / 防回环 / inFlight 均不涉及话题 session（`markFeishuOriginEntries` 按主会话 activeSessionFile 匹配，话题轮次不标记、不累积；进程异常退出后 reconcile 清理话题 inFlight 仅清不标）。话题窗口内对话由飞书 → 电脑端方向直接写入共享 JSONL，电脑端 resume 可见。

### 2.2 会话管理

- **绑定**：每群一个 `activeSessionFile`；已绑定但未选会话时，首次普通消息自动弹 `新建会话` / `切换会话` 选择卡（未绑定群先提示绑定，见 2.1）。
- **新建**：名称必填；成功后发送确认消息、更新群公告；无历史会话时直接展示新建表单。
- **切换会话**：列表显示"显示名称 + 消息条数"（最多显示前 10 个，超出提示可用新建会话或直接发消息处理）；名称优先级：自定义名称 > 首条用户消息前 48 字符（超出 `…` 截断）> "未命名会话"；校验会话属于当前项目且存在；切换后更新公告；若由普通消息触发则继续处理该消息。
- **重命名**：名称必填，换行折叠为空格；写入 session 文件并更新公告。
- **压缩**：`session.compact()` 异步执行（每群 in-flight 守卫防连点重复压缩）；**不刷新群公告**；点击后立即弹「正在压缩」状态卡（fire-and-forget，防 3s ack 超时；压缩排队等待 session 锁期间保持该状态，若 Agent 正在处理将等其完成后执行，不中止任务），压缩完成后更新为最终卡——成功显示「会话压缩成功 + 压缩前后 context 对比（如 170k → 59k，-65%）+ 压缩后状态栏」，失败显示「会话压缩失败：<原因>」（错误信息截断 200 字符；起始卡未发出时退化为直接发失败消息）。入口按钮带 `confirm` 二次确认弹窗（压缩不可逆）。
  - 边界：compact 会中止进行中的 agent 任务（pi SDK 行为，接受不处理）；失败场景含 session 过小（"Nothing to compact"）、已压缩、模型无凭证。
- **重新加载**：`config.reload` 对应 pi 的 `/reload`（Reload keybindings, extensions, skills, prompts, themes and context files）；调用 `AgentSession.reload()`（重读 settings、重置 API providers、重载资源并重建扩展 runtime），**不需要会话操作历史**但须已选会话（无会话时提示先选）；点击后立即弹「正在重新加载」状态卡（fire-and-forget，与压缩同链路），完成后更新为最终卡——成功「重新加载成功 + reload 后状态栏」，失败「重新加载失败：<原因> + 可再次点击「重新加载」重试」（错误信息截断 200 字符；起始卡未发出时退化为直接发失败消息）。每群 in-flight 守卫（`reloadingChats`）防连点重复重载；与压缩/agent 同受 session 锁串行（Agent 处理中会等待其完成）。**不刷新群公告**；入口按钮**无** `confirm`（非破坏操作）。状态卡链路与压缩会话共用 `runStatusCardOp`（fire-and-forget：starting 卡 → 操作 → success/failure 最终卡，起始卡未发出时降级为失败消息）。
  - 扩展重启：SDK reload 内部仅在存在 uiContext/shutdownHandler/onError 等 bindings 时才自动重发 `session_start`；本项目只 `bindExtensions({ mode: 'print' })`，故 `PiSessions.reload` 在 `session.reload()` 后显式重新 `bindExtensions` 触发 `session_start`，MCP 等扩展随 reload 重启并重新初始化。
- **历史卡片复用（无 nonce）**：卡片操作不携带 nonce、不依赖 pending 过期校验，历史卡（含二级选择器/表单）可重复使用——唯一限制是飞书卡片 14/30 天交互有效期（超期客户端提示、回调不达）与平台连点限流（~10s，客户端提示「操作太频繁」）。可用性由业务校验兜底：`session.use` 校验 session 属于当前项目且存在；`session.sync.submit` / `model.select` / `thinkingLevel.select` / `session.rename.submit` 校验当前 session 文件存在（toast「该会话已不存在，请使用「切换会话」重新选择」）；模型/思考强度由 pi SDK 校验 + 全局兜底 toast。挂起消息（`showSessionSetup` 暂存于 `pending`）在选中/新建会话后一次性续跑（`takePendingPrompt`：消费即删；超 `PENDING_PROMPT_MAX_MS`=30 分钟不续跑并 toast 提示，防陈旧请求被历史卡误触发）。
- **点击去重**：SDK `safety.dedup.ttl` = 3s（默认 12h 会静默拦截同一卡片同一按钮的重复点击）；快速连点（~10s 内）由飞书平台限流拦截（客户端提示「操作太频繁」，事件不发出）；应用层防重推——卡片事件按 `event_id`（30 分钟）、消息按 `messageId`（1 小时）去重（`createSeenSet`，内存态）。合法重复点击不受限（新 `event_id` 放行）。

### 2.3 模型与思考强度

- **模型切换**：`model.form` 列出 `ModelRuntime` 可用模型，`model.select` 调用 `setModel()` 并持久化到 session、更新公告；无可用模型提示。
- **思考强度**：`thinkingLevel.form` 列出 `getAvailableThinkingLevels()`，`thinkingLevel.select` 调用 `setThinkingLevel()`；当前 model 不支持时提示。
- 边界：切换模型后可用强度随之变化；两者均需已选会话。

### 2.4 项目群管理

**创建项目群（`project.create.form/submit`）**

- 表单：群名称（可选）+ 工作路径（必填，解析规则见下）。
- 默认群名 = `basename(cwd)` + 本地时间 `YYMMDDHHmm`（如 `my-project2508100932`；`basename` 为空兜底 `project`；用本地时区）。
- 流程：`lark.createChat` 创建新群并邀请操作者 → state 绑定（`chatType: group`）→ 发送欢迎消息 → 更新公告 → 确认消息 + toast。提交为 fire-and-forget（toast「正在创建项目群…」先行，后台执行；成功由新群欢迎消息 + 本群确认消息呈现，失败补发错误消息）——建群 + 公告 Docx 链可能超过飞书 3s 回调窗口（见「点击去重」段）；配每群 in-flight 守卫（`creatingGroups`），进行中重复提交 toast「正在创建项目群，请稍候。」

**绑定项目（`project.bind.form/submit`，bindProject）**

- 未绑定群：新增绑定；已绑定群：修改绑定（覆盖 `cwd`）；表单仅工作路径（必填）。
- 表单标题按状态区分：「绑定项目」（未绑定）/「修改绑定」（已绑定）。
- 提交成功后：`state.update({ cwd, chatType: 'group', activeSessionFile: undefined, sessionSync: undefined, feishuOriginEntryIds: undefined, inFlightFeishuRun: undefined })` → `flush` → `reconcile` → 更新公告。
- 边界：清空 `activeSessionFile` 后下一条普通消息自动走 `新建会话` / `切换会话` 选择卡（与切换会话同策略）；**分支须在绑定检查（`if (!binding)`）之前**，未绑定群才能使用；p2p 不适用（固定默认工作区）。

**私聊自动绑定**：私聊首条消息自动绑定 `LARK_DEFAULT_WORKSPACE`；已有绑定但路径不符则覆盖。

**工作路径解析**：支持绝对路径、`~` / `~/...`、相对当前工作路径；`~foo` 等非法形式报错；表单展示相对基准。**语法校验（平台感知）**：Windows 拒绝非法字符（`<>:"|?*`，`:` 仅允许盘符位）、控制字符、段尾空格/点、保留设备名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9，含扩展名）、非盘符/UNC 绝对路径；POSIX 拒绝 NUL 字符；均限长 4096 字节。**存在性校验**：创建项目群 / 绑定项目提交时，解析后的路径必须已存在且为目录（文件或不存在 → toast 报错，不执行）。

**群公告（Docx API）**

- 内容：
  ```
  Project: <cwd>
  Provider: <provider> · Model: <model> · Thinking: <thinkingLevel>
  Work Path: <cwd>
  Session: <session 显示名称>
  ```
- 触发时机：新建会话 / 切换会话 / 重命名会话、切换模型、设置 thinkingLevel、服务启动（**不含 compact**）。
- 首条公告创建后置顶（pin）；私聊不维护；无公告编辑权限时降级为日志告警。**话题窗口不维护公告**：话题内产生的操作（懒初始化建会话、切换模型、设置思考强度、重命名）均跳过公告刷新（见「话题窗口（thread）」）。未选会话时（如改绑后）公告更新为占位内容（`Session: 未选择`），避免残留旧项目信息；**从未有过公告的群不创建占位公告**（避免未选 session 就置顶），首条公告仍由首次选 session 触发。

### 2.5 命令执行

**表单（`command.form`）**

- 「命令」必填（空则报错）；超时秒数（可选，1–86,400 整数，输入框**默认值 10**，可修改或清空——清空即不自动停止）。
- 「常驻任务」勾选器（`checker` 组件，`name: 'isBackground'`）：JSON 2.0 支持；约束飞书客户端 V7.9+（低版本显示占位）。
- 提交解析：`cardFormValue` 需支持 boolean 值（当前只提取 string，需扩展）。

**普通模式**

- `spawn(shell, [...args, commandPrefix + cmd])`，在群绑定工作路径执行；shell 平台感知（`resolveShell`）——Windows 固定 `cmd.exe /d /s /c`（POSIX 命令如 `ls` 不可用，需 cmd 语法；命令前自动前置 `chcp 65001 >nul && `，但 chcp 只改控制台代码页、对 cmd 内建命令管道输出无效——内建中文按系统 ANSI 代码页（GBK）输出，由 `decodeCommandLine` 逐行双解码还原（仅 Windows 启用，POSIX 直接 UTF-8 透传）；外部现代工具（git/node 等）自选 UTF-8 不受影响），macOS / Linux 沿用 `$SHELL`（缺省 `/bin/sh`，`-lc`）；spawn 带 `windowsHide: true` + `windowsVerbatimArguments: true`（原样传引号，修复默认转义下 `> "path"` 重定向失败）。
- 执行中卡片**流式节流更新**：stdout/stderr `data` 事件触发 750ms 节流，**stdout/stderr 原样**原位刷新卡片；**无「查看输出」按钮**，仅「停止」。
- 结束：最终卡 = 已流式显示的累计输出 + **追加状态消息**（`\n\n命令执行完成。` / `命令执行失败（退出码 N，信号 S）。` / `命令超时（N 秒）并已停止。` / `命令已手动停止。`），标题保留状态文本；输出统一使用可容纳内嵌反引号的动态长度 code fence。
- 停止：进程组 SIGTERM → 5s 未退 SIGKILL（Windows 退化为单进程 kill）；点击停止后先追加「正在停止命令」；停止按钮带 `confirm` 二次确认弹窗。
- 超时：到点先更新最终卡再终止进程组。
- 边界：输出内存截断 30 KB；卡片 6000 字符限制（头 1/3 + 尾部 + 截断标记），输出超 `COMMAND_FOLD_THRESHOLD`（2000 码点）时最终卡折叠为「首屏预览（前 1200 码点 + 补闭合 code fence）+ 默认收起的 `collapsible_panel`（面板内完整输出，展开可见全部）」；spawn 失败提示「命令启动失败」；节流 + `createCardUpdater` 串行化防高频写卡。

**快速提问（`quickAsk.form` 表单内，help 项目按钮行独立入口）**

- 「快速提问」：**一次性无上下文 agent 问答**，用于项目群任务之外的简单提问（不占用主会话、不带历史关联）；help 卡片第二行按钮「快速提问」→ `askFormCard`（单个「问题」输入框，必填）→ `quickAsk.submit`；话题内同样可用（回复到触发表单卡）。
- 流程（`runQuickAsk`，`src/agent/ask.ts`）：每群固定「快速提问」session（懒创建持久化 `binding.askSessionFile`，读取兼容旧字段 `aiCommandSessionFile`；首次创建时同步主 session 当前模型；独立于主会话，**不参与电脑端同步、不触发公告**）→ 提问任务进 AgentRunManager 每群队列（排队/生成中卡复用 agent 卡链，停止按钮 `agent.stop` 复用，inFlight 防回环标记复用）→ **用户输入原样作为 prompt（无提示词注入）** → agent 回复由卡链直接呈现（无解析、无命令转交）。
- 「快速提问」session 出现在切换会话列表（命名「快速提问」，可辨识）。

**常驻任务（后台任务）模式**

- 勾选「常驻任务」后：**忽略超时秒数**；spawn 成功立即 finish 本次任务卡（「后台任务已启动」），**不进入 `commandTasks`**，注册到 `backgroundTasks: Map<taskId, BackgroundTask>`（`id / command / cwd / startedAt / child / terminate`）。
- spawn 失败：按普通命令「命令启动失败」处理。

**bgTask 面板**

- help 第三组「后台任务」按钮 → `bgTaskListCard`：列出所有后台服务「命令 + 启动时间 + 停止按钮」；无任务提示"当前没有后台任务"；停止按钮带 `confirm` 二次确认弹窗。
- `bgTask.stop`：终止对应后台任务并移除、刷新列表。
- 边界：`bgTask.form` 分支放在绑定检查**之前**（后台任务与绑定无关，未绑定群可查看）。

**状态栏后台任务数**

- 状态栏末尾追加「后台任务 ×N」，仅 N>0 时显示；数据由 `PiSessions` 构造注入的 `backgroundTaskCountProvider`（读取 `backgroundTasks.size`）提供；`statusAt`（历史快照）不显示。

### 2.6 会话同步

**方向**：电脑端 → 飞书由本服务推送；飞书 → 电脑端无推送（共享 session 文件，电脑端 resume 即可）。**话题独立 session 不参与本同步**（见「话题窗口（thread）」）。

**自动同步**

- 监听活动 session 文件所在目录（`fs.watch`）+ 60s 轮询大小 / mtime 兜底；变化 750ms 防抖。
- 群无进行中飞书任务（`agentRuns.isActive` 与 `inFlightFeishuRun` 均空）时，同步**最新完成一轮**电脑端对话：标题行 `[User] 时间戳` / `[Agent] 时间戳` **加粗**（text 元素 + style），每条消息内容后跟**空行**（text 元素）；post 行结构，内容行用 `md` 元素（飞书原生 markdown 渲染，与 agent 回复一致）+ 状态栏（可选）。
- 当多个群共享同一 `activeSessionFile` 时，忙碌判定按 session 文件维度执行：任一绑定群存在 Agent run 或飞书 in-flight 轮次，所有绑定群均暂缓自动同步；run 完成后统一重新调度这些群。
- 同步前两次 stat 校验（间隔 100ms），不一致视为写入中，指数退避重试（最多 3 次）。

**手动同步**：`sync` 表单可填轮数（正整数 ≤ 1000，留空全部）。提交为 fire-and-forget：toast「正在同步消息，请稍候。」先行，后台执行 `syncComputerSessions` 后结果（已同步条数 / 重试 / 忙碌 / 进度重置 / 无待同步）以消息呈现，失败补发错误消息——同步链路（解析 session JSONL + `statusAt` 快照初始化 + 28KB 富文本发送）可能超过飞书 3s 回调窗口；配每群 in-flight 守卫（`syncingChats`），进行中重复提交 toast「正在同步消息，请稍候。」。若 compact 等操作导致旧进度 entry id 消失，本次仅清除失效游标并提示再次同步；再次同步从当前文件重新选择轮次，可能包含已发送历史，但不静默跳过未同步轮次。

**防回环（方案 B）**

- 进度（`lastSyncedEntryId`）推进到**已消费轮次**——无论被**发送**（电脑端轮次）还是被**排除**（飞书轮次）；从扫描范围末尾向前找第一个已消费轮次推进。手动重置时仅保留仍存在于当前 JSONL 的 `autoBaselineEntryId`，失效基线会清除。
- `feishuOriginEntryIds` 为**即时标记**：飞书 run 结束后按 `inFlightFeishuRun.runId` 校验属主并标记本轮 ids（旧状态缺 runId 时兼容 `beforeEntryIds` 对比）；同步消费后清理进度之前的 ids（状态 O(1)，`slice(-1000)` 仅作极端兜底）。
- `PiSessions.prompt()` 在 sessionFile 锁内、调用 SDK prompt 前采集并持久化 `beforeEntryIds`，完成后再捕获本轮实际新增 entry ids；正常路径使用精确新增 ids，`beforeEntryIds + prompt` 仅用于进程异常退出后的启动 reconcile，避免锁外并发写入导致同文本历史消息误配。
- `from` = auto 时 `max(lastSynced, baseline)` / manual 时 `lastSynced`；auto 仅取最新一轮、manual 按 count 回溯——语义保持。
- agent 运行中不触发自动同步；异常中断后服务启动时 reconcile 补标记未完成飞书轮次。

**超长处理**

- 同步消息体按 UTF-8 **字节数**判断（飞书富文本上限 30 KB，预留转义 / md 标签膨胀余量取 **28 KB**）。
- 超限**截断 + 说明**后发送：按**行**分配预算（头 1/3 行 + 截断说明行 + 尾 2/3 行），头部与尾部至少各保留 1 行（最新轮次优先保留在尾部）；极端超长单行退化为**字符级截断**（按码点切分，避免多字节乱码）；`sent` 计数不变，toast「已同步 N 轮（内容已截断）」；自动 / 手动同步均适用。

**失败轮次**

- 电脑端轮次最终 assistant `stopReason = error` 且错误**不可重试** → 同步显示「处理失败：<错误>」。
- 可重试错误（overloaded / rate limit / 5xx / 网络中断 / 超时等）且重试次数 ≤ `LARK_PI_RETRY_MAX_RETRIES`（默认 3）→ 视为重试中，不显示失败。
- 计费类错误（usage limit / 余额不足 / quota 等）始终视为失败。

### 2.7 状态栏与卡片限制

- Agent 最终回复底部附 pi footer 同口径状态栏：`↑input ↓output Rcache Wcache CH% $cost xx.x%/窗口大小 (auto) [后台任务 ×N]`。
- `(auto)` 标记**固定跟随 `session.autoCompactionEnabled`**（无环境变量开关，项目固定使用自动压缩）。
- 「后台任务 ×N」仅 N>0 时显示（见 2.5）；`statusAt`（同步到飞书的电脑端轮次）不含后台任务数。
- `LARK_PI_STATUS_ENABLED=false` 可关闭整条状态栏。
- 卡片 Markdown 上限 6000 字符：保留头 1/3 + 尾部，插入「（内容已截断）」。

### 2.8 配置、持久化与生命周期

**环境变量**

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `LARK_APP_ID` | 是 | — | 飞书应用 ID |
| `LARK_APP_SECRET` | 是 | — | 飞书应用密钥 |
| `LARK_DEFAULT_WORKSPACE` | 否 | 进程 cwd | 私聊 / 默认工作路径 |
| `LARK_STATE_DIR` | 否 | `.state` | 状态目录 |
| `LARK_PI_STATUS_ENABLED` | 否 | `true` | Agent 回复状态栏开关 |
| `LARK_PI_RETRY_MAX_RETRIES` | 否 | `3` | 同步失败轮次可重试阈值 |
| `LARK_MEDIA_CACHE_MAX_BYTES` | 否 | `524288000` | 引用附件缓存总容量（字节），LRU 按 mtime 清理 |

**state.json**（原子写入：tmp + rename，串行防覆盖）：每群绑定 `cwd`、`chatType`、`activeSessionFile`、`feishuOriginEntryIds`（即时标记，见 2.6）、`sessionSync`（`autoBaselineEntryId` / `lastSyncedEntryId` / `lastLarkMessageId`）、`inFlightFeishuRun`、`threadSessions`（`threadId → { sessionFile, updatedAt }`，话题独立会话，懒初始化）、`updatedAt`。旧版 `sessionFile` 字段自动清除。Session 内容由 pi SDK 持久化（JSONL）。

**单实例锁**：`instance.lock` 写 PID；进程存活则拒绝启动；持有进程已退出（ESRCH）自动清理重试；获取锁时清理同目录中已确认失主的 `.tmp` 候选文件，避免异常退出长期积累。

**启动流程**：校验 env → 建目录加载 state → 获取锁 → 初始化 pi / 飞书通道 → 连接 → reconcile watcher 与 inFlight → 刷新已绑定群公告。

**优雅关闭（SIGINT / SIGTERM）**：终止 `commandTasks` 与 `backgroundTasks`（进程组 SIGTERM → 5s SIGKILL）→ 关闭 watcher → 停止 agent 任务（排队取消、执行中 abort，1.5s 内发送「服务正在关闭」卡）→ 等待后台 fire-and-forget 任务收尾（手动同步 / 建群，上限 10s，确保进度 / 绑定落盘）→ `pi.dispose` → flush state → 断开飞书 → 释放锁退出。
- 已知竞态：`process.exit(0)` 可能先于 SIGKILL 兜底定时器，忽略 SIGTERM 的进程可能残留。

**群生命周期（机器人被移出群 / 群解散）**：SDK 未订阅 `bot.removed` / `disbanded` 事件，以外向发送失败信号驱动清理（`src/lark/chat-lifecycle.ts`）：
- 触发点：全部 `lark.send`（经 `sendChat` 包装）、卡片更新（`updateCardWithRetry`）、群公告 API 失败；
- 判定（纯函数 `isChatUnreachable`）：错误码 `target_revoked` 仅对无 replyTo 的发送生效（避免回复目标消息被删误伤），或错误文本命中群级特征（`10030` 机器人不在会话 / `232009` 群已解散 / 机器人不在 / 群不存在）；消息级错误（10020 消息不存在、230001 参数错误）不命中；
- 清理（幂等 `cleanupChat`）：取消该群 Agent run（排队取消 + 执行中 abort）→ 终止前台命令 → 清 pending（含话题 key）→ `sessionSyncWatcher.forget` + reconcile → 删除 binding；后台任务不按群索引（无 chatId 字段）、全局保留。用户重新加回机器人后需重新绑定（群聊）；私聊失效清理后下次消息自动重建绑定。

---

## 3. 架构与数据流

```
飞书客户端（群聊 / 私聊）
  │ WebSocket（@larksuite/channel）
  ▼
lark-agent-os（单进程 + 实例锁）
  ├─ 事件分发：handleMessage / handleCardAction
  ├─ AgentRunManager：每群队列 + 状态机（750ms 节流预览）
  ├─ PiSessions：pi SDK 封装（sessionFile 串行锁 + 32 个空闲实例 LRU；prompt / abort / models / thinkingLevel / rename / compact / reload / status）
  ├─ SessionSyncWatcher：电脑端 → 飞书同步（watch + 轮询，方案 B 进度推进）
  ├─ 命令执行器：普通命令（流式输出）+ backgroundTasks（常驻任务）
  ├─ LarkApi：tenant token 缓存 + 群公告 Docx API
  └─ StateStore：state.json 原子持久化
        │                 │
        ▼                 ▼
  pi coding agent     电脑端 pi（并行运行）
 （飞书/电脑端共用     （完成的对话轮次自动同步到飞书群）
  session JSONL）
```

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 入口 / 编排 | `src/main.ts` | 事件分发、队列、命令 / 后台任务、同步、公告、生命周期 |
| pi 封装 | `src/pi.ts` | 会话 / 模型 / 状态栏封装 |
| 卡片定义 | `src/cards.ts` | 全部卡片 schema |
| 状态存储 | `src/state.ts` | state.json 读写（原子、串行、迁移） |
| 群公告 API | `src/lark-api.ts` | token 缓存 + Docx 公告 |
| 类型定义 | `src/types.ts` | ChatBinding / SessionSyncState |

---

## 4. 依赖与权限

- 飞书应用：启用机器人消息事件（WebSocket）；`im:chat`（建群）；`im:resource`（获取与上传图片或文件资源，`send_image` 工具上传图片依赖）；群公告 Docx API 需在群内且具公告编辑权限（群主 / 管理员限定群需额外权限）。
- pi SDK：读取本机 `~/.pi/agent` 的 provider / model / auth 配置。
- pi 扩展：飞书会话与 pi CLI 共享用户级扩展（`~/.pi/agent/settings.json` 的 `packages`，如 pi-mcp-adapter / pi-web-access / pi-subagents）；会话打开时 `bindExtensions` 触发 `session_start` 初始化（否则 pi-mcp-adapter 不启动、`mcp` 工具调用返回 "MCP not initialized"），释放时发 `session_shutdown` 清理。
- 命令执行：shell 平台感知（`resolveShell`）——Windows `cmd.exe /d /s /c`（前置 `chcp 65001`，对 cmd 内建管道输出无效，内建中文经逐行双解码 `decodeCommandLine` 还原，仅 Windows 启用）、POSIX `$SHELL`（默认 `/bin/sh`，输出直接 UTF-8 透传）。

---

## 5. 边界与已知限制

1. 仅国内版飞书（`open.feishu.cn`），不支持国际版域名。
2. 仅处理普通文本；富媒体不触发 agent。
3. 每群同时一个 agent 任务，队列无长度上限提示。
4. 私聊固定默认工作路径，不可切换项目。
5. 服务启动不补发历史电脑端对话（只同步新完成轮次）。
6. 同步方向不对称：飞书 → 电脑端靠共享文件 + resume，无推送。
7. 命令进程终止在 Windows 退化为单进程 kill；shutdown 存在 SIGKILL 兜底竞态（见 2.8）。
8. 群公告无权限时静默降级（仅日志）。
9. 后台任务不持久化（服务重启后不恢复，仅关闭时清理）。
10. `checker` 组件需飞书客户端 V7.9+（低版本显示占位）。
11. 每会话独立 MCP runtime（与 pi CLI 一致）：server 懒连接按需 spawn 进程，LRU 上限 32 个会话可共存多份同款进程，会话淘汰 / 服务关闭时经 `session_shutdown` 清理。
12. `send_image` 工具的 URL 来源仅限 http(s)，下载不设 SSRF 过滤（信任 Agent，仅限协议 + 大小 / 超时）；本地路径不限制工作目录，但拒绝敏感文件（`.env` / 私钥 / 证书 / `.ssh` 目录，见 2.1「Agent 发送图片」），降低 prompt injection 外泄凭据风险。
13. 扩展工具面：`mcp` / `web_search` / `subagent` 等扩展工具对可私聊机器人的成员（`dmMode: 'open'`）可用，`~/.pi/agent/mcp.json` 中 server 的内嵌凭据（如 figma API key）随之暴露给对话方；如需限制可配置适配器 `approveTools` 或收紧 bot 可见范围。
14. `screenshot` 工具把整块屏幕（含所有应用窗口内容）暴露给对话方：对 `dmMode: 'open'` 的私聊成员可用，存在屏幕内容泄露风险，部署时注意 bot 可见范围 / 权限。截图依赖「活跃图形会话 + 可用显示器」：服务会话（Session 0）无法截图、显示器物理关闭 / 锁屏时内容陈旧或黑屏（详见 2.1「Agent 屏幕截图」）。
