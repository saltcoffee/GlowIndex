/** 把因子明细翻译成"人能看懂的几句话"。 */

/**
 * @param {object} params
 * @param {object} params.level 档位对象
 * @param {object[]} params.factors 因子明细
 * @param {object[]} params.modifiers 修正项
 * @param {'sunrise'|'sunset'} params.type
 * @param {number} params.confidence
 * @returns {string[]} 2–4 条提示
 */
export function buildAdvice({ level, factors, modifiers, type, confidence }) {
  const tips = [];
  const sorted = [...factors].sort((a, b) => b.contribution - a.contribution);

  // 贡献最大的两项，只要不是明显拉胯就正面描述
  for (const f of sorted.slice(0, 2)) {
    if (f.score >= 0.6 && tips.length < 2) tips.push(f.detail);
  }

  // 最弱的一项单独点名
  const worst = [...factors].sort((a, b) => a.score - b.score)[0];
  if (worst && worst.score < 0.5) {
    tips.push(`${worst.detail}，这是目前最主要的短板。`);
  }

  for (const m of modifiers) {
    tips.push(`${m.name}：${m.detail}。`);
  }

  if (level.code === 'epic' || level.code === 'big') {
    tips.push(
      type === 'sunset'
        ? '建议提前 25 分钟到位，日落之后 5–15 分钟往往是色彩最浓的时刻。'
        : '建议提前 25 分钟到位，日出之前的 10–20 分钟往往是色彩最浓的时刻。',
    );
  }

  if (confidence < 0.6) {
    tips.push('数据置信度偏低，结论仅供参考；临近时段再看一次会更准。');
  }

  return tips.slice(0, 5);
}
