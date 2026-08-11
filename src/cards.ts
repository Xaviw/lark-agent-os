import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import type { PiModelOption } from './pi.js';
import { escapeCommand, formatTimestamp, markdownCodeBlock } from './utils/format.js';

const SESSION_TITLE_MAX_LENGTH = 48;
const CARD_MARKDOWN_LIMIT = 6_000;
const SESSION_PICKER_LIMIT = 10;

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

export function sessionPickerCard(cwd: string, sessions: SessionInfo[], nonce: string): object {
  const limited = sessions.slice(0, SESSION_PICKER_LIMIT);
  const overflowHint = sessions.length > SESSION_PICKER_LIMIT ? `\n\n已显示前 ${SESSION_PICKER_LIMIT} 个（共 ${sessions.length} 个），其余可用「新建会话」或直接发消息让机器人处理。` : '';
  return {
    schema: '2.0',
    config: { summary: { content: '恢复 pi session' } },
    body: {
      elements: [
        { tag: 'markdown', content: `**恢复 Session**\n\n项目：\`${cwd}\`\n\n请选择要继续的历史 session。${overflowHint}` },
        ...limited.map((session) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: `${sessionDisplayName(session)} · ${session.messageCount} 条` },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { cmd: 'session.use', nonce, sessionFile: session.path } }],
        })),
      ],
    },
  };
}

export function createSessionFormCard(nonce: string, title = '新建 Session'): object {
  return {
    schema: '2.0',
    config: { summary: { content: title } },
    body: {
      elements: [
        {
          tag: 'form',
          name: 'session_create_form',
          elements: [
            { tag: 'input', name: 'name', label: { tag: 'plain_text', content: 'Session 名称' }, placeholder: { tag: 'plain_text', content: '例如：修复登录超时' }, required: true },
            { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '新建 Session' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'session.create.submit', nonce } }] },
          ],
        },
      ],
    },
  };
}

export function syncFormCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '同步 Session' } },
    body: { elements: [{ tag: 'form', name: 'session_sync_form', elements: [
      { tag: 'input', name: 'count', label: { tag: 'plain_text', content: '同步最新轮数（可选）' }, placeholder: { tag: 'plain_text', content: '留空同步全部新消息' } },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '同步' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'session.sync.submit' } }] },
    ] }] },
  };
}

export function renameSessionFormCard(nonce: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '重命名 Session' } },
    body: { elements: [{ tag: 'form', name: 'session_name_form', elements: [
      { tag: 'input', name: 'name', label: { tag: 'plain_text', content: 'Session 名称' }, required: true },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '保存' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'session.rename.submit', nonce } }] },
    ] }] },
  };
}

export function modelPickerCard(models: PiModelOption[], nonce: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '选择 model' } },
    body: { elements: [
      { tag: 'markdown', content: '**选择 Provider / Model**' },
      ...models.map((model) => ({
        tag: 'button', text: { tag: 'plain_text', content: `${model.provider} / ${model.name}` }, type: 'primary',
        behaviors: [{ type: 'callback', value: { cmd: 'model.select', nonce, provider: model.provider, modelId: model.id } }],
      })),
    ] },
  };
}

