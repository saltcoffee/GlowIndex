/**
 * 全部可调参数集中在这里。调参只需要改这个文件，算法代码不用动。
 *
 * 评分思路（详见 docs/ALGORITHM.md）：
 *   总分 = Σ(权重 × 因子得分) × 100 + 修正项，映射到六档强度。
 */

export const VERSION = '1.2.3';
export const ALGORITHM_ID = `glowindex/${VERSION}`;

/**
 * 六个因子的权重，必须加起来等于 1。
 * 改动建议：想强调"没被低云挡住"就提高 lowCloud；想强调"云量不够"就提高 canvas。
 */
export const WEIGHTS = {
  sunAngle: 0.12, // 太阳高度角：光要以什么角度照过来
  canvas: 0.34, // 中高云"画布"：有没有能被打亮的云（最重要）
  lowCloud: 0.26, // 低云遮挡：太阳方向有没有被堵死
  clarity: 0.15, // 空气通透度：能见度 / 露点差 / 湿度 / 气溶胶
  precip: 0.08, // 降水抑制：正在下雨就基本没戏
  wind: 0.05, // 风力质感：微风最好，静风积霾，大风散云
};

/**
 * 强度分级。min 闭区间、max 开区间，按顺序匹配。
 * 阈值是这样定的：晴朗无云（≈10 分）、一般好天气（≈45）、
 * 值得出门（≈75）、需要几乎所有条件都接近理想（≈90+）。
 */
export const LEVELS = [
  { code: 'none', name: '不烧', emoji: '☁️', min: 0, max: 28, summary: '基本没有可观赏的霞光' },
  { code: 'slight', name: '微烧', emoji: '🌤️', min: 28, max: 44, summary: '天边有一点淡色，聊胜于无' },
  { code: 'mild', name: '小烧', emoji: '🌅', min: 44, max: 58, summary: '局部能看到成片橙色，值得抬头' },
  { code: 'moderate', name: '中烧', emoji: '🌇', min: 58, max: 74, summary: '颜色明显、层次清楚，适合拍照' },
  { code: 'big', name: '大烧', emoji: '🔥', min: 74, max: 90, summary: '大片火烧云，值得专程出门' },
  { code: 'epic', name: '世纪大烧', emoji: '🔥🔥', min: 90, max: 100.0001, summary: '罕见的天幕级燃烧，可遇不可求' },
];

export const LIMITS = {
  maxDays: 3, // WeatherAPI 免费额度只给 3 天预报
  defaultDays: 2,
  sampleStepMin: 5, // 事件窗口内的评分采样步长
  timelineStepMin: 10, // 返回给用户的时间轴步长
  maxTimelinePoints: 14,
  maxAddressLength: 120,
  // 只有太阳高度角落在这个区间内才评分（日出日落前后的一段）
  elevation: { min: -8, max: 10 },
  // 评分窗口：以日落/日出时刻为基准的偏移（分钟）
  window: {
    sunset: { before: 35, after: 20 },
    sunrise: { before: 20, after: 35 },
  },
};

export const CACHE_TTL = {
  forecast: 1500, // 25 分钟：WeatherAPI 归一化预报缓存
  metnoMetadata: 86400, // 24 小时：保留响应缓存头，以便过期后做条件请求
  metnoFallback: 3600, // 上游没给缓存头时，至少 1 小时后才重取
  geocode: 604800, // 7 天：地名解析结果
  response: 600, // 10 分钟：整个响应缓存
  memoryMax: 400, // 无 Cache API 时的内存兜底条数
};

export const HTTP = {
  weatherApiTimeoutMs: 7000,
  metnoTimeoutMs: 7000,
  retries: 1,
  retryDelayMs: 250,
};

export const SOURCES = {
  weatherApi: 'https://api.weatherapi.com/v1',
  // MET Norway：免费、可商用（CC BY 4.0）、无需 Key、提供分层云
  metno: 'https://api.met.no/weatherapi/locationforecast/2.0',
};

/** 16 方位中文名（正北开始顺时针，每 22.5° 一格）。 */
export const COMPASS_16 = [
  '北',
  '北偏东',
  '东北',
  '东偏北',
  '东',
  '东偏南',
  '东南',
  '南偏东',
  '南',
  '南偏西',
  '西南',
  '西偏南',
  '西',
  '西偏北',
  '西北',
  '北偏西',
];
