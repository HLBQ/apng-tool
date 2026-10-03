/**
 * analyze-view.js —— 「查看与导出」面板
 *
 * 功能：
 *   1. 拖入/选择任意图片（非 PNG 会自动转换格式，见 core/image-io.js）
 *   2. 展示 PNG 块结构、元数据、帧统计
 *   3. 把每一帧还原成画面并逐条列出，可单独导出或整包导出
 *   所有批量步骤都会更新悬浮进度弹窗（见 ui/progress.js）。
 */

import {
  inspect,
  renderAllFrames,
  renderFrameAt,
  totalDuration,
  DISPOSE_NAMES,
  BLEND_NAMES,
} from '../core/apng-decoder.js';
import { loadImageDataFromFile, imageDataToPngBytes, readFileBytes } from '../core/image-io.js';
import { buildZip } from '../core/zip.js';
import { isPng, PNG_SIGNATURE } from '../core/pngchunks.js';
import { createDropzone } from './dropzone.js';
import { createProgress, clearProgressPopup } from './progress.js';
import { toast } from './toast.js';
import { openCanvasModal } from './modal.js';
import { el, clear } from '../utils/dom.js';
import { formatBytes, formatDelay, baseName, pad } from '../utils/format.js';
import { download, canvasToBlob } from '../utils/download.js';

/** 元信息的一行 */
function kvRow(label, value, mono = false) {
  return el('div', { class: 'kv__row' },
    el('span', { class: 'kv__k', text: label }),
    el('span', { class: `kv__v${mono ? ' mono' : ''}`, text: value }),
  );
}

export function mountAnalyzeView(root) {
  clear(root);
  // 进度条统一显示在悬浮弹窗里，这里先清掉上一个面板遗留的进度行
  clearProgressPopup();
  const progress = createProgress('总进度');
  const listHost = el('div', { class: 'cards' });

  const zone = createDropzone({
    title: '拖入图片文件，或点击这里选择（可多选）',
    hint: 'PNG / APNG 直接解析；JPEG、GIF、WebP、BMP、TIFF、HEIC 等会先自动转换成 PNG 再分析',
    multiple: true,
    accept: 'image/*,.png,.apng,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff,.heic,.avif,.ico',
    onFiles: handleFiles,
  });

  root.append(
    el('div', { class: 'panel__intro' },
      el('h2', { class: 'panel__title', text: '查看与导出' }),
      el('p', {
        class: 'panel__desc',
        text: '解析 PNG 的块结构，把文件里每一帧都还原成真实画面并列出来，可逐帧查看、导出，或打包成 zip。',
      }),
    ),
    zone,
    listHost,
  );

  /** 依次处理文件，全程上报进度 */
  async function handleFiles(files) {
    const total = files.length;
    for (let i = 0; i < total; i += 1) {
      const file = files[i];
      const report = (ratio, message) => progress.set((i + ratio) / total, `[${i + 1}/${total}] ${message}`);
      try {
        await analyzeFile(file, report);
      } catch (error) {
        console.error(error);
        progress.fail(`${file.name} 处理失败：${error.message}`);
        toast(`${file.name} 处理失败：${error.message}`, 'error', 6000);
      }
    }
    progress.done(`已处理 ${total} 个文件`);
    progress.reset();
  }

  async function analyzeFile(file, report) {
    report(0, `读取 ${file.name}`);
    const rawBytes = await readFileBytes(file, (r) => report(r * 0.18, `读取 ${file.name}`));

    let pngBytes = rawBytes;
    let convertedFrom = null;

    if (!isPng(rawBytes)) {
      report(0.2, `${file.name} 不是 PNG，开始转换格式`);
      const loaded = await loadImageDataFromFile(file, {
        onProgress: (info) => report(0.2 + info.ratio * 0.45, info.message),
      });
      convertedFrom = loaded.format.label;
      pngBytes = await imageDataToPngBytes(loaded.imageData, (info) => report(0.65 + info.ratio * 0.2, info.message));
    }

    report(0.88, `${file.name} 解析块结构`);
    const doc = inspect(pngBytes);
    doc.sourceName = file.name;
    doc.originalSize = file.size;
    doc.convertedFrom = convertedFrom;

    const card = createCard(file, doc, pngBytes, report);
    listHost.prepend(card.root);
    await card.loadFrames();
    report(1, `${file.name} 分析完成`);
  }
}

