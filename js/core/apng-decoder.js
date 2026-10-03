/**
 * apng-decoder.js —— 解析 PNG / APNG，并还原出「每一帧真正长什么样」
 *
 * 背景（这批伪装图的本质）：
 *   1. 普通 PNG 只能显示一张静态图，所以桌面端、QQ 预览、缩略图都只显示默认图。
 *   2. 一旦文件里出现 acTL + fcTL + fdAT，它就是 APNG；
 *      浏览器、「查看原图」会播放动画，于是"看着是静态图，点开却会动"。
 *   3. 若第一个 fcTL 出现在 IDAT 之后，则 IDAT 是被保留的「默认图」，
 *      动画帧只存在于 fdAT 里 —— 这正是本工具要复刻的伪装结构。
 *
 * 帧解码策略：把每一帧的数据重新包成一份「独立的 PNG」，
 * 交给浏览器原生解码（自动兼容调色板 / 各种位深 / 隔行扫描），
 * 再按 APNG 规范做 dispose / blend 合成，得到该帧显示时的完整画面。
 */

import {
  parseChunks,
  concatBytes,
  readU32,
  readU16,
  makeChunk,
  makeIhdrData,
  latin1Decode,
  PNG_SIGNATURE,
  COLOR_TYPE_NAMES,
} from './pngchunks.js';
import { createCanvas, context2d, decodeImage } from '../utils/image.js';

/** dispose_op 名称 */
export const DISPOSE_NAMES = { 0: 'NONE', 1: 'BACKGROUND', 2: 'PREVIOUS' };
/** blend_op 名称 */
export const BLEND_NAMES = { 0: 'SOURCE', 1: 'OVER' };

/**
 * 解析一份 PNG/APNG 的头部与帧索引（不解码像素，速度极快）。
 * @param {Uint8Array} bytes
 * @returns {Object} doc
 */
export function inspect(bytes) {
  const { chunks, crcAllOk } = parseChunks(bytes);

  let header = null;
  let actl = null;
  const plte = [];
  const trns = [];
  const idat = [];
  const frames = [];
  const texts = {};
  const textOrder = [];
  const chunkCounts = {};

  let sawIdat = false;

  for (const chunk of chunks) {
    chunkCounts[chunk.type] = (chunkCounts[chunk.type] || 0) + 1;

    switch (chunk.type) {
      case 'IHDR': {
        const d = chunk.data;
        header = {
          width: readU32(d, 0),
          height: readU32(d, 4),
          bitDepth: d[8],
          colorType: d[9],
          compression: d[10],
          filter: d[11],
          interlace: d[12],
        };
        break;
      }
      case 'acTL':
        actl = { numFrames: readU32(chunk.data, 0), numPlays: readU32(chunk.data, 4) };
        break;
      case 'PLTE':
        plte.push(chunk.data);
        break;
      case 'tRNS':
        trns.push(chunk.data);
        break;
      case 'tEXt': {
        const zero = chunk.data.indexOf(0);
        const keyword = latin1Decode(chunk.data.subarray(0, zero < 0 ? chunk.data.length : zero));
        const value = zero < 0 ? '' : latin1Decode(chunk.data.subarray(zero + 1));
        texts[keyword] = value;
        textOrder.push({ keyword, value, compressed: false });
        break;
      }
      case 'zTXt':
      case 'iTXt': {
        const zero = chunk.data.indexOf(0);
        const keyword = latin1Decode(chunk.data.subarray(0, zero < 0 ? chunk.data.length : zero));
        textOrder.push({ keyword, value: '（压缩文本，本工具不解压）', compressed: true });
        texts[keyword] = '（压缩文本）';
        break;
      }
      case 'fcTL': {
        const d = chunk.data;
        frames.push({
          sequence: readU32(d, 0),
          width: readU32(d, 4),
          height: readU32(d, 8),
          x: readU32(d, 12),
          y: readU32(d, 16),
          delayNum: readU16(d, 20),
          delayDen: readU16(d, 22),
          dispose: d[24],
          blend: d[25],
          // 第一个 fcTL 出现在 IDAT 之前 ⇒ 这一帧就是 IDAT 本身
          usesIdat: frames.length === 0 && !sawIdat,
          datas: [],
        });
        break;
      }
      case 'IDAT': {
        sawIdat = true;
        idat.push(chunk.data);
        const current = frames[frames.length - 1];
        if (current && current.usesIdat) current.datas.push(chunk.data);
        break;
      }
      case 'fdAT': {
        const current = frames[frames.length - 1];
        if (current) current.datas.push(chunk.data.subarray(4));
        break;
      }
      default:
        break;
    }
  }

  if (!header) throw new Error('文件缺少 IHDR 块');

  // 第一个 fcTL 在 IDAT 之后（或压根没有 fcTL）⇒ IDAT 是独立的「默认图」
  const needsDefaultFrame = frames.length === 0 || !frames[0].usesIdat;

  const defaultFrame = needsDefaultFrame
    ? {
      sequence: -1,
      width: header.width,
      height: header.height,
      x: 0,
      y: 0,
      delayNum: 0,
      delayDen: 100,
      dispose: 0,
      blend: 0,
      usesIdat: true,
      datas: idat,
    }
    : null;

  const displayList = [];
  if (defaultFrame) {
    displayList.push({ ...defaultFrame, kind: 'default', index: 0, label: '默认帧（桌面 / 预览看到的静态图）' });
  }
  frames.forEach((frame, i) => {
    displayList.push({
      ...frame,
      kind: 'frame',
      index: defaultFrame ? i + 1 : i,
      label: `动画帧 ${i + 1}`,
    });
  });

  /** fcTL 的 delay_num / delay_den（单位：秒）→ 毫秒 */
  const toDelayMs = (f) => {
    const den = f.delayDen === 0 ? 100 : f.delayDen;
    return Math.round((f.delayNum / den) * 1000);
  };

  for (const item of displayList) {
    item.delayMs = item.kind === 'default' ? null : toDelayMs(item);
    item.dataSize = item.datas.reduce((sum, d) => sum + d.length, 0);
  }

  return {
    fileSize: bytes.length,
    header,
    width: header.width,
    height: header.height,
    bitDepth: header.bitDepth,
    colorType: header.colorType,
    colorTypeName: COLOR_TYPE_NAMES[header.colorType] || `未知(${header.colorType})`,
    interlace: header.interlace,
    isApng: Boolean(actl) && frames.length > 0,
    numFrames: actl ? actl.numFrames : 0,
    numPlays: actl ? actl.numPlays : 0,
    hasDefaultImage: Boolean(defaultFrame),
    defaultFrame,
    animationFrames: frames,
    displayList,
    texts,
    textOrder,
    chunkCounts,
    crcAllOk,
    /** 解码帧时需要的公共块 */
    resources: { plte, trns },
    /** 原始字节 */
    bytes,
  };
}

