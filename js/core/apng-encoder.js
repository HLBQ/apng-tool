/**
 * apng-encoder.js —— 从零组装一份 APNG（本工具「制作」页的核心）
 *
 * 这里复刻的是样本文件的真实结构（用 Node 逐块 dump 过 Image_1790660132235_338.png 确认）：
 *
 *   PNG 签名
 *   IHDR                 ← 画布尺寸
 *   acTL(num_frames, 0)  ← 声明这是 APNG；num_frames 只数「动画帧」，0 = 无限循环
 *   tEXt                 ← ChatBarApngDisguise = 1;STATIC;1
 *   IDAT                 ← 默认图：桌面图标 / 聊天预览 / 缩略图 看到的就是它
 *   fcTL(seq=0) 整幅      ← 动画第 1 帧（隐藏内容）
 *   fdAT(seq=1)
 *   fcTL(seq=2) 1x1       ← 动画第 2 帧：一个全透明像素 + OVER 混合 = 画面零变化
 *   fdAT(seq=3)
 *   IEND
 *
 * 两个关键点：
 *   1. 第一个 fcTL 必须出现在 IDAT 之后，IDAT 才会被当作「默认图」而不是动画第 1 帧；
 *      此时 acTL.num_frames 只统计 fcTL 的个数。
 *   2. fcTL 与 fdAT 共用同一个递增序列号（0,1,2,3...），这是 APNG 里最容易写错的地方。
 */

import {
  PNG_SIGNATURE,
  concatBytes,
  makeChunk,
  makeIhdrData,
  makeTextData,
  writeU16,
  writeU32,
} from './pngchunks.js';
import { zlibDeflate } from './zlib.js';

/** APNG 帧的 dispose_op */
export const DISPOSE = { NONE: 0, BACKGROUND: 1, PREVIOUS: 2 };
/** APNG 帧的 blend_op */
export const BLEND = { SOURCE: 0, OVER: 1 };

/** acTL 数据：帧数 + 循环次数（0 = 无限） */
function makeActlData(numFrames, numPlays) {
  return concatBytes([writeU32(numFrames), writeU32(numPlays)]);
}

/** fcTL 数据：固定 26 字节 */
function makeFctlData({ sequence, width, height, x, y, delayNum, delayDen, disposeOp, blendOp }) {
  return concatBytes([
    writeU32(sequence),
    writeU32(width),
    writeU32(height),
    writeU32(x),
    writeU32(y),
    writeU16(delayNum),
    writeU16(delayDen),
    Uint8Array.from([disposeOp, blendOp]),
  ]);
}

/**
 * RGBA 像素 → PNG 扫描线（每行前加 1 字节 filter 类型，这里统一用 0 = None）。
 * @param {Uint8ClampedArray|Uint8Array} rgba
 */
function toScanlines(rgba, width, height) {
  const stride = width * 4;
  const out = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    out[rowStart] = 0; // filter: None
    out.set(rgba.subarray(y * stride, y * stride + stride), rowStart + 1);
  }
  return out;
}

/** 毫秒 → APNG 的 delay_num / delay_den（样本用的是 10/100，即 100ms） */
function delayFromMs(ms) {
  const safe = Math.max(0, Math.round(ms));
  if (safe === 0) return { num: 0, den: 100 };
  if (safe % 10 === 0 && safe / 10 <= 65535) return { num: safe / 10, den: 100 };
  return { num: Math.min(65535, safe), den: 1000 };
}

/**
 * 编码 APNG。
 *
 * 两种结构：
 *   A. 带默认图（样本用的结构）：IDAT 写在所有 fcTL 之前，
 *      静态场景显示 IDAT，动画由后面的 fcTL + fdAT 组成，acTL 只统计动画帧数。
 *   B. 不带默认图：第一个 fcTL 在 IDAT 之前，此时 IDAT 既是静态图也是动画第 1 帧。
 *
 * @param {Object} options
 * @param {number} options.width  画布宽
 * @param {number} options.height 画布高
 * @param {{data:Uint8ClampedArray|Uint8Array}} [options.defaultImage] 默认图，写入 IDAT
 * @param {Array<Object>} options.frames 动画帧，每项可为
 *        { data, x=0, y=0, width=画布宽, height=画布高, delayMs=100, disposeOp=0, blendOp=0 }，
 *        其中 data 必须是 width x height 的 RGBA。
 * @param {number} [options.numPlays=0] 循环次数，0 = 无限
 * @param {Array<[string,string]>} [options.texts] 追加的 tEXt 键值对
 * @param {(ratio:number, message:string)=>void} [options.onProgress] 进度回调
 * @returns {Promise<Uint8Array>}
 */
