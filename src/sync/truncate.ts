import { SYNC_TRUNCATION_MARKER } from '../config.js';

/**
 * 同步消息体截断：按 UTF-8 字节数控制上限、按字符（码点）切分，避免切断多字节字符产生乱码。
 * 预算按 1/3（头部）: 2/3（尾部）分配，尾部为最新轮次优先保留；中间以截断说明替代。
 * 调用方已保证 body 超限，此处再短路一次双保险（body 不超限时原样返回）。
 */
export function truncateSyncBody(body: string, byteLimit: number): string {
  if (Buffer.byteLength(body, 'utf8') <= byteLimit) return body;
  const chars = Array.from(body);
  const markerBytes = Buffer.byteLength(SYNC_TRUNCATION_MARKER, 'utf8');
  const budget = byteLimit - markerBytes;
  const headBudget = Math.floor(budget / 3);
  const tailBudget = budget - headBudget;
  let headBytes = 0;
  let head = 0;
  while (head < chars.length) {
    const bytes = Buffer.byteLength(chars[head], 'utf8');
    if (headBytes + bytes > headBudget) break;
    headBytes += bytes;
    head += 1;
  }
  let tailBytes = 0;
  let tail = chars.length;
  while (tail > head) {
    const bytes = Buffer.byteLength(chars[tail - 1], 'utf8');
    if (tailBytes + bytes > tailBudget) break;
    tailBytes += bytes;
    tail -= 1;
  }
  return `${chars.slice(0, head).join('')}${SYNC_TRUNCATION_MARKER}${chars.slice(tail).join('')}`;
}
