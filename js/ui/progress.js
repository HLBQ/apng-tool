/**
 * progress.js —— 统一的进度回调契约与「进度弹窗」
 *
 * 全项目所有「批量 / 转换 / 编码」步骤都必须通过 onProgress 上报进度，
 * onProgress 的签名统一为：
 *   (info: { phase: string, ratio: number, message: string, done?: number, total?: number }) => void
 * 其中 ratio 恒为 0 ~ 1。
 *
 * 展示方式：进度条不再写在页面流里（会顶动内容、每个卡片都塞一条），
 * 而是统一挂进一个悬浮弹窗 #progress-pop：
 *   - 只要有进度在跑，弹窗自动出现；全部完成后自动收起
 *   - 同一时刻多条进度按添加顺序排列，互不覆盖
 */

import { el } from '../utils/dom.js';

/** 进度弹窗宿主（全页面共用一个，挂在 body 上） */
let popup = null;
/** 所有创建过的进度条，用于切换面板时统一摘掉 */
const instances = new Set();

/** 取得（必要时创建）进度弹窗宿主 */
function ensurePopup() {
  if (popup) return popup;
  const list = el('div', { class: 'progress-pop__list' });
  const btnHide = el('button', { class: 'btn btn--ghost', type: 'button', text: '收起' });
  const root = el('div', { class: 'progress-pop', id: 'progress-pop', hidden: true },
    el('div', { class: 'progress-pop__head' },
      el('div', { class: 'progress-pop__title', text: '进度' }),
      btnHide,
    ),
    list,
  );
  btnHide.addEventListener('click', () => {
    root.hidden = true;
  });
  document.body.append(root);
  popup = { root, list };
  return popup;
}

/** 只要有可见的进度行就露出弹窗，全空闲自动收起 */
function syncPopup() {
  if (!popup) return;
  const rows = Array.from(popup.list.children);
  popup.root.hidden = !rows.some((row) => !row.hidden);
}

/**
 * 清空进度弹窗（切换面板时调用，避免上一个面板的进度残留）。
 * 被清掉的进度条若之后再次上报，会自动重新挂回来。
 */
export function clearProgressPopup() {
  if (!popup) return;
  instances.forEach((api) => api.detach());
  while (popup.list.firstChild) popup.list.removeChild(popup.list.firstChild);
  syncPopup();
}

/**
 * 生成一个安全的进度上报函数。
 * @param {Function|null} onProgress
 * @param {string} phase
 * @returns {(ratio:number, message?:string, extra?:Object)=>void}
 */
export function reporter(onProgress, phase) {
  return (ratio, message, extra) => {
    if (typeof onProgress !== 'function') return;
    onProgress({
      phase,
      ratio: Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)),
      message: message || '',
      ...(extra || {}),
    });
  };
}

/**
 * 页面内嵌进度条 → 现在统一挂在悬浮进度弹窗（#progress-pop）里。
 * 页面流里不再出现任何进度条，避免顶动内容、每个卡片都塞一条。
 * @param {string} [label]
 */
export function createProgress(label = '') {
  // 先把弹窗外壳准备好（挂在 body 上、默认收起），保证样式与 id 从一开始就稳定
  ensurePopup();
  const text = el('div', { class: 'progress__text', text: label });
  const fill = el('div', { class: 'progress__fill' });
  const root = el('div', { class: 'progress', hidden: true },
    text,
    el('div', { class: 'progress__track' }, fill),
  );

  let attachedTo = null;

  /** 把自己挂进弹窗（切换面板后被清掉的行会在下次上报时自动回来） */
  function attach() {
    const host = ensurePopup();
    if (attachedTo === host.list) return;
    host.list.append(root);
    attachedTo = host.list;
  }

  const api = {
    root,
    /** 显示并设置进度 */
    set(ratio, message) {
      attach();
      root.hidden = false;
      const safe = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
      fill.style.width = `${(safe * 100).toFixed(2)}%`;
      text.textContent = message || label;
      root.dataset.state = 'running';
      syncPopup();
    },
    /** 直接消费 onProgress 回调对象 */
    apply(info) {
      api.set(info.ratio, info.message);
    },
    done(message) {
      api.set(1, message || label || '完成');
      root.dataset.state = 'done';
      setTimeout(() => {
        if (root.dataset.state === 'done') api.reset();
      }, 1200);
    },
    fail(message) {
      attach();
      root.hidden = false;
      root.dataset.state = 'error';
      text.textContent = message || '失败';
      syncPopup();
    },
    reset() {
      root.hidden = true;
      root.dataset.state = '';
      fill.style.width = '0%';
      text.textContent = label;
      syncPopup();
    },
    /** 从弹窗里摘掉（切换面板时由 clearProgressPopup 调用） */
    detach() {
      attachedTo = null;
      root.hidden = true;
      root.dataset.state = '';
      fill.style.width = '0%';
      text.textContent = label;
    },
  };

  instances.add(api);
  return api;
}
