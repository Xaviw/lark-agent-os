# Handoff：入站富媒体处理（新需求，待讨论）

> 状态：**待讨论**（未进入实施）。本文件用于后续讨论「飞书入站富媒体消息的处理策略」。
> 生成日期：2026-08-10（随 2026-08 审查轮次归档）

---

## 1. 问题概述

PRD 2.1 触发规则声明「仅处理普通文本，不支持富媒体」，但当前代码**未按消息类型过滤**：
用户发送图片 / 文件 / 视频 / 贴纸 / 投票等富媒体消息时，会被 normalize 成文本占位进入 agent 流程。

这是 PRD 与代码事实的偏差，属于新需求（需讨论方案后实施）。

## 2. 已确认的事实（证据链）

### 2.1 入站方向：富媒体确实会进 agent

`@larksuite/channel` 的 normalize 对非 text 消息输出文本占位（`dist/index.mjs` converters）：

| 飞书消息类型 | normalize 后的 `content` |
| --- | --- |
| `image` | `![image](<image_key>)` |
| `file` | `<file key="..." name="..."/>` |
| `audio` / `video` / `media` | 对应占位标签 |
| `sticker` | 占位 |
| `vote` | `<vote>\n...\n</vote>`（含选项文本） |
| `merge_forward` / `share_chat` 等 | 占位 |
| 未知类型 | `[unsupported message]`（或 raw 中的 `text` 字段） |

`handleMessage` 只取 `message.content.trim()`，从不检查 `message.rawContentType`（类型定义见 `node_modules/@larksuite/channel/dist/index.d.mts` L118 `rawContentType: string`）→ 占位文本直接作为 prompt 进入 `runPrompt` → agent。

已核实：`rawContentType = msg.message_type`（normalize 原样透传），`NormalizedMessage` 无 `isText` 之类便捷字段。

### 2.2 出站方向：pi 回复不可能出现富媒体（无需处理）

- `AssistantMessage.content: (TextContent | ThinkingContent | ToolCall)[]`——无 `ImageContent`（`@earendil-works/pi-ai` `dist/types.d.ts` L295）；
- `AssistantMessageEvent` 流式事件无 image 类型（只有 `text_*` / `thinking_*` / `toolcall_*`）；
- 本项目 `pi.ts` 只订阅 `text_delta`，answer 为纯文本；
- 变体：回复文本可能内嵌 `![image](url)` markdown 链接——飞书卡片 markdown 组件不渲染图片，显示为链接文本，非富媒体消息。

### 2.3 即使放行图片，也不会真正传图

`runPrompt` 只调 `session.prompt(text)`，不传 `images` 参数（pi SDK 支持 `prompt(text, { images })`，`AgentSession.prompt` 的 `options.images`）→ 图片只以占位文本进模型。若未来要支持图片理解，是另一个独立需求。

## 3. 相关代码位置

| 位置 | 说明 |
| --- | --- |
| `src/lark/messages.ts` `handleMessage` | 消息入口：`const text = message.content.trim()` 后直接分发；过滤应加在 `allowed()` 之后、`/help` 判断之前 |
| `src/lark/messages.ts` `allowed()` | 已处理「机器人自身消息不处理」 |
| `src/agent/prompt.ts` `runPrompt` | 进入 agent 流程（含 `inFlightFeishuRun` 设置） |
| `node_modules/@larksuite/channel/dist/index.mjs` normalize/converters | 占位文本转换逻辑（只读参考） |
| `node_modules/@larksuite/channel/dist/index.d.mts` `NormalizedMessage` | `rawContentType` / `resources` / `mentions` 字段 |
| PRD 2.1 触发规则 | 「仅处理普通文本，不支持富媒体」（现状未落实） |

## 4. 待讨论的决策点

1. **过滤时机与范围**：
   - 只允许 `rawContentType === 'text'`？（`post` 富文本 / `interactive` 卡片消息也拦掉还是按文本处理？——`post` 会被 normalize 成 md 文本，是否算「普通文本」需定义）
   - 群聊 / 私聊是否同一策略（私聊目前也无过滤）。
2. **被过滤后的反馈**：
   - 静默忽略（最简）；
   - 回一条提示（如「暂不支持图片消息，请使用文本描述」）；
   - 仅对「文本中含 `@bot` 的富媒体」回提示，其余静默。
3. **`resources` 字段**：被过滤消息的 `resources`（图片/文件 key）是否可能用于未来扩展（如图片理解、文件下载）——决定过滤是「丢弃」还是「预留」。
4. **白名单 vs 黑名单**：按「仅 text」白名单（未来加类型要改代码）还是「按已知富媒体类型黑名单」（兼容未来新消息类型）。
5. **PRD 同步**：确认策略后需在 PRD 2.1 补充富媒体处理的具体行为描述。

## 5. 备注

- 本问题在 2026-08 审查轮次中被降级为可议项，现转正为新需求讨论；
- 与「`/` 开头非 help 命令回提示」的现有策略同属「入站消息分类」逻辑，实施时可在 `messages.ts` 统一组织；
- 若决定「回提示」，注意 bot 自身消息已由 `allowed()` 排除，不会因过滤产生自触发。
