import { retryOnce } from './utils/retry.js';

const DOMAIN = 'https://open.feishu.cn';

interface TokenResponse { tenant_access_token?: string; }

export class LarkApi {
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly appId: string, private readonly appSecret: string) {}

  async announcement(chatId: string): Promise<{ revision_id: number }> {
    const response = await this.request(`/open-apis/docx/v1/chats/${chatId}/announcement`);
    return response.data as { revision_id: number };
  }

  async announcementBlocks(chatId: string): Promise<any[]> {
    const response = await this.request(`/open-apis/docx/v1/chats/${chatId}/announcement/blocks?page_size=50`);
    return (response.data?.items ?? []) as any[];
  }

  async createAnnouncementTextBlock(chatId: string, parentBlockId: string, revisionId: number, content: string): Promise<void> {
    await this.request(
      `/open-apis/docx/v1/chats/${chatId}/announcement/blocks/${parentBlockId}/children?revision_id=${revisionId}`,
      'POST',
      { children: [{ block_type: 2, text: { elements: [{ text_run: { content } }] } }] },
    );
  }

  async pinAnnouncement(chatId: string): Promise<void> {
    await this.request(
      `/open-apis/im/v1/chats/${chatId}/top_notice/put_top_notice`,
      'POST',
      { chat_top_notice: [{ action_type: '2' }] },
    );
  }

  async updateAnnouncement(chatId: string, revisionId: number, blockId: string, content: string): Promise<number> {
    const response = await this.request(
      `/open-apis/docx/v1/chats/${chatId}/announcement/blocks/batch_update?revision_id=${revisionId}`,
      'PATCH',
      { requests: [{ block_id: blockId, update_text_elements: { elements: [{ text_run: { content } }] } }] },
    );
    return Number(response.data?.revision_id ?? revisionId);
  }

  private async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    // 仅网络层失败 / HTTP 5xx 重试一次；业务错误码（含限流 429、消息体超限 230025 等）不重试
    return retryOnce(
      () => this.requestOnce(path, method, body),
      isRetryableRequestError,
      500,
      (error) => console.debug(`[lark api retry] ${method} ${path}:`, error),
    );
  }

  private async requestOnce(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await fetch(`${DOMAIN}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok && response.status >= 500) {
      // 5xx 先抛出（body 可能非 JSON），走重试；4xx 等继续解析业务错误码（不重试）
      throw new Error(`Feishu API ${path}: HTTP ${response.status} ${response.statusText}`);
    }
    const payload = await response.json() as any;
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu API ${path}: ${payload.code} ${payload.msg}`);
    }
    return payload;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await fetch(`${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json() as TokenResponse & { code?: number; msg?: string; expire?: number };
    if (!response.ok || !payload.tenant_access_token) throw new Error(`Feishu token error: ${payload.code} ${payload.msg}`);
    this.token = payload.tenant_access_token;
    this.tokenExpiresAt = Date.now() + ((payload.expire ?? 7200) - 60) * 1000;
    return this.token;
  }
}

/** 是否可重试：网络层失败（fetch 抛 TypeError）或 HTTP 5xx 服务端错误；业务错误码不重试 */
function isRetryableRequestError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP [5]\d\d/.test(message);
}
