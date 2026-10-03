/**
 * format-loader.js —— 输入图片的「格式识别」与「非原生格式转换」
 *
 * 策略（两级）：
 *   1. 常见格式（PNG / JPEG / GIF / WebP / BMP / AVIF / ICO / SVG）浏览器可原生解码，
 *      直接交给 canvas 完成转换，完全离线，不需要任何依赖。
 *   2. 浏览器搞不定的格式（TIFF、HEIC/HEIF），按需从 CDN 加载解析库（网络库），
 *      只在真正遇到该格式时才下载，离线时会给出明确错误提示。
 */

/** 按需加载的网络库清单 */
export const CDN_LIBRARIES = {
  tiff: {
    url: 'https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.min.js',
    globalName: 'UTIF',
    label: 'UTIF（TIFF 解析库）',
  },
  heic: {
    url: 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
    globalName: 'heic2any',
    label: 'heic2any（HEIC 转换库）',
  },
};

/** 魔数比对 */
function startsWith(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function asciiAt(bytes, offset, text) {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 通过魔数识别格式。
 * @param {Uint8Array} bytes
 * @returns {{id:string,mime:string,label:string,native:boolean}}
 */
export function detectFormat(bytes) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { id: 'png', mime: 'image/png', label: 'PNG', native: true };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { id: 'jpeg', mime: 'image/jpeg', label: 'JPEG', native: true };
  }
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) {
    return { id: 'gif', mime: 'image/gif', label: 'GIF', native: true };
  }
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) {
    return { id: 'webp', mime: 'image/webp', label: 'WebP', native: true };
  }
  if (startsWith(bytes, [0x42, 0x4d])) {
    return { id: 'bmp', mime: 'image/bmp', label: 'BMP', native: true };
  }
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) {
    return { id: 'ico', mime: 'image/x-icon', label: 'ICO', native: true };
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { id: 'tiff', mime: 'image/tiff', label: 'TIFF', native: false };
  }
  if (asciiAt(bytes, 4, 'ftyp')) {
    if (asciiAt(bytes, 8, 'avif') || asciiAt(bytes, 8, 'avis')) {
      return { id: 'avif', mime: 'image/avif', label: 'AVIF', native: true };
    }
    if (asciiAt(bytes, 8, 'heic') || asciiAt(bytes, 8, 'heix') || asciiAt(bytes, 8, 'mif1') || asciiAt(bytes, 8, 'hevc')) {
      return { id: 'heic', mime: 'image/heic', label: 'HEIC', native: false };
    }
  }
  if (asciiAt(bytes, 0, '<svg') || asciiAt(bytes, 0, '<?xml') || asciiAt(bytes, 0, '<!DOCTYPE svg')) {
    return { id: 'svg', mime: 'image/svg+xml', label: 'SVG', native: true };
  }
  return { id: 'unknown', mime: 'application/octet-stream', label: '未知格式', native: true };
}

const scriptCache = new Map();

/**
 * 按需注入 CDN 脚本（同一地址只加载一次）。
 * @param {string} url
 * @returns {Promise<void>}
 */
export function loadScript(url) {
  if (scriptCache.has(url)) return scriptCache.get(url);
  const task = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`网络库加载失败（请检查网络）：${url}`));
    document.head.append(script);
  });
  scriptCache.set(url, task);
  return task;
}

/**
 * 确保某个 CDN 库已就绪，返回其全局对象。
 * @param {'tiff'|'heic'} key
 * @param {(ratio:number,message:string)=>void} [onProgress]
 */
export async function ensureLibrary(key, onProgress) {
  const lib = CDN_LIBRARIES[key];
  if (!lib) throw new Error(`未登记的库：${key}`);
  if (window[lib.globalName]) return window[lib.globalName];
  if (onProgress) onProgress(0, `正在加载网络库 ${lib.label}`);
  await loadScript(lib.url);
  if (onProgress) onProgress(1, `${lib.label} 已就绪`);
  const instance = window[lib.globalName];
  if (!instance) throw new Error(`${lib.label} 加载后未挂载到全局，无法使用`);
  return instance;
}

/** 该格式是否需要网络库 */
export function needsNetworkLibrary(formatId) {
  return formatId === 'tiff' || formatId === 'heic';
}
