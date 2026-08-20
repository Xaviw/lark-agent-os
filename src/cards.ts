import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import type { PiModelOption } from './pi.js';
import { COMMAND_FOLD_PREVIEW_LIMIT, COMMAND_FOLD_THRESHOLD } from './config.js';
import { escapeCommand, formatTimestamp, markdownCodeBlock } from './utils/format.js';

const SESSION_TITLE_MAX_LENGTH = 48;
const CARD_MARKDOWN_LIMIT = 6_000;
const SESSION_PICKER_LIMIT = 10;
/** 压缩会话的二次确认文案（help 群模式 / 话题模式共用，改文案只需改此处） */
const COMPACT_CONFIRM = { title: '确认压缩会话？', text: '压缩将丢弃较早的对话上下文，且会中止进行中的任务，不可撤销。确定继续吗？' };

/** 危险操作按钮的二次确认弹窗（纯客户端行为，确认后照常回调；title 必填） */
function confirmDialog(title: string, text: string): object {
  return { title: { tag: 'plain_text', content: title }, text: { tag: 'plain_text', content: text } };
}

function limitedMarkdown(content: string): string {
  if (content.length <= CARD_MARKDOWN_LIMIT) return content;
  const marker = '\n\n（内容已截断）\n\n';
  const remaining = CARD_MARKDOWN_LIMIT - marker.length;
  const head = Math.floor(remaining / 3);
  // 按码点（Array.from）切分，避免切断多字节字符（emoji 等）产生乱码
  const chars = Array.from(content);
  return `${chars.slice(0, head).join('')}${marker}${chars.slice(chars.length - (remaining - head)).join('')}`;
}

export function sessionDisplayName(session: Pick<SessionInfo, 'name' | 'firstMessage'>): string {
  const name = session.name?.trim();
  if (name) return name;
  const firstMessage = session.firstMessage.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!firstMessage || firstMessage === '(no messages)') return '未命名会话';
  const characters = Array.from(firstMessage);
  return characters.length > SESSION_TITLE_MAX_LENGTH
    ? `${characters.slice(0, SESSION_TITLE_MAX_LENGTH).join('')}…`
    : firstMessage;
}

export function sessionPickerCard(cwd: string, sessions: SessionInfo[]): object {
  const limited = sessions.slice(0, SESSION_PICKER_LIMIT);
  const overflowHint = sessions.length > SESSION_PICKER_LIMIT ? `\n\n已显示前 ${SESSION_PICKER_LIMIT} 个（共 ${sessions.length} 个），其余可用「新建会话」或直接发消息让机器人处理。` : '';
  return {
    schema: '2.0',
    config: { summary: { content: '切换会话' } },
    body: {
      elements: [
        { tag: 'markdown', content: `**切换会话**\n\n项目：\`${cwd}\`\n\n请选择要切换的历史会话。${overflowHint}` },
        ...limited.map((session) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: `${sessionDisplayName(session)} · ${session.messageCount} 条` },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { cmd: 'session.use', sessionFile: session.path } }],
        })),
      ],
    },
  };
}

export function createSessionFormCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '新建会话' } },
    body: {
      elements: [
        {
          tag: 'form',
          name: 'session_create_form',
          elements: [
            { tag: 'input', name: 'name', label: { tag: 'plain_text', content: '会话名称' }, placeholder: { tag: 'plain_text', content: '例如：修复登录超时' }, required: true },
            { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '新建会话' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'session.create.submit' } }] },
          ],
        },
      ],
    },
  };
}

export function syncFormCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '同步消息' } },
    body: { elements: [{ tag: 'form', name: 'session_sync_form', elements: [
      { tag: 'input', name: 'count', label: { tag: 'plain_text', content: '同步最新轮数（可选）' }, placeholder: { tag: 'plain_text', content: '留空同步全部新消息' } },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '同步' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'session.sync.submit' } }] },
    ] }] },
  };
}

export function renameSessionFormCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '重命名会话' } },
    body: { elements: [{ tag: 'form', name: 'session_name_form', elements: [
      { tag: 'input', name: 'name', label: { tag: 'plain_text', content: '会话名称' }, required: true },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '保存' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'session.rename.submit' } }] },
    ] }] },
  };
}

export function modelPickerCard(models: PiModelOption[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: '选择 model' } },
    body: { elements: [
      { tag: 'markdown', content: '**选择 Provider / Model**' },
      ...models.map((model) => ({
        tag: 'button', text: { tag: 'plain_text', content: `${model.provider} / ${model.name}` }, type: 'primary',
        behaviors: [{ type: 'callback', value: { cmd: 'model.select', provider: model.provider, modelId: model.id } }],
      })),
    ] },
  };
}