export async function encodeApng(options) {
  const {
    width,
    height,
    frames,
    defaultImage = null,
    numPlays = 0,
    texts = [],
    onProgress = null,
  } = options;

  const report = (ratio, message) => { if (typeof onProgress === 'function') onProgress(ratio, message); };

  if (!Array.isArray(frames) || frames.length === 0) throw new Error('至少需要 1 帧图像');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('画布尺寸无效');
  }

  const hasDefault = Boolean(defaultImage && defaultImage.data);
  if (hasDefault && defaultImage.data.length !== width * height * 4) {
    throw new Error(`默认图像素长度为 ${defaultImage.data.length}，期望 ${width * height * 4}（${width} x ${height} x 4）`);
  }

  // 每帧可以是整幅，也可以是画布内的一个小矩形（样本尾部就是 1x1 的小块）
  const plan = frames.map((frame, i) => {
    const fw = frame.width == null ? width : frame.width;
    const fh = frame.height == null ? height : frame.height;
    const got = frame && frame.data ? frame.data.length : 0;
    if (!frame || !frame.data || got !== fw * fh * 4) {
      throw new Error(`第 ${i + 1} 帧像素长度为 ${got}，期望 ${fw * fh * 4}（${fw} x ${fh} x 4）`);
    }
    return {
      data: frame.data,
      width: fw,
      height: fh,
      x: frame.x == null ? 0 : frame.x,
      y: frame.y == null ? 0 : frame.y,
      delay: delayFromMs(frame.delayMs == null ? 100 : frame.delayMs),
      disposeOp: frame.disposeOp == null ? DISPOSE.NONE : frame.disposeOp,
      blendOp: frame.blendOp == null ? BLEND.SOURCE : frame.blendOp,
    };
  });

  // 有默认图，或不止一帧，才算真正的 APNG
  const isApng = hasDefault || plan.length > 1;

  report(0.02, '写入文件头');
  const parts = [PNG_SIGNATURE];
  parts.push(makeChunk('IHDR', makeIhdrData(width, height, 8, 6, 0))); // 8bit RGBA，非隔行

  if (isApng) {
    parts.push(makeChunk('acTL', makeActlData(plan.length, numPlays)));
  }

  for (const [keyword, value] of texts) {
    if (!keyword) continue;
    parts.push(makeChunk('tEXt', makeTextData(keyword, value == null ? '' : String(value))));
  }

  let sequence = 0;
  const totalFrames = plan.length;

  /** 输出一个动画帧：fcTL + fdAT */
  const pushAnimationFrame = async (item, index) => {
    parts.push(makeChunk('fcTL', makeFctlData({
      sequence: sequence++,
      width: item.width,
      height: item.height,
      x: item.x,
      y: item.y,
      delayNum: item.delay.num,
      delayDen: item.delay.den,
      disposeOp: item.disposeOp,
      blendOp: item.blendOp,
    })));
    report(0.12 + (index / totalFrames) * 0.8, `压缩第 ${index + 1}/${totalFrames} 帧像素`);
    const compressed = await zlibDeflate(toScanlines(item.data, item.width, item.height));
    parts.push(makeChunk('fdAT', concatBytes([writeU32(sequence++), compressed])));
  };

  if (hasDefault) {
    // 结构 A：IDAT = 默认图，之后才是动画帧
    report(0.06, '压缩默认图（IDAT）');
    parts.push(makeChunk('IDAT', await zlibDeflate(toScanlines(defaultImage.data, width, height))));
    for (let i = 0; i < totalFrames; i += 1) await pushAnimationFrame(plan[i], i);
  } else if (!isApng) {
    // 单帧且无默认图 → 就是一份普通静态 PNG
    report(0.3, '压缩像素');
    parts.push(makeChunk('IDAT', await zlibDeflate(toScanlines(plan[0].data, plan[0].width, plan[0].height))));
  } else {
    // 结构 B：第 0 帧的 fcTL 在 IDAT 之前，IDAT 即动画第 1 帧
    const first = plan[0];
    parts.push(makeChunk('fcTL', makeFctlData({
      sequence: sequence++,
      width: first.width,
      height: first.height,
      x: first.x,
      y: first.y,
      delayNum: first.delay.num,
      delayDen: first.delay.den,
      disposeOp: first.disposeOp,
      blendOp: first.blendOp,
    })));
    report(0.12, '压缩第 1 帧像素（IDAT）');
    parts.push(makeChunk('IDAT', await zlibDeflate(toScanlines(first.data, first.width, first.height))));
    for (let i = 1; i < totalFrames; i += 1) await pushAnimationFrame(plan[i], i);
  }

  parts.push(makeChunk('IEND'));
  report(0.98, '组装文件结构');
  return concatBytes(parts);
}