/** 文件基础信息表 */
function buildInfoTable(file, doc, pngBytes) {
  const wrap = el('div', { class: 'kv' });
  wrap.append(
    kvRow('文件名', file.name),
    kvRow('原始大小', formatBytes(file.size)),
    kvRow('分析用数据', formatBytes(pngBytes.length)),
  );
  if (doc.convertedFrom) {
    wrap.append(kvRow('格式转换', `不是 PNG（${doc.convertedFrom}），已自动转换为 PNG 后解析`));
  }
  wrap.append(
    kvRow('判定', doc.isApng ? 'APNG（内含动画，会播放）' : '静态 PNG（无动画）'),
    kvRow('画布尺寸', `${doc.width} x ${doc.height}`),
    kvRow('颜色类型', `${doc.colorTypeName}（类型 ${doc.colorType}，位深 ${doc.bitDepth}）`),
    kvRow('隔行扫描', doc.interlace ? '是' : '否'),
    kvRow('acTL 帧数', doc.isApng ? String(doc.numFrames) : '无 acTL'),
    kvRow('循环次数', doc.isApng ? (doc.numPlays === 0 ? '0（无限循环）' : String(doc.numPlays)) : '-'),
    kvRow('默认图', doc.hasDefaultImage ? '有' : '无'),
    kvRow('块统计', Object.entries(doc.chunkCounts).map(([k, v]) => `${k}:${v}`).join('  '), true),
    kvRow('CRC 校验', doc.crcAllOk ? '全部通过' : '存在校验失败的块', true),
  );
  if (doc.isApng) {
    wrap.append(kvRow('总时长', `${totalDuration(doc)} ms`));
  }
  return wrap;
}

/** tEXt / zTXt / iTXt 元数据表 */
function buildTextTable(doc) {
  if (!doc.textOrder.length) {
    return el('div', { class: 'texts' }, el('div', { class: 'muted', text: '没有文本元数据块' }));
  }
  const rows = doc.textOrder.map((item) => el('div', { class: 'texts__row' },
    el('span', { class: 'texts__k mono', text: item.keyword }),
    el('span', { class: 'texts__v mono', text: item.value || '(空)' }),
  ));
  const hint = doc.texts.ChatBarApngDisguise
    ? el('div', { class: 'note' }, el('span', {
      class: 'muted',
      text: '检测到 ChatBarApngDisguise 标记：这是这批伪装图的私有 tEXt，值形如 "1;ANIMATED;帧数" 或 "1;STATIC;1"。',
    }))
    : null;
  return el('div', { class: 'texts' }, el('div', { class: 'section__title', text: '文本元数据（tEXt）' }), ...rows, hint);
}

/** 帧文件名 */
function frameFileName(stage, index) {
  return `${stage}_frame${pad(index, 3)}.png`;
}