/** 把一帧的数据包成一份可被浏览器独立解码的 PNG */
function buildFramePng(doc, frame) {
  const parts = [
    PNG_SIGNATURE,
    makeChunk('IHDR', makeIhdrData(frame.width, frame.height, doc.bitDepth, doc.colorType, doc.interlace)),
  ];
  for (const p of doc.resources.plte) parts.push(makeChunk('PLTE', p));
  for (const t of doc.resources.trns) parts.push(makeChunk('tRNS', t));
  parts.push(makeChunk('IDAT', concatBytes(frame.datas)));
  parts.push(makeChunk('IEND'));
  return concatBytes(parts);
}

/**
 * 逐帧合成整幅画面。
 * @param {Object} doc inspect() 的返回值
 * @param {Object} [options]
 * @param {number} [options.scale] 输出缩放（0.2 = 缩略图）
 * @param {string} [options.background] 需要时填充背景色（默认透明）
 * @param {(payload:{index:number, frame:Object, canvas:HTMLCanvasElement})=>any} [options.onFrame]
 * @returns {Promise<number>} 渲染的帧数
 */
export async function renderAllFrames(doc, options = {}) {
  const { scale = 1, onFrame, background = null } = options;
  const W = doc.width;
  const H = doc.height;
  const base = createCanvas(W, H, { readFrequently: true });
  const ctx = context2d(base, { readFrequently: true });
  ctx.clearRect(0, 0, W, H);

  const outW = Math.max(1, Math.round(W * scale));
  const outH = Math.max(1, Math.round(H * scale));
  const list = doc.displayList;
  let previousSnapshot = null;

  for (let i = 0; i < list.length; i += 1) {
    const frame = list[i];

    // 1) 先执行「上一帧」的 dispose（规范要求：在当前帧绘制之前完成）
    if (i > 0) {
      const prev = list[i - 1];
      if (prev.dispose === 1) {
        ctx.clearRect(prev.x, prev.y, prev.width, prev.height);
      } else if (prev.dispose === 2 && previousSnapshot) {
        ctx.putImageData(previousSnapshot, 0, 0);
      }
    }

    // 2) 若本帧要求 PREVIOUS，先保存「绘制它之前」的画面
    if (frame.dispose === 2) {
      previousSnapshot = ctx.getImageData(0, 0, W, H);
    }

    // 3) 绘制本帧
    const drawable = await decodeImage(buildFramePng(doc, frame));
    if (frame.blend === 1) {
      ctx.drawImage(drawable, frame.x, frame.y);
    } else {
      // SOURCE：连透明像素也要覆盖，必须先清空该矩形再画
      ctx.save();
      ctx.beginPath();
      ctx.rect(frame.x, frame.y, frame.width, frame.height);
      ctx.clip();
      ctx.clearRect(frame.x, frame.y, frame.width, frame.height);
      ctx.drawImage(drawable, frame.x, frame.y);
      ctx.restore();
    }
    if (typeof drawable.close === 'function') drawable.close();

    // 4) 输出一份独立画布（调用方可安全长期持有）
    const canvas = createCanvas(outW, outH, { readFrequently: true });
    const octx = context2d(canvas, { readFrequently: true });
    if (background) {
      octx.fillStyle = background;
      octx.fillRect(0, 0, outW, outH);
    }
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(base, 0, 0, outW, outH);

    if (onFrame) await onFrame({ index: i, frame, canvas });
  }

  return list.length;
}

/**
 * 单独渲染第 index 帧（内部从头跑到该帧，保证 dispose / blend 正确）。
 * @returns {Promise<HTMLCanvasElement|null>}
 */
export async function renderFrameAt(doc, index, { scale = 1, background = null } = {}) {
  let result = null;
  await renderAllFrames(doc, {
    scale,
    background,
    onFrame: ({ index: i, canvas }) => {
      if (i === index) result = canvas;
    },
  });
  return result;
}

/** 所有动画帧延迟之和（毫秒） */
export function totalDuration(doc) {
  return doc.displayList.reduce((sum, f) => sum + (f.delayMs || 0), 0);
}
