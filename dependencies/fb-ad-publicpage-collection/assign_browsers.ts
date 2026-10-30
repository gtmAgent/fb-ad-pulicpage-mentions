import { randomIntBetween } from 'xport-browser-sdk';

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIntBetween(0, i);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * 为每个关键词选定浏览器（平均分配）。
 * 返回与 keywordCount 等长的 deviceId 列表。
 */
export function assignBrowsersEvenly(browserIds: number[], keywordCount: number): number[] {
  if (keywordCount <= 0 || browserIds.length === 0) return [];
  const pool = shuffleInPlace([...browserIds]);
  if (keywordCount <= pool.length) {
    return pool.slice(0, keywordCount);
  }
  const out: number[] = [];
  for (let i = 0; i < keywordCount; i++) {
    out.push(pool[i % pool.length]!);
  }
  return out;
}
