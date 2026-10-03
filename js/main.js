/**
 * main.js —— 应用入口：能力检测 + Tab 路由 + 按需挂载面板
 */

import { mountAnalyzeView } from './ui/analyze-view.js';
import { mountCreateView } from './ui/create-view.js';
import { toast } from './ui/toast.js';
import { closeModal, openModal } from './ui/modal.js';
import { $, $$, el } from './utils/dom.js';
import { hasNativeCompression } from './core/zlib.js';
import { CDN_LIBRARIES } from './vendor/format-loader.js';

/** 面板注册表（多模块按需挂载，切到哪个才初始化哪个） */
const PANELS = {
  analyze: { id: 'panel-analyze', mount: mountAnalyzeView, mounted: false },
  create: { id: 'panel-create', mount: mountCreateView, mounted: false },
};

function switchTab(name) {
  if (!PANELS[name]) return;
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === name));
  $$('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.id === PANELS[name].id));

  const panel = PANELS[name];
  if (!panel.mounted) {
    const host = $(`#${panel.id}`);
    if (!host) return;
    panel.mount(host);
    panel.mounted = true;
  }
  if (location.hash.slice(1) !== name) {
    history.replaceState(null, '', `#${name}`);
  }
}

/** 浏览器能力检测并展示 */
function reportEnvironment() {
  const info = $('#env-info');
  if (!info) return;
  const bits = [];
  bits.push(hasNativeCompression() ? '压缩：原生' : '压缩：降级');
  if (typeof createImageBitmap === 'function') bits.push('解码：ImageBitmap');
  else bits.push('解码：img');
  if (typeof ImageData === 'function') bits.push('ImageData：可用');
  const offlineLibs = Object.values(CDN_LIBRARIES).map((lib) => lib.label.split('（')[0]).join('/');
  bits.push(`网络库（按需）：${offlineLibs}`);
  info.textContent = bits.join('   ');

  if (!hasNativeCompression()) {
    toast('当前浏览器不支持原生压缩，将使用存储型 deflate，生成的文件体积会偏大', 'warn', 7000);
  }
}

/** 首次打开时提醒一次：这工具做了什么、数据有没有出本机 */
const INTRO_KEY = 'apng-tool:intro-shown';

function hasSeenIntro() {
  try {
    return localStorage.getItem(INTRO_KEY) === '1';
  } catch (_error) {
    return false;
  }
}

function rememberIntro() {
  try {
    localStorage.setItem(INTRO_KEY, '1');
  } catch (_error) {
    // 隐私模式 / file:// 下写不进去也没关系，最多下次再提醒一次
  }
}

function showIntroOnce() {
  if (hasSeenIntro()) return;
  const done = el('button', { class: 'btn btn--primary', type: 'button', text: '知道了', onclick: closeModal });
  const body = el('div', { class: 'notice' },
    el('h3', { class: 'notice__title', text: '先说明一下' }),
    el('p', {
      class: 'notice__text',
      text: '本工具按 PNG 规范直接读写字节流：可解析任意 PNG / APNG 的块结构与每一帧画面，也能按「第 0 帧 + 第 1 帧 + 更多帧」生成伪装图。',
    }),
    el('p', {
      class: 'notice__text muted',
      text: '所有处理都在本地浏览器内完成，不会上传任何文件；这条提醒只在首次打开时出现一次。',
    }),
    el('div', { class: 'notice__actions' }, done),
  );
  openModal(body);
  rememberIntro();
}

function init() {
  reportEnvironment();

  $('#tabs')?.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) switchTab(tab.dataset.tab);
  });

  const initial = location.hash.slice(1);
  switchTab(PANELS[initial] ? initial : 'analyze');

  // 面板挂好之后再弹首次说明，保证它盖在最上层
  showIntroOnce();

  window.addEventListener('error', (event) => {
    console.error(event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error(event.reason);
    toast(`发生未处理的错误：${event.reason && event.reason.message ? event.reason.message : event.reason}`, 'error', 6000);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
