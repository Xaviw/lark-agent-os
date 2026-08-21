# lark-agent-os

飞书（open.feishu.cn）群聊 / 私聊消息交给 pi coding agent 处理的网关：卡片完成会话 / 模型 / 命令 / 项目群操作。

## 会话与对话

**会话（session）**：
pi 的对话会话，落盘为 session JSONL。群 / 私聊 / 话题各自映射到会话文件；电脑端与飞书端共用同一 session 文件。
_Avoid_: 对话、chat

**话题（thread）**：
群内话题窗口，映射到独立会话（懒初始化，命名「话题-MM-DD HH:mm」）。话题对话不写入主会话、不参与电脑端同步、不触发公告。
_Avoid_: 子会话、回复线程

**快速提问（quick ask）**：
一次性、无上下文的 agent 问答，走每群固定的「快速提问」独立会话，不进主对话、不参与同步、不触发公告。
_Avoid_: 智能执行

**同步（session sync）**：
电脑端 → 飞书的单向会话同步（方向不对称；飞书 → 电脑端无推送）。按轮次（turn）推进进度，飞书轮次视为已消费、不发送（防回环）。

## 卡片与命令

**卡片（card）**：
飞书交互卡片（JSON 2.0），是用户在飞书侧的主要交互表面；按钮 / 表单携带操作值触发命令。
_Avoid_: 消息、弹窗

**卡片命令（card command）**：
卡片按钮 / 表单携带的 `cmd` 值（`CardCommand` 联合，定义在 `cards.ts`）。每个命令由**命令注册表**中的一个注册项处理。
_Avoid_: 操作、action

**命令注册表（command registry）**：
`cmd → 命令处理器` 的声明式映射（`card-actions.ts` 的 `REGISTRY`）。注册项声明前置（`requiresBinding` / `requiresSession` / `topicBlocked` / `taskKey`），由分发器统一执行后委托处理器；`Record<CardCommand, CommandEntry>` 标注保证契约完备。

**命令处理器（command handler）**：
注册表中的一项，通过分发器注入的 `CommandContext`（helpers）执行业务，不重复前置样板。

**状态卡（status card）**：
异步操作（压缩 / 重新加载）的卡片链：立即弹「进行中」起始卡，完成后更新为成功 / 失败最终卡。经 `runStatusCardOp` 运行。

## 任务与生命周期

**fire-and-forget 任务**：
卡片回调需 3s 内 ack，重量级链路（建会话 / 建群 / 同步 / 状态卡）后台异步执行、先回 toast。统一由 `fireAndForget` 编排：独占守卫 + `pendingBackground` 登记 + 失败补发消息。
_Avoid_: 后台任务、异步操作

**守卫（in-flight guard）**：
按 `(taskKey, chatId)` 记录进行中的独占操作，重复触发回 busy toast。状态收敛在 `fireAndForget` 内部的 `busyKeys`，taskKey 声明在注册项上。

**挂起消息（pending prompt）**：
用户发消息但未选会话时暂存的上下文，选中 / 新建会话后一次性续跑（消费即删，超 30 分钟不续跑）。

**项目群（project group）**：
按工作路径创建 / 绑定的飞书群，群级操作（命令 / 会话 / 同步）以群为单位串行。

**群绑定（chat binding）**：
`state.json` 中每群的状态：cwd / 活动会话 / 同步进度 / 话题会话 / 快速提问会话等。
