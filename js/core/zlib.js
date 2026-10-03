/**
 * zlib.js —— 只负责「压缩」（PNG 的 IDAT/fdAT 需要 zlib / RFC1950 数据流）
 *
 * 优先使用浏览器原生的 CompressionStream('deflate')，它输出的正是 zlib 格式
 * （带 0x78 头 + Adler-32 尾），无需任何第三方库。
 * 若环境不支持（老浏览器 / 部分 node），则回退到「存储型 deflate 块」：
 * 依然是合法 zlib 流，只是不做压缩，文件会明显变大。
 */

const hasCompressionStream = typeof CompressionStream === 'function';

/** 当前环境是否具备原生 zlib 压缩能力 */
export function hasNativeCompression() {
  return hasCompressionStream;
}

/**
 * 把任意字节压缩成 zlib 流。
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function zlibDeflate(bytes) {
  if (hasCompressionStream) {
    try {
      return await pipeThrough(bytes, new CompressionStream('deflate'));
    } catch (error) {
      console.warn('[zlib] CompressionStream 不可用，回退到存储型 deflate：', error);
    }
  }
  return storedZlib(bytes);
}

/**
 * 把字节写进 TransformStream 再整体读回来。
 * 必须先启动读取再写入，否则大文件会因为背压死锁。
 */
async function pipeThrough(bytes, transform) {
  const reading = collectAll(transform.readable);
  const writer = transform.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return reading;
}

async function collectAll(readable) {
  const reader = readable.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * 存储型 deflate（BTYPE=00）：合法但无压缩。
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function storedZlib(bytes) {
  const MAX_BLOCK = 0xffff;
  const blockCount = Math.max(1, Math.ceil(bytes.length / MAX_BLOCK));
  const parts = [Uint8Array.from([0x78, 0x01])]; // zlib 头：deflate，无预设字典，最快
  let offset = 0;

  for (let i = 0; i < blockCount; i += 1) {
    const length = Math.min(MAX_BLOCK, bytes.length - offset);
    const isLast = offset + length >= bytes.length;
    const header = new Uint8Array(5);
    header[0] = isLast ? 1 : 0; // BFINAL + BTYPE=00
    header[1] = length & 0xff;
    header[2] = (length >>> 8) & 0xff;
    header[3] = ~length & 0xff;
    header[4] = (~length >>> 8) & 0xff;
    parts.push(header);
    parts.push(bytes.subarray(offset, offset + length));
    offset += length;
  }

  parts.push(writeAdler32(bytes));
  return concat(parts);
}

/** zlib 流尾部的 Adler-32 校验（大端） */
export function writeAdler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  const value = ((b << 16) | a) >>> 0;
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concat(parts) {
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
