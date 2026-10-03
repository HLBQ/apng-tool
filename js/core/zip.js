/**
 * zip.js —— 手写 ZIP（仅 STORE 模式，不压缩）
 *
 * 用途：一次导出图片里所有帧时，打包成单个 zip 下载，
 * 避免浏览器把连续多次下载当成弹窗滥用而拦截。
 */

import { crc32 } from './crc32.js';
import { concatBytes } from './pngchunks.js';

/**
 * @param {Array<{name:string, data:Uint8Array}>} entries
 * @param {Date} [date]
 * @returns {Uint8Array}
 */
export function buildZip(entries, date = new Date()) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  const { dosTime, dosDate } = toDosDateTime(date);

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);  // 本地文件头签名
    lv.setUint16(4, 20, true);          // 解压所需版本
    lv.setUint16(6, 0x0800, true);      // 标志位：文件名为 UTF-8
    lv.setUint16(8, 0, true);           // 压缩方式：STORE
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // 压缩后大小
    lv.setUint32(22, data.length, true); // 原始大小
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // 扩展字段长度
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);   // 中央目录签名
    cv.setUint16(4, 20, true);           // 创建版本
    cv.setUint16(6, 20, true);           // 解压所需版本
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);           // 扩展字段
    cv.setUint16(32, 0, true);           // 注释
    cv.setUint16(34, 0, true);           // 磁盘号
    cv.setUint16(36, 0, true);           // 内部属性
    cv.setUint32(38, 0, true);           // 外部属性
    cv.setUint32(42, offset, true);      // 本地头偏移
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralDir = concatBytes(centralParts);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);     // EOCD 签名
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralDir.length, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return concatBytes([...localParts, centralDir, end]);
}

/** JS Date → MS-DOS 时间格式（ZIP 规范） */
function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}