/**
 * 生成伪装图的推荐参数。
 * 帧角色的区别就是这个伪装术的全部：
 *   - 第 0 帧（默认图）：任何只认静态图的场景看到的内容
 *   - 第 1 帧起（动画帧）：浏览器 / 查看原图播放出来的内容，可以有多个
 */
export const DISGUISE_DEFAULTS = {
  /** 与那批真实伪装图一致的私有 tEXt 标记 */
  tagKeyword: 'ChatBarApngDisguise',
  tagValue: '1;STATIC;1',
  /** 样本里双帧图的帧延迟是 10/100 秒 = 100ms */
  delayMs: 100,
  /** 尾部那个 1x1 透明补帧（样本里也有），用来凑成完整循环的动画 */
  includeTailFrame: true,
};

/** 尾部补帧用的像素：完全透明，配 OVER 混合就等于画面零变化 */
export function makeTransparentPatch() {
  return Uint8ClampedArray.from([0, 0, 0, 0]);
}

/**
 * 生成伪装 APNG（复刻样本结构）。
 *
 *   IHDR(W x H) → acTL(N, 0) → tEXt(1;STATIC;1)
 *   → IDAT   = 第 0 帧（默认图，静态场景显示它）
 *   → fcTL/fdAT 第 1 帧 = 第 1 个动画帧（整幅，隐藏内容）
 *   → fcTL/fdAT 第 2..N 帧 = 追加的动画帧（整幅，按顺序播放）
 *   → fcTL/fdAT 尾巴 = 1x1 透明补帧（blend=OVER，画面零变化）
 *   → IEND
 *
 * @param {Object} options
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} options.frame0 默认图（静态封面）
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} [options.frame1] 第 1 个动画帧（隐藏内容）
 * @param {Array<{data:Uint8ClampedArray|Uint8Array,width:number,height:number}>} [options.animationFrames]
 *        全部动画帧（按播放顺序）。给了它就忽略 frame1；不传则用 [frame1]
 * @param {string} [options.tagValue] ChatBarApngDisguise 的值
 * @param {boolean} [options.includeTag] 是否写入该 tEXt
 * @param {boolean} [options.includeTailFrame] 是否追加 1x1 透明补帧
 * @param {number} [options.delayMs] 帧延迟，默认 100ms（即 10/100 秒）
 * @param {number} [options.numPlays] 循环次数，0 = 无限
 * @param {Array<[string,string]>} [options.extraTexts] 额外 tEXt
 * @param {Function} [options.onProgress] 进度回调
 */
export function encodeDisguiseApng(options) {
  const {
    frame0,
    frame1,
    animationFrames,
    tagValue = DISGUISE_DEFAULTS.tagValue,
    includeTag = true,
    includeTailFrame = DISGUISE_DEFAULTS.includeTailFrame,
    delayMs = DISGUISE_DEFAULTS.delayMs,
    numPlays = 0,
    extraTexts = [],
    onProgress,
  } = options;

  if (!frame0 || !frame0.data) {
    throw new Error('需要提供第 0 帧（默认图）');
  }
  const width = frame0.width;
  const height = frame0.height;
  if (!width || !height) {
    throw new Error('第 0 帧尺寸无效（宽高必须大于 0）');
  }

  // 动画帧列表：优先用 animationFrames，否则退回单个 frame1
  const animList = Array.isArray(animationFrames) && animationFrames.length
    ? animationFrames.slice()
    : (frame1 ? [frame1] : []);
  if (!animList.length) {
    throw new Error('至少需要一个动画帧（第 1 帧）');
  }
  animList.forEach((frame, i) => {
    const label = `第 ${i + 1} 个动画帧`;
    if (!frame || !frame.data) throw new Error(`${label}没有像素数据`);
    if (frame.data.length !== width * height * 4) {
      throw new Error(`${label}尺寸与第 0 帧不一致（第 0 帧 ${width} x ${height}），请先做尺寸适配`);
    }
  });

  const texts = [];
  if (includeTag) texts.push([DISGUISE_DEFAULTS.tagKeyword, tagValue]);
  texts.push(...extraTexts);

  const frames = animList.map((frame) => ({
    data: frame.data,
    width,
    height,
    x: 0,
    y: 0,
    delayMs,
    disposeOp: DISPOSE.NONE,
    blendOp: BLEND.SOURCE,
  }));

  if (includeTailFrame) {
    frames.push({
      data: makeTransparentPatch(),
      width: 1,
      height: 1,
      x: 0,
      y: 0,
      delayMs,
      disposeOp: DISPOSE.NONE,
      blendOp: BLEND.OVER,
    });
  }

  return encodeApng({
    width,
    height,
    defaultImage: { data: frame0.data, width, height },
    frames,
    numPlays,
    texts,
    onProgress,
  });
}
