export interface SessionSyncState {
  sessionFile: string;
  autoBaselineEntryId?: string;
  lastSyncedEntryId?: string;
  lastLarkMessageId?: string;
}

export interface ChatBinding {
  cwd: string;
  chatType?: 'group' | 'p2p';
  activeSessionFile?: string;
  feishuOriginEntryIds?: string[];
  sessionSync?: SessionSyncState;
  inFlightFeishuRun?: { sessionFile: string; beforeEntryIds: string[]; prompt: string };
  announcementRevision?: number;
  updatedAt: string;
}

export type State = Record<string, ChatBinding>;
