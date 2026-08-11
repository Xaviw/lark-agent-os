import { SYNC_TRUNCATION_MARKER } from '../config.js';
import type { SyncRow } from '../types.js';

/** 同步消息行数组的总 UTF-8 字节数 */
function rowsByteLength(rows: SyncRow[]): number {
  return rows.reduce((total, row) => total + Buffer.byteLength(row.text, 'utf8'), 0);
}

/**
 * 单行字符级截断：按 UTF-8 字节数控制上限、按字符（码点）切分，避免切断多字节字符产生乱码。
 * 截断后追加省略号，总字节不超过 byteLimit（省略号字节计入预算）。
 * 仅用于极端超长单行（正常按行切分即可满足预算）。
 */
function truncateRowText(text: string, byteLimit: number): string {
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) return text;
  const ellipsis = '…';
  const budget = byteLimit - Buffer.byteLength(ellipsis, 'utf8');
  if (budget <= 0) return ellipsis;
  const chars = Array.from(text);
  let bytes = 0;
  let cut = 0;
  for (const ch of chars) {
    const byteLength = Buffer.byteLength(ch, 'utf8');
    if (bytes + byteLength > budget) break;
    bytes += byteLength;
    cut += 1;
  }
  return `${chars.slice(0, cut).join('')}${ellipsis}`;
}

/**
 * 同步消息体截断（按行数组操作，每行独立 text 元素、标题行带 bold）：
 * 预算按 1/3（头部）: 2/3（尾部）分配，尾部为最新轮次优先保留；中间以截断说明行替代。
 * 头部与尾部至少各保留 1 行；极端超长单行（超过所在侧预算）退化为字符级截断该行。
 */
export function truncateSyncRows(rows: SyncRow[], byteLimit: number): SyncRow[] {
  if (rows.length === 0) return rows;
  if (rowsByteLength(rows) <= byteLimit) return rows;
  const markerBytes = Buffer.byteLength(SYNC_TRUNCATION_MARKER, 'utf8');
  const budget = byteLimit - markerBytes;
  const headBudget = Math.floor(budget / 3);
  const tailBudget = budget - headBudget;
  // 头部前缀：首行必选，其余在 headBudget 内累积
  let headEnd = 1;
  let headBytes = Buffer.byteLength(rows[0].text, 'utf8');
  while (headEnd < rows.length) {
    const rowBytes = Buffer.byteLength(rows[headEnd].text, 'utf8');
    if (headBytes + rowBytes > headBudget) break;
    headBytes += rowBytes;
    headEnd += 1;
  }
  // 尾部后缀：末行必选，其余在 tailBudget 内累积；与头部前缀不重叠
  let tailStart = rows.length;
  let tailBytes = 0;
  while (tailStart > headEnd) {
    const rowBytes = Buffer.byteLength(rows[tailStart - 1].text, 'utf8');
    if (tailStart < rows.length && tailBytes + rowBytes > tailBudget) break;
    tailBytes += rowBytes;
    tailStart -= 1;
  }
  // 头部首行超预算：退化为单行截断（此时 headEnd === 1）
  const headRows = headBytes > headBudget
    ? [{ ...rows[0], text: truncateRowText(rows[0].text, headBudget) }]
    : rows.slice(0, headEnd);
  // 尾部末行超预算：退化为单行截断（此时 tail 后缀仅末行）
  let tailRows = rows.slice(tailStart);
  if (tailRows.length > 0 && tailBytes > tailBudget) {
    tailRows = [{ ...tailRows[0], text: truncateRowText(tailRows[0].text, tailBudget) }];
  }
  return [...headRows, { text: SYNC_TRUNCATION_MARKER }, ...tailRows];
}