/** 构建一张文件卡片，返回 { root, loadFrames } */
function createCard(file, doc, pngBytes, report) {
  const stage = baseName(file.name);
  const grid = el('div', { class: 'frames__grid' });
  const cardProgress = createProgress('准备渲染帧');
  const countLabel = el('span', { class: 'muted', text: `共 ${doc.displayList.length} 帧` });

  const btnZip = el('button', { class: 'btn', type: 'button', text: '导出全部帧（zip）', disabled: true });
  const btnDefault = el('button', { class: 'btn btn--ghost', type: 'button', text: '导出默认帧' });
  const btnRaw = el('button', { class: 'btn btn--ghost', type: 'button', text: '下载分析用 PNG' });
  const btnRemove = el('button', { class: 'btn btn--ghost', type: 'button', text: '移除' });

  const root = el('article', { class: 'card' },
    el('header', { class: 'card__head' },
      el('div', { class: 'card__title', text: file.name }),
      el('div', { class: 'card__badges' },
        el('span', { class: `badge${doc.isApng ? ' badge--alert' : ''}`, text: doc.isApng ? 'APNG 伪装图' : '静态 PNG' }),
        doc.hasDefaultImage ? el('span', { class: 'badge', text: '带默认图' }) : null,
        doc.convertedFrom ? el('span', { class: 'badge', text: `由 ${doc.convertedFrom} 转换` }) : null,
      ),
      btnRemove,
    ),
    buildInfoTable(file, doc, pngBytes),
    buildTextTable(doc),
    el('div', { class: 'frames' },
      el('div', { class: 'section__title' },
        el('span', { text: '帧列表' }),
        ' ',
        countLabel,
      ),
      el('div', { class: 'frames__actions' }, btnZip, btnDefault, btnRaw),
      grid,
    ),
  );

  btnRemove.addEventListener('click', () => root.remove());
  btnRaw.addEventListener('click', () => download(pngBytes, `${stage}.png`, 'image/png'));
  btnDefault.addEventListener('click', () => exportOne(0));
  btnZip.addEventListener('click', exportAll);

  /** 逐帧渲染缩略图并列出，带进度 */
  let rendered = false;
  async function loadFrames() {
    if (rendered) return;
    rendered = true;
    const total = doc.displayList.length;
    const scale = Math.min(1, 200 / Math.max(doc.width, doc.height));
    try {
      await renderAllFrames(doc, {
        scale,
        onFrame: ({ index, frame, canvas }) => {
          grid.append(buildFrameItem(doc, frame, canvas, index, stage, exportOne));
          cardProgress.set((index + 1) / total, `渲染帧 ${index + 1}/${total}`);
        },
      });
      btnZip.disabled = false;
      cardProgress.done(`已列出 ${total} 帧`);
    } catch (error) {
      console.error(error);
      cardProgress.fail(`渲染帧失败：${error.message}`);
      toast(`渲染帧失败：${error.message}`, 'error', 6000);
    }
  }

  /** 导出单帧（原始分辨率） */
  async function exportOne(index) {
    try {
      cardProgress.set(0.15, `渲染第 ${index} 帧（原始分辨率）`);
      const canvas = await renderFrameAt(doc, index, { scale: 1 });
      if (!canvas) throw new Error('该帧不存在');
      cardProgress.set(0.7, 'PNG 编码中');
      const blob = await canvasToBlob(canvas);
      download(blob, frameFileName(stage, index), 'image/png');
      cardProgress.done(`已导出第 ${index} 帧`);
    } catch (error) {
      console.error(error);
      cardProgress.fail(`导出失败：${error.message}`);
      toast(`导出失败：${error.message}`, 'error', 6000);
    }
  }

  /** 全部帧渲染成 PNG 并打包成 zip（带进度） */
  async function exportAll() {
    const total = doc.displayList.length;
    const entries = [];
    try {
      await renderAllFrames(doc, {
        scale: 1,
        onFrame: async ({ index, canvas }) => {
          cardProgress.set(((index + 1) / total) * 0.88, `导出帧 ${index + 1}/${total}`);
          const blob = await canvasToBlob(canvas);
          entries.push({ name: frameFileName(stage, index), data: new Uint8Array(await blob.arrayBuffer()) });
        },
      });
      cardProgress.set(0.94, '打包 zip');
      download(buildZip(entries), `${stage}_frames.zip`, 'application/zip');
      cardProgress.done(`已导出 ${entries.length} 帧`);
      report(1, `${file.name} 导出完成`);
    } catch (error) {
      console.error(error);
      cardProgress.fail(`打包导出失败：${error.message}`);
      toast(`打包导出失败：${error.message}`, 'error', 6000);
    }
  }

  return { root, loadFrames };
}

/** 帧列表里的一条 */
function buildFrameItem(doc, frame, canvas, index, stage, onExport) {
  const isDefault = frame.kind === 'default';
  const caption = isDefault ? '默认帧 / 静态预览' : `动画帧 ${index}`;
  const thumbWrap = el('div', { class: 'frame__thumb' }, canvas);
  const open = () => openCanvasModal(canvas, `${stage} - 第 ${index} 帧（${caption}）`);
  thumbWrap.addEventListener('click', open);

  return el('div', { class: `frame${isDefault ? ' frame--default' : ''}` },
    el('div', { class: 'frame__head' },
      el('span', { class: 'frame__no mono', text: `#${pad(index, 3)}` }),
      el('span', { class: `badge${isDefault ? '' : ' badge--alert'}`, text: caption }),
    ),
    thumbWrap,
    el('div', { class: 'frame__meta mono' },
      el('div', { text: `${frame.width} x ${frame.height} @ (${frame.x}, ${frame.y})` }),
      el('div', { text: isDefault ? 'delay: 无延迟（静态默认图）' : `delay: ${formatDelay(frame.delayMs)}` }),
      el('div', { text: `dispose: ${DISPOSE_NAMES[frame.dispose] || frame.dispose}  blend: ${BLEND_NAMES[frame.blend] || frame.blend}` }),
      el('div', { text: `帧数据: ${formatBytes(frame.dataSize)}` }),
    ),
    el('div', { class: 'frame__actions' },
      el('button', { class: 'btn btn--ghost', type: 'button', text: '查看大图', onclick: open }),
      el('button', { class: 'btn btn--ghost', type: 'button', text: '导出此帧', onclick: () => onExport(index) }),
    ),
  );
}

