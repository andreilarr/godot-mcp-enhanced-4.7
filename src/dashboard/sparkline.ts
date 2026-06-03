/**
 * Sparkline — 将数值数组渲染为 Unicode 块状字符。
 * 纯函数，无外部依赖。
 * 字符集（8 级）：▁▂▃▄▅▆▇█
 * 防御性降采样：超过 10000 个数据点时自动降采样到 1000，
 * 避免 Math.min(...values) 栈溢出。
 */

const CHARS = '▁▂▃▄▅▆▇█';
const MAX_INTERNAL_WIDTH = 1000;
const DOWNSAMPLE_THRESHOLD = 10000;

export interface SparklineOptions {
  maxWidth?: number;
}

function downsample(values: number[], target: number): number[] {
  const sampled: number[] = [];
  const step = (values.length - 1) / (target - 1);
  for (let i = 0; i < target; i++) {
    sampled.push(values[Math.round(i * step)]);
  }
  return sampled;
}

export function sparkline(data: number[], opts: SparklineOptions = {}): string {
  if (data.length === 0) return '';

  let values = data;

  // 防御性降采样：大数组先降到安全规模
  if (values.length > DOWNSAMPLE_THRESHOLD) {
    values = downsample(values, MAX_INTERNAL_WIDTH);
  }

  // 用户 maxWidth 降采样
  const maxWidth = opts.maxWidth ?? values.length;
  if (values.length > maxWidth) {
    values = downsample(values, maxWidth);
  }

  // 安全计算 min/max（用循环替代展开，避免栈溢出）
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  const range = max - min;
  const singlePoint = values.length === 1;

  return values
    .map(v => {
      if (!Number.isFinite(v)) return CHARS[0];
      if (range === 0) return singlePoint ? CHARS[CHARS.length - 1] : CHARS[0];
      const normalized = (v - min) / range;
      const idx = Math.min(Math.floor(normalized * (CHARS.length - 1)), CHARS.length - 1);
      return CHARS[Math.max(0, idx)];
    })
    .join('');
}