export function thinkingLevelPickerCard(thinkingLevels: string[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: '选择思考强度' } },
    body: { elements: [
      { tag: 'markdown', content: '**选择当前 model 的思考强度**' },
      ...thinkingLevels.map((thinkingLevel) => ({
        tag: 'button', text: { tag: 'plain_text', content: thinkingLevel }, type: 'primary',
        behaviors: [{ type: 'callback', value: { cmd: 'thinkingLevel.select', thinkingLevel } }],
      })),
    ] },
  };
}

export function agentQueuedCard(taskId: string, prompt: string): object {
  return { schema: '2.0', config: { summary: { content: 'Agent 等待处理' } }, body: { elements: [
    { tag: 'markdown', content: limitedMarkdown(`**Agent 等待处理**\n\n请求：${escapeCommand(prompt)}\n\n状态：排队中`) },
    { tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'danger', behaviors: [{ type: 'callback', value: { cmd: 'agent.stop', taskId } }] },
  ] } };
}

export function agentRunningCard(taskId: string, prompt: string, output?: string): object {
  const response = output ? `\n\n${output}` : '';
  return { schema: '2.0', config: { summary: { content: 'Agent 正在处理' } }, body: { elements: [
    { tag: 'markdown', content: limitedMarkdown(`**Agent 正在处理**\n\n请求：${escapeCommand(prompt)}\n\n状态：执行中${response}`) },
    { tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'danger',
      confirm: confirmDialog('确认停止 Agent？', '将中止当前处理，已生成的内容可能不完整。确定停止吗？'),
      behaviors: [{ type: 'callback', value: { cmd: 'agent.stop', taskId } }] },
  ] } };
}

export function agentFinalCard(title: string, content: string, status?: string, elapsed?: string): object {
  const titleWithElapsed = elapsed ? `${title} - 耗时：${elapsed}` : title;
  return { schema: '2.0', config: { summary: { content: titleWithElapsed } }, body: { elements: [{ tag: 'markdown', content: limitedMarkdown(`**${titleWithElapsed}**\n\n${content}${status ? `\n\n${status}` : ''}`) }] } };
}

export function helpCard(cwd: string, bound: boolean, hasSession: boolean, mode: 'group' | 'topic' = 'group'): object {
  // 话题模式：话题自动绑定独立 session（懒初始化），不提供会话管理/同步入口，工作路径固定不可修改；未绑定群仍需提示先绑定
  const bindingStatus = mode === 'topic'
    ? (bound ? '\n\n话题固定使用该工作路径，不支持修改。' : '\n\n此群尚未绑定项目，请先绑定。\n\n话题固定使用该工作路径，不支持修改。')
    : bound ? '' : '\n\n此群尚未绑定项目，请先绑定。';
  const sessionStatus = mode === 'topic' ? '' : (hasSession ? '' : '\n\n尚未选择会话，请使用「新建会话」或「切换会话」。');
  const button = (label: string, cmd: string, confirm?: { title: string; text: string }) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: 'primary',
    ...(confirm ? { confirm: confirmDialog(confirm.title, confirm.text) } : {}),
    behaviors: [{ type: 'callback', value: { cmd } }],
  });
  // 话题模式去掉：新建会话 / 切换会话 / 绑定项目 / 同步消息（话题 = 独立 session，无手动会话管理；话题 session 不参与同步）
  const sessionRowButtons = mode === 'topic'
    ? [button('压缩会话', 'session.compact', COMPACT_CONFIRM)]
    : [button('新建会话', 'session.new.form'), button('压缩会话', 'session.compact', COMPACT_CONFIRM), button('切换会话', 'session.resume.form'), button('同步消息', 'session.sync.form')];
  const projectRowButtons = mode === 'topic'
    ? [button('执行命令', 'command.form'), button('快速提问', 'quickAsk.form'), button('创建项目群', 'project.create.form'), button('后台任务', 'bgTask.form')]
    : [button('执行命令', 'command.form'), button('快速提问', 'quickAsk.form'), button('创建项目群', 'project.create.form'), button('绑定项目', 'project.bind.form'), button('后台任务', 'bgTask.form')];
  return {
    schema: '2.0', config: { summary: { content: 'lark-agent-os 操作面板' } }, body: { elements: [
      { tag: 'markdown', content: `**当前工作路径**\n\`${cwd}\`${bindingStatus}${sessionStatus}` }, { tag: 'hr' },
      { tag: 'column_set', flex_mode: 'flow', columns: [
        { tag: 'column', width: 'auto', elements: [button('切换模型', 'model.form')] },
        { tag: 'column', width: 'auto', elements: [button('切换思考强度', 'thinkingLevel.form')] },
        { tag: 'column', width: 'auto', elements: [button('重命名会话', 'session.rename.form')] },
      ] },
      { tag: 'column_set', flex_mode: 'flow', columns: sessionRowButtons.map((element) => ({ tag: 'column', width: 'auto', elements: [element] })) }, { tag: 'hr' },
      { tag: 'column_set', flex_mode: 'flow', columns: projectRowButtons.map((element) => ({ tag: 'column', width: 'auto', elements: [element] })) },
    ] },
  };
}