export function thinkingLevelPickerCard(thinkingLevels: string[], nonce: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '选择思考强度' } },
    body: { elements: [
      { tag: 'markdown', content: '**选择当前 model 的思考强度**' },
      ...thinkingLevels.map((thinkingLevel) => ({
        tag: 'button', text: { tag: 'plain_text', content: thinkingLevel }, type: 'primary',
        behaviors: [{ type: 'callback', value: { cmd: 'thinkingLevel.select', nonce, thinkingLevel } }],
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
    { tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'danger', behaviors: [{ type: 'callback', value: { cmd: 'agent.stop', taskId } }] },
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
  const sessionStatus = mode === 'topic' ? '' : (hasSession ? '' : '\n\n尚未选择 Session，请使用「新建会话」或「切换会话」。');
  const button = (label: string, cmd: string) => ({ tag: 'button', text: { tag: 'plain_text', content: label }, type: 'primary', behaviors: [{ type: 'callback', value: { cmd } }] });
  // 话题模式去掉：新建会话 / 切换会话 / 绑定项目 / 同步消息（话题 = 独立 session，无手动会话管理；话题 session 不参与同步）
  const sessionRowButtons = mode === 'topic'
    ? [button('压缩会话', 'session.compact')]
    : [button('新建会话', 'session.new.form'), button('压缩会话', 'session.compact'), button('切换会话', 'session.resume.form'), button('同步消息', 'session.sync.form')];
  const projectRowButtons = mode === 'topic'
    ? [button('执行命令', 'command.form'), button('创建项目群', 'project.create.form'), button('后台任务', 'bgTask.form')]
    : [button('执行命令', 'command.form'), button('创建项目群', 'project.create.form'), button('绑定项目', 'project.bind.form'), button('后台任务', 'bgTask.form')];
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

export function commandFormCard(cwd: string): object {
  return { schema: '2.0', config: { summary: { content: '执行命令' } }, body: { elements: [
    { tag: 'markdown', content: `**执行命令**\n\n工作路径：\`${cwd}\`` },
    { tag: 'form', name: 'command_form', elements: [
      { tag: 'input', name: 'command', label: { tag: 'plain_text', content: '命令' }, placeholder: { tag: 'plain_text', content: 'pnpm test' }, required: true },
      { tag: 'input', name: 'timeoutSeconds', label: { tag: 'plain_text', content: '超时（秒，可选）' }, placeholder: { tag: 'plain_text', content: '默认 10 秒，可修改或清空（清空则不自动停止）' }, default_value: '10' },
      { tag: 'checker', name: 'isBackground', text: { tag: 'plain_text', content: '常驻任务（忽略超时，后台持续运行）' }, checked: false },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '执行' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'command.submit' } }] },
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
    { tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'danger', behaviors: [{ type: 'callback', value: { cmd: 'command.stop', taskId } }] },
  ] } };
}

export function commandFinalCard(title: string, output: string, elapsed?: string): object {
  return { schema: '2.0', config: { summary: { content: title } }, body: { elements: [{ tag: 'markdown', content: limitedMarkdown(`**${title}**\n\n${elapsed ? `耗时：${elapsed}\n\n` : ''}${output}`) }] } };
}

export function createProjectFormCard(baseCwd: string): object {
  return { schema: '2.0', config: { summary: { content: '创建项目群' } }, body: { elements: [
    { tag: 'markdown', content: `**创建项目群**\n\n相对路径将以当前工作路径 \`${baseCwd}\` 为基准；支持绝对路径和 \`~/...\`。` },
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
    return { tag: 'button', text: { tag: 'plain_text', content: `停止：${label}` }, type: 'danger', behaviors: [{ type: 'callback', value: { cmd: 'bgTask.stop', taskId: task.id } }] };
  });
  return { schema: '2.0', config: { summary: { content: '后台任务' } }, body: { elements: [header, ...(stopButtons.length > 0 ? [{ tag: 'hr' }, ...stopButtons] : [])] } };
}

export function bindProjectFormCard(baseCwd: string, bound: boolean): object {
  const title = bound ? '修改绑定' : '绑定项目';
  return { schema: '2.0', config: { summary: { content: title } }, body: { elements: [
    { tag: 'markdown', content: `**${title}**\n\n将当前群绑定到工作路径。相对路径将以当前工作路径 \`${baseCwd}\` 为基准；支持绝对路径和 \`~/...\`。` },
    { tag: 'form', name: 'project_bind_form', elements: [
      { tag: 'input', name: 'cwd', label: { tag: 'plain_text', content: '工作路径' }, placeholder: { tag: 'plain_text', content: '~/Codes/my-project 或 ../my-project' }, required: true },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: bound ? '保存绑定' : '绑定项目' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'project.bind.submit', baseCwd } }] },
    ] },
  ] } };
}
