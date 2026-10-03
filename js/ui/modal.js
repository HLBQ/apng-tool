/**
 * modal.js —— 查看大图 / 预览弹层
 */

import { el } from '../utils/dom.js';

let current = null;

/** @param {HTMLCanvasElement|HTMLElement} content @param {string} [caption] */
export function openModal(content, caption = '') {
  closeModal();
  const body = el('div', { class: 'modal__body' }, content);
  const root = el('div', { class: 'modal', onclick: (event) => { if (event.target === root) closeModal(); } },
    el('div', { class: 'modal__panel' },
      el('button', { class: 'modal__close', type: 'button', text: 'X', onclick: closeModal }),
      body,
      caption ? el('div', { class: 'modal__caption', text: caption }) : null,
    ),
  );
  document.body.append(root);
  document.body.classList.add('is-locked');
  current = root;

  const onKey = (event) => { if (event.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);
  root._onKey = onKey;
  return root;
}

export function closeModal() {
  if (!current) return;
  document.removeEventListener('keydown', current._onKey);
  document.body.classList.remove('is-locked');
  current.remove();
  current = null;
}

/** 便捷：在弹层里显示一张画布（复制一份，避免与原画布共享像素） */
export function openCanvasModal(canvas, caption) {
  const view = document.createElement('canvas');
  view.width = canvas.width;
  view.height = canvas.height;
  view.className = 'modal__canvas';
  view.getContext('2d').drawImage(canvas, 0, 0);
  return openModal(view, caption);
}