export function botWelcomeCard(cwd: string): object {
  return { schema: '2.0', config: { summary: { content: '机器人已加入群聊' } }, body: { elements: [
    { tag: 'markdown', content: `**机器人已就绪**\n\n已自动绑定工作路径：\`${cwd}\`\n\n在群里 \`@机器人\` 即可开始对话；\`/help\` 或下方按钮打开操作面板（新建/切换会话、执行命令、修改绑定等）。` },
    { tag: 'button', text: { tag: 'plain_text', content: '打开操作面板' }, type: 'primary', behaviors: [{ type: 'callback', value: { cmd: 'help' } }] },
  ] } };
}

export function commandFormCard(cwd: string, isWindows: boolean): object {
  // Windows 提示：cmd 语法与跨盘 cd 规则（避开 ls 不可用 / 路径写法等常见问题）；平台由调用方注入以保持纯函数可测
  const platformHint = isWindows
    ? '\n\n当前为 Windows 环境，请使用 cmd 语法，如 `cd /d d:\\company && dir`（跨盘需 `/d`；`ls` 请用 `dir`；`/d:/` 风格仅在 Git Bash 内有效）。'
    : '';
  return { schema: '2.0', config: { summary: { content: '执行命令' } }, body: { elements: [
    { tag: 'markdown', content: `**执行命令**\n\n工作路径：\`${cwd}\`${platformHint}` },
    { tag: 'form', name: 'command_form', elements: [
      { tag: 'input', name: 'command', label: { tag: 'plain_text', content: '命令' }, placeholder: { tag: 'plain_text', content: 'pnpm test' } },
      { tag: 'input', name: 'timeoutSeconds', label: { tag: 'plain_text', content: '超时（秒，可选）' }, placeholder: { tag: 'plain_text', content: '默认 10 秒，可修改或清空（清空则不自动停止）' }, default_value: '10' },
      { tag: 'checker', name: 'isBackground', text: { tag: 'plain_text', content: '常驻任务（忽略超时，后台持续运行）' }, checked: false },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '执行' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'command.submit' } }] },
    ] },
  ] } };
}

export function askFormCard(cwd: string): object {
  return { schema: '2.0', config: { summary: { content: '快速提问' } }, body: { elements: [
    { tag: 'markdown', content: `**快速提问**\n\n工作路径：\`${cwd}\`\n\n无上下文关联的一次性提问，不会写入当前会话、不影响对话上下文。` },
    { tag: 'form', name: 'quick_ask_form', elements: [
      { tag: 'input', name: 'prompt', label: { tag: 'plain_text', content: '问题' }, placeholder: { tag: 'plain_text', content: '例如：这个项目如何启动？' }, required: true },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '提问' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'quickAsk.submit' } }] },
    ] },
  ] } };
}

export function commandStartingCard(command: string, cwd: string, timeoutSeconds?: number): object {
  const timeout = timeoutSeconds ? `\n超时：${timeoutSeconds} 秒` : '';
  return { schema: '2.0', config: { summary: { content: '命令正在启动' } }, body: { elements: [{ tag: 'markdown', content: limitedMarkdown(`**命令正在启动**\n\n\`$ ${escapeCommand(command)}\`\n工作路径：\`${cwd}\`${timeout}`) }] } };
}

export function commandRunningCard(taskId: string, command: string, cwd: string, timeoutSeconds?: number, output?: string): object {
  const timeout = timeoutSeconds ? `\n超时：${timeoutSeconds} 秒` : '';
  const latestOutput = output ? `\n\n${markdownCodeBlock(output.slice(-8_000))}` : '';
  return { schema: '2.0', config: { summary: { content: '命令正在执行' } }, body: { elements: [
    { tag: 'markdown', content: limitedMarkdown(`**命令正在执行**\n\n\`$ ${escapeCommand(command)}\`\n工作路径：\`${cwd}\`\n状态：执行中${timeout}${latestOutput}`) },
    { tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'danger',
      confirm: confirmDialog('确认停止命令？', '将终止正在执行的命令进程。确定停止吗？'),
      behaviors: [{ type: 'callback', value: { cmd: 'command.stop', taskId } }] },
  ] } };
}

