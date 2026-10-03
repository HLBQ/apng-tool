/**
 * create-view.js —— 「制作伪装图」面板
 *
 * 至少两帧，这正是这类伪装图的最小结构：
 *   第 0 帧（默认图）→ 桌面图标、聊天窗口预览等只认静态图的场景看到它
 *   第 1 帧起（动画帧）→ 浏览器 / 查看原图时按顺序播放出来的内容，可以继续添加
 * 输入支持任意图片格式，非 PNG 会自动转成 PNG 像素再参与合成。
 */

import { loadImageDataFromFile } from '../core/image-io.js';
import { encodeDisguiseApng, DISGUISE_DEFAULTS } from '../core/apng-encoder.js';
import { inspect } from '../core/apng-decoder.js';
import { parseChunks } from '../core/pngchunks.js';
import { createDropzone } from './dropzone.js';
import { createProgress, clearProgressPopup } from './progress.js';
import { toast } from './toast.js';
import { el, clear } from '../utils/dom.js';
import { formatBytes, baseName } from '../utils/format.js';
import { download } from '../utils/download.js';
import { createCanvas, context2d, fitImageData, drawCheckerboard } from '../utils/image.js';

/** 第 0 帧是默认图，第 1 帧开始都是动画帧 */
function slotTitle(index) {
  return index === 0 ? '第 0 帧：默认图' : `第 ${index} 帧：动画帧`;
}

function slotHint(index) {
  return index === 0
    ? '别人第一眼看到的内容（桌面、缩略图、聊天预览都用它），写进 IDAT'
    : '浏览器打开 / 查看原图时按顺序播放的内容，写进 fdAT';
}

