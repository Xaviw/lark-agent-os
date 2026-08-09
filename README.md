# lark-agent-os

最小国内版飞书 + pi agent 示例：

- 群聊中 `@bot` 的消息交给 pi；
- pi 完成后以飞书 Markdown 富文本回复；每个 Agent 最终回复底部带 pi 同口径的 usage 状态栏；
- 群只绑定项目工作目录；项目下存在历史 session 时，通过飞书卡片选择要使用的 session，也可以选择新建；新建必须在卡片表单填写 session 名称。
- `/help`（无需 @）是唯一文本命令，打开操作面板；所有会话、模型、命令执行和创建项目群操作均通过卡片触发。
- session 显示名称优先使用自定义名称；未命名的历史 session 使用首条用户消息的前 48 个字符（超出以 `…` 截断）。群公告显示 provider、model、work path 和当前 session，切换 session 后自动更新。

## 启动

```bash
cp .env.example .env
# 编辑 .env，至少填写 LARK_APP_ID 和 LARK_APP_SECRET
pnpm install
pnpm dev
```

示例固定使用国内版飞书 API（`https://open.feishu.cn`）。飞书应用需要启用机器人消息事件并具备创建群聊所需的 `im:chat` 权限。当前实现使用 `@larksuite/channel` 的 WebSocket 事件接入，不需要额外配置 webhook 服务。

pi SDK 默认读取本机的 `~/.pi/agent` provider/model/auth 配置。若使用自定义 pi 配置目录，按 pi SDK 的 `ModelRuntime.create()` 约定调整环境或后续代码。

状态栏由 `.env` 配置：`LARK_PI_STATUS_ENABLED=false` 可关闭；`LARK_PI_STATUS_AUTO_COMPACTION=false` 可隐藏末尾的 ` (auto)` 标记。状态栏使用 pi footer 的累计 input/output/cache、最近一轮 cache hit、累计成本和当前 context usage 口径。

## 命令

- `/help`：无需 @机器人，是飞书唯一支持的文本命令。单聊固定使用 `LARK_DEFAULT_WORKSPACE` 作为工作路径，不能切换；卡片显示当前工作路径；
- 操作面板：提供 `model`（provider/model 选择）、`effort`（当前 model 的思考强度）、`name`（重命名当前 session）、`new`（必填名称新建 session）、`compact`（压缩当前 session 上下文）、`resume`（选择历史 session）和 `sync`（同步电脑端 session 对话）。`sync` 可填写最新同步轮数，留空同步全部新消息；未选择 session 时，首次普通消息会显示 `new` 或 `resume` 卡片；
- 操作面板的“执行命令”：在群绑定的工作路径中执行 shell 命令；可选填写超时秒数。命令启动后立即发送一张任务卡片，支持查看最近输出和停止命令；仅在状态变化、查看输出或结束时原位更新该卡片；
- 操作面板的“创建项目群”：以卡片表单填写群名称与工作路径并创建、绑定项目群；
- 群聊普通消息仍需 @机器人；私聊不需要 @。以 `/` 开头的文本仅接受 `/help`，其余会提示从操作面板执行。
- 工作路径支持绝对路径、`~` / `~/...` 用户目录路径，以及相对当前工作路径的相对路径。操作面板和建群表单都会显示其相对路径基准。
- 电脑端 pi 与飞书端可以同时运行。服务启动时不会补发历史电脑端对话；活动 session 文件变更后会自动同步最新完成的一轮电脑端对话。`lark-agent-os` 自身只允许启动一个实例，避免重复消费飞书事件。
- Agent 收到消息后立即发送带“停止”按钮的处理中卡片，并在处理期间持续更新当前回复；完成、失败或停止后原位更新为无按钮的最终卡片；
- 当前只处理普通文本和 `@bot`。
- state 保存在 `.state/state.json`，session 文件由 pi 自己持久化。

群公告使用国内版新版 Docx API。机器人需要在群内并拥有群公告编辑权限；若群限制只有群主/管理员可编辑，还需要相应的群信息操作权限。
