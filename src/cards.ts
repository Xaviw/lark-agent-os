import type { SessionInfo } from '@earendil-works/pi-coding-agent';
import type { PiModelOption } from './pi.js';

const SESSION_TITLE_MAX_LENGTH = 48;
const CARD_MARKDOWN_LIMIT = 6_000;

function limitedMarkdown(content: string): string {
  if (content.length <= CARD_MARKDOWN_LIMIT) return content;
  const marker = '\n\n（内容已截断）\n\n';
  const remaining = CARD_MARKDOWN_LIMIT - marker.length;
  const head = Math.floor(remaining / 3);
  return `${content.slice(0, head)}${marker}${content.slice(-(remaining - head))}`;
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
  return {
    schema: '2.0',
    config: { summary: { content: '恢复 pi session' } },
    body: {
      elements: [
        { tag: 'markdown', content: `**恢复 Session**\n\n项目：\`${cwd}\`\n\n请选择要继续的历史 session。` },
        ...sessions.map((session) => ({
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

export function effortPickerCard(efforts: string[], nonce: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '选择思考强度' } },
    body: { elements: [
      { tag: 'markdown', content: '**选择当前 model 的思考强度**' },
      ...efforts.map((effort) => ({
        tag: 'button', text: { tag: 'plain_text', content: effort }, type: 'primary',
        behaviors: [{ type: 'callback', value: { cmd: 'effort.select', nonce, effort } }],
      })),
    ] },
  };
}

export function statusCard(text: string): object {
  return { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: text }] };
}

export function agentQueuedCard(taskId: string, prompt: string): object {
  return { schema: '2.0', config: { summary: { content: 'Agent 等待处理' } }, body: { elements: [
    { tag: 'markdown', content: limitedMarkdown(`**Agent 等待处理**\n\n请求：${prompt}\n\n状态：排队中`) },
    { tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'danger', behaviors: [{ type: 'callback', value: { cmd: 'agent.stop', taskId } }] },
  ] } };
}

export function agentRunningCard(taskId: string, prompt: string, output?: string): object {
  const response = output ? `\n\n${output}` : '';
  return { schema: '2.0', config: { summary: { content: 'Agent 正在处理' } }, body: { elements: [
    { tag: 'markdown', content: limitedMarkdown(`**Agent 正在处理**\n\n请求：${prompt}\n\n状态：执行中${response}`) },
    { tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'danger', behaviors: [{ type: 'callback', value: { cmd: 'agent.stop', taskId } }] },
  ] } };
}

export function agentFinalCard(title: string, content: string, status?: string, elapsed?: string): object {
  const titleWithElapsed = elapsed ? `${title} - 耗时：${elapsed}` : title;
  return { schema: '2.0', config: { summary: { content: titleWithElapsed } }, body: { elements: [{ tag: 'markdown', content: limitedMarkdown(`**${titleWithElapsed}**\n\n${content}${status ? `\n\n${status}` : ''}`) }] } };
}

export function helpCard(cwd: string, bound: boolean, hasSession: boolean): object {
  const bindingStatus = bound ? '' : '\n\n此群尚未绑定项目。可创建新的项目群。';
  const sessionStatus = hasSession ? '' : '\n\n尚未选择 Session，请使用 new 或 resume。';
  const button = (label: string, cmd: string, type: 'primary' | 'default' = 'default') => ({ tag: 'button', text: { tag: 'plain_text', content: label }, type, behaviors: [{ type: 'callback', value: { cmd } }] });
  return {
    schema: '2.0', config: { summary: { content: 'lark-agent-os 操作面板' } }, body: { elements: [
      { tag: 'markdown', content: `**当前工作路径**\n\`${cwd}\`${bindingStatus}${sessionStatus}` }, { tag: 'hr' },
      { tag: 'column_set', flex_mode: 'flow', columns: [
        { tag: 'column', width: 'auto', elements: [button('model', 'model.form', 'primary')] },
        { tag: 'column', width: 'auto', elements: [button('effort', 'effort.form', 'primary')] },
        { tag: 'column', width: 'auto', elements: [button('name', 'session.rename.form')] },
      ] },
      { tag: 'column_set', flex_mode: 'flow', columns: [
        { tag: 'column', width: 'auto', elements: [button('new', 'session.new.form', 'primary')] },
        { tag: 'column', width: 'auto', elements: [button('compact', 'session.compact')] },
        { tag: 'column', width: 'auto', elements: [button('resume', 'session.resume.form', 'primary')] },
        { tag: 'column', width: 'auto', elements: [button('sync', 'session.sync.form', 'primary')] },
      ] }, { tag: 'hr' },
      { tag: 'column_set', flex_mode: 'flow', columns: [
        { tag: 'column', width: 'auto', elements: [button('执行命令', 'command.form')] },
        { tag: 'column', width: 'auto', elements: [button('创建项目群', 'project.create.form')] },
      ] },
    ] },
  };
}

export function commandFormCard(cwd: string): object {
  return { schema: '2.0', config: { summary: { content: '执行命令' } }, body: { elements: [
    { tag: 'markdown', content: `**执行命令**\n\n工作路径：\`${cwd}\`` },
    { tag: 'form', name: 'command_form', elements: [
      { tag: 'input', name: 'command', label: { tag: 'plain_text', content: '命令' }, placeholder: { tag: 'plain_text', content: 'pnpm test' }, required: true },
      { tag: 'input', name: 'timeoutSeconds', label: { tag: 'plain_text', content: '超时（秒，可选）' }, placeholder: { tag: 'plain_text', content: '留空则不自动停止' } },
      { tag: 'button', name: 'submit', text: { tag: 'plain_text', content: '执行' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'command.submit' } }] },
    ] },
  ] } };
}

export function commandStartingCard(command: string, cwd: string, timeoutSeconds?: number): object {
  const timeout = timeoutSeconds ? `\n超时：${timeoutSeconds} 秒` : '';
  return { schema: '2.0', config: { summary: { content: '命令正在启动' } }, body: { elements: [{ tag: 'markdown', content: limitedMarkdown(`**命令正在启动**\n\n\`$ ${command}\`\n工作路径：\`${cwd}\`${timeout}`) }] } };
}

export function commandRunningCard(taskId: string, command: string, cwd: string, timeoutSeconds?: number, output?: string): object {
  const timeout = timeoutSeconds ? `\n超时：${timeoutSeconds} 秒` : '';
  const latestOutput = output ? `\n\n${output.slice(-8_000)}` : '';
  return { schema: '2.0', config: { summary: { content: '命令正在执行' } }, body: { elements: [
    { tag: 'markdown', content: limitedMarkdown(`**命令正在执行**\n\n\`$ ${command}\`\n工作路径：\`${cwd}\`\n状态：执行中${timeout}${latestOutput}`) },
    { tag: 'column_set', flex_mode: 'flow', columns: [
      { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '查看输出' }, behaviors: [{ type: 'callback', value: { cmd: 'command.output', taskId } }] }] },
      { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '停止' }, type: 'danger', behaviors: [{ type: 'callback', value: { cmd: 'command.stop', taskId } }] }] },
    ] },
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
