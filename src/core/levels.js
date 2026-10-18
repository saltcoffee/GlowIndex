/** 强度分级：分数 → 档位 → 给用户看的文案。 */

import { LEVELS } from '../config.js';

/** 分数（0–100）落到哪一档。区间左闭右开，顶部档兜底。 */
export function levelFor(score) {
  const s = Number.isFinite(score) ? score : 0;
  for (const level of LEVELS) {
    if (s >= level.min && s < level.max) return level;
  }
  return LEVELS[LEVELS.length - 1];
}

export function levelPayload(level) {
  return {
    code: level.code,
    name: level.name,
    emoji: level.emoji,
    summary: level.summary,
    range: [level.min, Math.min(level.max, 100)],
  };
}

/** 档位序号（0 = 不烧），方便前端按序画色条。 */
export function levelIndex(level) {
  return LEVELS.findIndex((l) => l.code === level.code);
}

export { LEVELS };
