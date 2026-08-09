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
    const response = await fetch(`${DOMAIN}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json() as any;
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu API ${path}: ${payload.code} ${payload.msg}`);
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