export function mountCreateView(root) {
  clear(root);
  // 进度条统一显示在悬浮弹窗里，这里先清掉上一个面板遗留的进度行
  clearProgressPopup();

  const state = { frames: [null, null], previewTimer: null, previewFrames: null, result: null };
  const progress = createProgress('总进度');
  const slotHost = el('div', { class: 'slot-grid' });
  const resultHost = el('div', { class: 'result' });
  const previewCanvas = el('canvas', { class: 'preview__canvas' });
  const previewInfo = el('div', { class: 'preview__info mono', text: '尚未预览' });

  /** 末尾那张「添加帧」卡片：每点一次就多一个动画帧插槽 */
  const addCard = el('button', { class: 'add-slot', type: 'button', title: '继续添加下一个动画帧' },
    el('span', { class: 'add-slot__plus', text: '+' }),
    el('span', { class: 'add-slot__label', text: '添加帧' }),
    el('span', { class: 'add-slot__hint', text: '再插一张图，作为下一个动画帧' }),
  );
  addCard.addEventListener('click', () => addFrame());

  let slots = [];
  renderSlots();

  const options = buildOptions();
  const btnBuild = el('button', { class: 'btn btn--primary', type: 'button', text: '生成并下载 APNG' });
  const btnPreview = el('button', { class: 'btn', type: 'button', text: '预览播放效果' });
  const btnStop = el('button', { class: 'btn btn--ghost', type: 'button', text: '停止预览' });
  const btnReset = el('button', { class: 'btn btn--ghost', type: 'button', text: '清空' });

  btnBuild.addEventListener('click', build);
  btnPreview.addEventListener('click', startPreview);
  btnStop.addEventListener('click', stopPreview);
  btnReset.addEventListener('click', () => {
    stopPreview();
    state.frames = [null, null];
    state.result = null;
    renderSlots();
    clear(resultHost);
    previewInfo.textContent = '尚未预览';
    context2d(previewCanvas).clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    toast('已清空', 'info');
  });

  root.append(
    el('div', { class: 'panel__intro' },
      el('h2', { class: 'panel__title', text: '制作伪装图' }),
      el('p', {
        class: 'panel__desc',
        text: '第 0 帧写进 IDAT 作为默认图（桌面图标、聊天预览等静态场景看到它），第 1 帧起写进 fdAT 成为动画帧（浏览器打开或查看原图时按顺序播放），末尾再补一个 1x1 透明帧凑成完整循环。想多播几张，就点最下面的「添加帧」。各帧尺寸不同会自动适配。',
      }),
    ),
    slotHost,
    options.root,
    el('div', { class: 'actions' }, btnBuild, btnPreview, btnStop, btnReset),
    el('div', { class: 'preview' },
      el('div', { class: 'section__title', text: '播放预览' }),
      previewCanvas,
      previewInfo,
    ),
    resultHost,
  );

  /** 重建插槽列表：每帧一张卡片，每张独占一行，末尾固定跟「添加帧」卡片 */
  function renderSlots() {
    clear(slotHost);
    slots = state.frames.map((_, index) => {
      const slot = createSlot(index);
      slotHost.append(slot.root);
      return slot;
    });
    slotHost.append(addCard);
    slots.forEach((slot) => slot.render());
  }

  /** 「添加帧」：插槽数量不设上限，想加几张就加几张 */
  function addFrame() {
    state.frames.push(null);
    renderSlots();
    const index = state.frames.length - 1;
    const slot = slots[index];
    if (slot) {
      slot.root.scrollIntoView({ behavior: 'smooth', block: 'center' });
      slot.focus();
    }
    toast(`已添加第 ${index} 帧（动画帧），请拖入图片`, 'info');
  }

  /** 移除多余的动画帧（第 0 帧与第 1 帧是伪装图的最小结构，不可删除） */
  function removeFrame(index) {
    state.frames.splice(index, 1);
    renderSlots();
    checkSizeMismatch();
    toast(`已移除第 ${index} 帧`, 'info');
  }

  /** 单帧插槽 */
  function createSlot(index) {
    const body = el('div', { class: 'slot__body' });
    const meta = el('div', { class: 'slot__meta mono', text: '未选择文件' });
    const hintEl = el('div', { class: 'slot__hint', text: slotHint(index) });
    const btnClear = el('button', { class: 'btn btn--ghost', type: 'button', text: '清除该帧' });
    const slotProgress = createProgress(`第 ${index} 帧`);
    const headButtons = el('div', { class: 'slot__buttons' }, btnClear);
    if (index >= 2) {
      const btnRemove = el('button', { class: 'btn btn--ghost', type: 'button', text: '移除该帧' });
      btnRemove.addEventListener('click', () => removeFrame(index));
      headButtons.append(btnRemove);
    }

    btnClear.addEventListener('click', () => {
      state.frames[index] = null;
      render();
      toast(`已清除${slotTitle(index)}`, 'info');
    });

    const zone = createDropzone({
      title: '拖入图片或点击选择',
      hint: '任意格式（PNG / JPEG / WebP / GIF / BMP / TIFF / HEIC ...），自动转为 PNG 像素',
      accept: 'image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff,.heic,.avif,.ico',
      compact: true,
      onFiles: ([file]) => handleFile(file),
    });

    const rootEl = el('section', { class: 'slot' },
      el('header', { class: 'slot__head' },
        el('div', { class: 'slot__title', text: slotTitle(index) }),
        headButtons,
      ),
      hintEl,
      zone,
      body,
      meta,
    );

    function render() {
      clear(body);
      meta.textContent = '未选择文件';
      const frame = state.frames[index];
      // 图片就绪后就不再显示拖拽 / 点击上传区（连同无意义的「清除该帧」一起收起），
      // 卡片只留缩略图与文件信息；点「清除该帧」后上传区会自动回来
      zone.hidden = Boolean(frame);
      btnClear.hidden = !frame;
      hintEl.textContent = frame ? '已就绪：换图请先点「清除该帧」，再重新拖入图片' : slotHint(index);
      if (!frame) return;
      // 尺寸优先取 imageData，避免上游对象漏给 width / height 时算出 0 尺寸画布
      const srcW = frame.width || frame.imageData.width;
      const srcH = frame.height || frame.imageData.height;
      const thumbW = Math.max(1, Math.min(srcW, 260));
      const thumbH = Math.max(1, Math.round(thumbW * (srcH / srcW)));
      const shown = createCanvas(thumbW, thumbH);
      const ctx = context2d(shown);
      drawCheckerboard(ctx, shown.width, shown.height, 10);
      const tmp = createCanvas(srcW, srcH);
      context2d(tmp).putImageData(frame.imageData, 0, 0);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tmp, 0, 0, shown.width, shown.height);
      body.append(el('div', { class: 'slot__preview' }, shown));
      meta.textContent = [
        `文件: ${frame.file ? frame.file.name : '（未记录文件名）'}`,
        `尺寸: ${srcW} x ${srcH}`,
        `格式: ${frame.format.label}${frame.converted ? '（已转换）' : ''}`,
        `大小: ${frame.file ? formatBytes(frame.file.size) : '-'}`,
      ].join('\n');
    }

    /** 读取并转换该帧文件，带进度上报 */
    async function handleFile(file) {
      const report = (ratio, message) => slotProgress.set(ratio, message);
      try {
        const loaded = await loadImageDataFromFile(file, {
          onProgress: (info) => report(info.ratio, info.message),
        });
        // 显式带上来源文件，缩略图信息栏与下载文件名都要用它
        state.frames[index] = { ...loaded, file };
        render();
        slotProgress.done(`${slotTitle(index)} 已就绪`);
        toast(`${slotTitle(index)}：${loaded.note}`, 'success');
        checkSizeMismatch();
      } catch (error) {
        console.error(error);
        slotProgress.fail(`读取失败：${error.message}`);
        toast(`读取失败：${error.message}`, 'error', 6000);
      }
    }

    render();
    return {
      root: rootEl,
      render,
      /** 新加出来的插槽滚到眼前后，光标直接落到选择区 */
      focus() {
        zone.focus();
      },
    };
  }

  /** 所有已选帧里，只要有和默认图尺寸不同的就提醒一次 */
  function checkSizeMismatch() {
    const loaded = state.frames.filter(Boolean);
    if (loaded.length < 2) return;
    const first = loaded[0];
    const diff = loaded.slice(1).filter((frame) => frame.width !== first.width || frame.height !== first.height);
    if (diff.length) {
      toast(`有 ${diff.length} 帧与第 0 帧尺寸不同（第 0 帧 ${first.width}x${first.height}），生成时会自动适配`, 'warn', 6000);
    }
  }

  /** 输出设置表单 */
  function buildOptions() {
    const sizeMode = el('select', { class: 'input' },
      el('option', { value: 'auto', text: '以第 0 帧尺寸为准' }),
      el('option', { value: 'frame1', text: '以第 1 帧尺寸为准' }),
      el('option', { value: 'custom', text: '自定义尺寸' }),
    );
    // 默认 -1 表示「跟随第 0 帧画布尺寸」，只有填正整数才真正自定义
    const customW = el('input', { class: 'input', type: 'number', min: '-1', value: '-1' });
    const customH = el('input', { class: 'input', type: 'number', min: '-1', value: '-1' });
    const fitMode = el('select', { class: 'input' },
      el('option', { value: 'cover', text: 'cover 裁剪铺满（推荐）' }),
      el('option', { value: 'contain', text: 'contain 完整显示，留透明边' }),
      el('option', { value: 'stretch', text: 'stretch 拉伸变形' }),
    );
    const delayInput = el('input', { class: 'input', type: 'number', min: '0', value: String(DISGUISE_DEFAULTS.delayMs) });
    const playsInput = el('input', { class: 'input', type: 'number', min: '0', value: '0' });
    const tagCheck = el('input', { type: 'checkbox', checked: true });
    const tagInput = el('input', { class: 'input mono', type: 'text', value: DISGUISE_DEFAULTS.tagValue });
    const tailCheck = el('input', { type: 'checkbox', checked: DISGUISE_DEFAULTS.includeTailFrame });
    const extraTexts = el('textarea', { class: 'input mono', rows: '3', placeholder: '每行一条，格式：关键字=值' });

    const field = (label, control, note) => el('label', { class: 'field' },
      el('span', { class: 'field__label', text: label }),
      el('span', { class: 'field__control' }, control),
      note ? el('span', { class: 'field__note', text: note }) : null,
    );

    const rootEl = el('div', { class: 'options' },
      el('div', { class: 'section__title', text: '输出设置' }),
      el('div', { class: 'options__grid' },
        field('画布尺寸', sizeMode),
        field('自定义宽 x 高', el('span', { class: 'inline' }, customW, el('span', { text: ' x ' }), customH),
          '默认 -1 = 跟随第 0 帧画布尺寸；两格都填正整数才按自定义尺寸输出'),
        field('第 1 帧适配方式', fitMode),
        field('帧延迟（毫秒）', delayInput, '样本取 100 毫秒，即 10/100 秒'),
        field('循环次数', playsInput, '0 表示无限循环'),
        field('写入 ChatBarApngDisguise', el('span', { class: 'inline' }, tagCheck, tagInput)),
        field('追加 1x1 透明补帧', tailCheck, '样本末尾也有这一帧，让播放器把它当成真正的动画'),
      ),
      field('额外 tEXt 文本（可留空）', extraTexts, '每行一条，例如：Comment=hello'),
    );

    return {
      root: rootEl,
      read() {
        const texts = [];
        String(extraTexts.value || '').split('\n').forEach((line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          const eq = trimmed.indexOf('=');
          if (eq <= 0) return;
          texts.push([trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()]);
        });
        return {
          sizeMode: sizeMode.value,
          customW: parseInt(customW.value, 10),
          customH: parseInt(customH.value, 10),
          fitMode: fitMode.value,
          delayMs: Math.max(0, parseInt(delayInput.value, 10) || 0),
          numPlays: Math.max(0, parseInt(playsInput.value, 10) || 0),
          includeTag: Boolean(tagCheck.checked),
          tagValue: tagInput.value,
          includeTailFrame: Boolean(tailCheck.checked),
          extraTexts: texts,
        };
      },
    };
  }

  /** 检查插槽是否都选好了，返回 { frame0, anim } */
  function requireAllFrames() {
    const frame0 = state.frames[0];
    if (!frame0) {
      toast('请先把第 0 帧（默认图）选好', 'warn');
      return null;
    }
    const anim = state.frames.slice(1);
    const missing = anim.findIndex((frame) => !frame);
    if (missing >= 0) {
      toast(`请先把第 ${missing + 1} 帧选好（多余的插槽可以「移除该帧」）`, 'warn');
      return null;
    }
    return { frame0, anim };
  }

  /** 决定画布尺寸 */
  function resolveSize(opts) {
    const f0 = state.frames[0];
    const f1 = state.frames[1];
    // 自定义宽高默认是 -1，含义就是「跟随第 0 帧画布」；只有两格都填正整数才真正自定义
    if (opts.sizeMode === 'custom' && opts.customW > 0 && opts.customH > 0) {
      return { width: opts.customW, height: opts.customH };
    }
    if (opts.sizeMode === 'frame1' && f1) return { width: f1.width, height: f1.height };
    return { width: f0.width, height: f0.height };
  }

  /** 生成并下载 */
  async function build() {
    const picked = requireAllFrames();
    if (!picked) return;
    const { frame0, anim } = picked;
    const opts = options.read();
    try {
      const { width, height } = resolveSize(opts);
      progress.set(0.04, `准备画布 ${width} x ${height}`);
      const d0 = fitImageData(frame0.imageData, width, height, opts.fitMode);
      progress.set(0.1, `适配 ${anim.length} 个动画帧`);
      const animationFrames = anim.map((frame) => ({
        data: fitImageData(frame.imageData, width, height, opts.fitMode).data,
        width,
        height,
      }));
      const totalAnim = anim.length + (opts.includeTailFrame ? 1 : 0);
      progress.set(0.16, `压缩像素并组装 APNG（acTL 记 ${totalAnim} 帧）`);
      const bytes = await encodeDisguiseApng({
        frame0: { data: d0.data, width, height },
        animationFrames,
        tagValue: opts.tagValue,
        includeTag: opts.includeTag,
        includeTailFrame: opts.includeTailFrame,
        delayMs: opts.delayMs,
        numPlays: opts.numPlays,
        extraTexts: opts.extraTexts,
        onProgress: (ratio, message) => progress.set(0.16 + ratio * 0.78, message),
      });
      const name = `${baseName(frame0.file ? frame0.file.name : 'apng')}_disguise.png`;
      download(bytes, name, 'image/png');
      state.result = { bytes, name };
      renderResult(bytes, name);
      progress.done(`已生成 ${name}（${formatBytes(bytes.length)}）`);
      toast(`生成成功：${name}`, 'success');
    } catch (error) {
      console.error(error);
      progress.fail(`生成失败：${error.message}`);
      toast(`生成失败：${error.message}`, 'error', 6000);
    }
  }

  /** 生成结果自检：把刚写出的字节再解析一遍，确认结构正确 */
  function renderResult(bytes, name) {
    clear(resultHost);
    let doc = null;
    let order = '';
    try {
      doc = inspect(bytes);
      order = parseChunks(bytes).chunks.map((chunk) => chunk.type).join(' > ');
    } catch (error) {
      resultHost.append(el('div', { class: 'note', text: `自检解析失败：${error.message}` }));
      return;
    }

    const animFrames = doc.displayList.filter((frame) => frame.kind !== 'default');
    const lastFrame = doc.displayList[doc.displayList.length - 1];
    const hasTail = Boolean(
      lastFrame && lastFrame.kind === 'frame' && lastFrame.width === 1 && lastFrame.height === 1,
    );
    // 补帧不算「真正播放内容」，所以单独减掉
    const playCount = Math.max(0, animFrames.length - (hasTail ? 1 : 0));

    const rows = [
      ['文件名', name],
      ['文件大小', formatBytes(bytes.length)],
      ['判定', doc.isApng ? 'APNG（浏览器会播放动画）' : '静态 PNG'],
      ['画布尺寸', `${doc.width} x ${doc.height}`],
      ['acTL 帧数', doc.isApng ? String(doc.numFrames) : '无'],
      ['动画帧数', doc.isApng ? String(animFrames.length) : '无'],
      ['循环次数', doc.isApng ? (doc.numPlays === 0 ? '无限' : String(doc.numPlays)) : '-'],
      ['fcTL 块数量', String(doc.chunkCounts.fcTL || 0)],
      ['默认图', doc.hasDefaultImage ? '有（IDAT，静态场景显示它）' : '无'],
      ['末尾 1x1 补帧', hasTail ? '有（blend=OVER，画面零变化）' : '无'],
      ['块顺序', order],
      ['CRC 校验', doc.crcAllOk ? '全部通过' : '存在错误'],
    ];

    let hint = '当前只有一帧，等价于普通静态 PNG';
    if (doc.isApng && doc.hasDefaultImage) {
      hint = hasTail
        ? `结构与样本一致：桌面 / 预览显示第 0 帧，浏览器打开或查看原图播放这 ${playCount} 个动画帧，末尾 1x1 补帧只负责让播放器真正循环起来`
        : `结构符合伪装图要求：桌面 / 预览显示第 0 帧，浏览器打开或查看原图播放这 ${playCount} 个动画帧`;
    } else if (doc.isApng) {
      hint = '没有独立静态封面：IDAT 本身就是动画第 1 帧';
    }

    resultHost.append(
      el('div', { class: 'section__title', text: '生成结果自检' }),
      el('div', { class: 'kv' }, ...rows.map(([key, value]) => displayRow(key, value))),
      el('div', { class: 'note muted', text: hint }),
    );
  }

  /** 在页面上按设定延迟循环播放：第 0 帧（默认图）+ 后面所有动画帧 */
  function startPreview() {
    const picked = requireAllFrames();
    if (!picked) return;
    stopPreview();
    const playOrder = [picked.frame0, ...picked.anim];
    const opts = options.read();
    const { width, height } = resolveSize(opts);
    if (!width || !height) {
      toast('画布尺寸无效，请检查尺寸设置', 'error');
      return;
    }
    const scale = Math.min(1, 420 / Math.max(width, height));
    const viewW = Math.max(1, Math.round(width * scale));
    const viewH = Math.max(1, Math.round(height * scale));
    previewCanvas.width = viewW;
    previewCanvas.height = viewH;
    const ctx = context2d(previewCanvas, { readFrequently: true });

    state.previewFrames = playOrder.map((frame) => {
      const data = fitImageData(frame.imageData, width, height, opts.fitMode);
      const full = createCanvas(width, height, { readFrequently: true });
      context2d(full, { readFrequently: true }).putImageData(data, 0, 0);
      return full;
    });

    let show = 0;
    const draw = () => {
      ctx.clearRect(0, 0, viewW, viewH);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(state.previewFrames[show], 0, 0, viewW, viewH);
      previewInfo.textContent = [
        `当前显示：第 ${show} 帧（${show === 0 ? '默认图' : '动画帧'}）`,
        `共 ${state.previewFrames.length} 帧`,
        `画布：${width} x ${height}`,
        `延迟：${opts.delayMs} ms`,
        `循环：${opts.numPlays === 0 ? '无限' : opts.numPlays}`,
      ].join('   ');
    };
    draw();
    state.previewTimer = setInterval(() => {
      show = (show + 1) % state.previewFrames.length;
      draw();
    }, Math.max(50, opts.delayMs || DISGUISE_DEFAULTS.delayMs));
    toast(`开始播放预览（${state.previewFrames.length} 帧）`, 'info');
  }

  function stopPreview() {
    if (state.previewTimer) {
      clearInterval(state.previewTimer);
      state.previewTimer = null;
    }
  }
}

/** 信息行 */
function displayRow(key, value) {
  return el('div', { class: 'kv__row' },
    el('span', { class: 'kv__k', text: key }),
    el('span', { class: 'kv__v mono', text: value }),
  );
}