export function commandFinalCard(title: string, output: string, elapsed?: string): object {
  const elapsedLine = elapsed ? `耗时：${elapsed}\n\n` : '';
  // 按码点计数/切分（emoji 代理对算 1 个字符），与 preview 切分单位一致，避免阈值判定与截断口径不一
  const outputChars = Array.from(output);
  if (outputChars.length <= COMMAND_FOLD_THRESHOLD) {
    return { schema: '2.0', config: { summary: { content: title } }, body: { elements: [{ tag: 'markdown', content: limitedMarkdown(`**${title}**\n\n${elapsedLine}${output}`) }] } };
  }
  // 超长输出：默认只显示首屏，完整输出收进默认收起的 collapsible_panel，展开可见全部
  const preview = outputChars.slice(0, COMMAND_FOLD_PREVIEW_LIMIT).join('');
  return { schema: '2.0', config: { summary: { content: title } }, body: { elements: [
    { tag: 'markdown', content: `**${title}**\n\n${elapsedLine}${closeCodeFence(preview, output)}\n\n（输出较长，完整内容见下方「查看输出」）` },
    { tag: 'collapsible_panel', expanded: false, header: { title: { tag: 'plain_text', content: `查看输出（${outputChars.length} 字符）` } }, elements: [{ tag: 'markdown', content: limitedMarkdown(output) }] },
  ] } };
}

/**
 * 给 output 的前缀片段补一个闭合的 code fence，使其作为独立 markdown 片段可安全渲染。
 * 片段可能切在动态 fence（长度 = 内容最长反引号串 + 1）内部，故闭合 fence 长度取全量
 * output 最长反引号串 + 1（必 ≥ 前缀内任意反引号串，保证闭合）。
 */
export function closeCodeFence(partial: string, full: string): string {
  let longest = 0;
  for (const match of full.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return `${partial}\n${'`'.repeat(Math.max(3, longest + 1))}`;
}

export function createProjectFormCard(baseCwd: string): object {
  return { schema: '2.0', config: { summary: { content: '创建项目群' } }, body: { elements: [
    { tag: 'markdown', content: `**创建项目群**\n\n相对路径将以当前工作路径 \`${baseCwd}\` 为基准；支持绝对路径和 \`~/...\`；工作路径必须已存在且为目录。` },
    { tag: 'form', name: 'project_create_form', elements: [
      { tag: 'input', name: 'name', label: { tag: 'plain_text', content: '群名称' }, placeholder: { tag: 'plain_text', content: 'Pi · 项目名称' } },
      { tag: 'input', name: 'cwd', label: { tag: 'plain_text', content: '工作路径' }, placeholder: { tag: 'plain_text', content: '~/Codes/my-project 或 ../my-project' }, required: true },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '创建项目群' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'project.create.submit', baseCwd } }] },
    ] },
  ] } };
}

export function bgTaskListCard(tasks: Array<{ id: string; command: string; startedAt: number }>): object {
  const header = tasks.length === 0
    ? { tag: 'markdown', content: '**后台任务**\n\n当前没有后台任务。' }
    : { tag: 'markdown', content: `**后台任务（${tasks.length}）**\n\n${tasks.map((task) => `\`$ ${escapeCommand(task.command)}\`\n启动时间：${formatTimestamp(task.startedAt)}`).join('\n\n')}` };
  const stopButtons = tasks.map((task) => {
    const label = task.command.length > 16 ? `${task.command.slice(0, 16)}…` : task.command;
    return { tag: 'button', text: { tag: 'plain_text', content: `停止：${label}` }, type: 'danger',
      confirm: confirmDialog('确认停止任务？', '该后台任务将立即终止，无法恢复。确定停止吗？'),
      behaviors: [{ type: 'callback', value: { cmd: 'bgTask.stop', taskId: task.id } }] };
  });
  return { schema: '2.0', config: { summary: { content: '后台任务' } }, body: { elements: [header, ...(stopButtons.length > 0 ? [{ tag: 'hr' }, ...stopButtons] : [])] } };
}

export function bindProjectFormCard(baseCwd: string, bound: boolean): object {
  const title = bound ? '修改绑定' : '绑定项目';
  return { schema: '2.0', config: { summary: { content: title } }, body: { elements: [
    { tag: 'markdown', content: `**${title}**\n\n将当前群绑定到工作路径。相对路径将以当前工作路径 \`${baseCwd}\` 为基准；支持绝对路径和 \`~/...\`；工作路径必须已存在且为目录。` },
    { tag: 'form', name: 'project_bind_form', elements: [
      { tag: 'input', name: 'cwd', label: { tag: 'plain_text', content: '工作路径' }, placeholder: { tag: 'plain_text', content: '~/Codes/my-project 或 ../my-project' }, required: true },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: bound ? '保存绑定' : '绑定项目' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'project.bind.submit', baseCwd } }] },
    ] },
  ] } };
}
