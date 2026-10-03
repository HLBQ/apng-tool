/**
 * format.js —— 展示层格式化
 */

/** 字节数 → 人类可读 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 帧延迟（毫秒）→ 可读文本 */
export function formatDelay(ms) {
  if (ms === null || ms === undefined) return '默认(100ms)';
  if (ms === 0) return '0ms（无延迟）';
  if (ms >= 1000) return `${ms}ms (${(ms / 1000).toFixed(2)}s)`;
  return `${ms}ms`;
}

/** 数字补零 */
export function pad(value, width = 3) {
  return String(value).padStart(width, '0');
}

/** 去掉扩展名的文件名 */
export function baseName(fileName) {
  return String(fileName).replace(/\.[^.]+$/, '');
}

/** 把 dispose_op / blend_op 数值转成中文说明（APNG 规范） */
export function describeDispose(op) {
  return { 0: 'NONE 保留', 1: 'BACKGROUND 清空', 2: 'PREVIOUS 还原' }[op] || `未知(${op})`;
}

export function describeBlend(op) {
  return { 0: 'SOURCE 覆盖', 1: 'OVER 叠加' }[op] || `未知(${op})`;
}
