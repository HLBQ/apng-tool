/**
 * crc32.js —— PNG 块与 ZIP 条目共用的 CRC-32（IEEE 802.3，多项式 0xEDB88320）
 *
 * 纯计算模块，不依赖浏览器 API，可在 node 下直接 import 做单元测试。
 */

/** 预计算 256 项查表，避免每次逐位运算 */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 计算 [start, end) 区间的 CRC-32。
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @returns {number} 无符号 32 位整数
 */
export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
