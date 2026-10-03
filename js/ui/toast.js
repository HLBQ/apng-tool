/**
 * toast.js —— 轻量提示条（纯文本，不使用任何特殊符号）
 */

import { el, $ } from '../utils/dom.js';

const TYPE_LABELS = { info: '提示', success: '完成', warn: '注意', error: '错误' };

function ensureHost() {
  let host = $('#toast-host');
  if (!host) {
    host = el('div', { id: 'toast-host', class: 'toast-host' });
    document.body.append(host);
  }
  return host;
}

/**
 * @param {string} message
 * @param {'info'|'success'|'warn'|'error'} [type]
 * @param {number} [timeout] 毫秒，0 表示不自动关闭
 */
export function toast(message, type = 'info', timeout = 3600) {
  const host = ensureHost();
  const node = el('div', { class: `toast toast--${type}` },
    el('span', { class: 'toast__tag', text: `[${TYPE_LABELS[type] || TYPE_LABELS.info}]` }),
    el('span', { class: 'toast__text', text: message }),
  );
  host.append(node);
  requestAnimationFrame(() => node.classList.add('is-in'));
  if (timeout > 0) {
    setTimeout(() => {
      node.classList.remove('is-in');
      setTimeout(() => node.remove(), 300);
    }, timeout);
  }
  return () => node.remove();
}

