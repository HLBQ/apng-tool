/**
 * pngchunks.js —— PNG 文件「块（chunk）」级读写
 *
 * PNG 结构： 8 字节签名 + 若干个块
 *   块 = 长度(4,大端) + 类型(4,ASCII) + 数据(长度) + CRC32(4,对「类型+数据」计算)
 *
 * 本模块只关心字节，不做解码，因此 node 下也能跑。
 */

import { crc32 } from './crc32.js';

/** PNG 文件魔数 */
export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 颜色类型 → 人类可读名称 */
export const COLOR_TYPE_NAMES = {
  0: '灰度',
  2: '真彩色 RGB',
  3: '索引色 Palette',
  4: '灰度 + Alpha',
  6: '真彩色 RGBA',
};

/** @param {Uint8Array} bytes */
export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * 拼接若干 Uint8Array。
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
export function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** 读大端 u32 */
export function readU32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/** 读大端 u16 */
export function readU16(bytes, offset) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

/** 写大端 u32 */
export function writeU32(value) {
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** 写大端 u16 */
export function writeU16(value) {
  return Uint8Array.from([(value >>> 8) & 0xff, value & 0xff]);
}

/**
 * 解析整份 PNG 的块列表。
 * @param {Uint8Array} bytes
 * @returns {{chunks: Array<{type:string,data:Uint8Array,offset:number,length:number,crcOk:boolean}>, endOffset:number, crcAllOk:boolean}}
 */
export function parseChunks(bytes) {
  if (!isPng(bytes)) throw new Error('不是有效的 PNG 文件（缺失 PNG 签名）');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = 8;
  let crcAllOk = true;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error(`块 ${type} 数据越界，文件可能已损坏或被截断`);
    }
    const data = bytes.subarray(dataStart, dataEnd);
    const storedCrc = view.getUint32(dataEnd);
    const crcOk = crc32(bytes, offset + 4, dataEnd) === storedCrc;
    if (!crcOk) crcAllOk = false;
    chunks.push({ type, data, offset, length, crcOk });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }

  if (!chunks.length || chunks[chunks.length - 1].type !== 'IEND') {
    throw new Error('文件缺少 IEND 块，不是完整的 PNG');
  }
  return { chunks, endOffset: offset, crcAllOk };
}

/**
 * 生成一个完整块（含长度与 CRC）。
 * @param {string} type 4 个 ASCII 字符
 * @param {Uint8Array} [data]
 * @returns {Uint8Array}
 */
export function makeChunk(type, data = new Uint8Array(0)) {
  if (type.length !== 4) throw new Error(`块类型必须是 4 个字符，收到 "${type}"`);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * 用块列表拼出一份完整 PNG 文件。
 * @param {Array<{type:string,data:Uint8Array}>} chunks
 * @returns {Uint8Array}
 */
export function buildPng(chunks) {
  return concatBytes([PNG_SIGNATURE, ...chunks.map((c) => makeChunk(c.type, c.data))]);
}

/**
 * 构造 IHDR 数据段（13 字节）。
 */
export function makeIhdrData(width, height, bitDepth, colorType, interlace = 0) {
  return concatBytes([
    writeU32(width),
    writeU32(height),
    Uint8Array.from([bitDepth, colorType, 0, 0, interlace]),
  ]);
}

/** Latin-1（PNG tEXt 规定使用 ISO-8859-1）编码 */
export function latin1Encode(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Latin-1 解码 */
export function latin1Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * 构造 tEXt 块数据：keyword\0text（Latin-1）
 */
export function makeTextData(keyword, text) {
  return concatBytes([latin1Encode(keyword), Uint8Array.from([0]), latin1Encode(text)]);
}
