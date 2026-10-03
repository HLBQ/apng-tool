/**
 * dropzone.js —— 可复用的「拖拽 / 点击选择文件」区域
 */

import { el } from '../utils/dom.js';

/**
 * @param {Object} options
 * @param {string} options.title
 * @param {string} [options.hint]
 * @param {boolean} [options.multiple]
 * @param {string} [options.accept]
 * @param {(files:File[])=>void} options.onFiles
 * @returns {HTMLElement}
 */
export function createDropzone({ title, hint = '', multiple = false, accept = 'image/png,.png', onFiles, compact = false }) {
  const input = el('input', { type: 'file', accept, multiple, style: { display: 'none' } });
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) onFiles(files);
  });

  const zone = el('div', { class: `dropzone${compact ? ' dropzone--compact' : ''}`, role: 'button', tabindex: '0' },
    el('div', { class: 'dropzone__icon', text: '+' }),
    el('div', { class: 'dropzone__title', text: title }),
    hint ? el('div', { class: 'dropzone__hint', text: hint }) : null,
    input,
  );

  const open = () => input.click();
  zone.addEventListener('click', open);
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  let depth = 0;
  zone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    depth += 1;
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragover', (event) => event.preventDefault());
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.classList.remove('is-over');
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    zone.classList.remove('is-over');
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  });

  return zone;
}
