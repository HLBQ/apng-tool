/**
 * image-io.js —— 输入图片的读取 / 格式转换 / PNG 输出，全部带进度回调
 *
 * 对外主入口：
 *   loadImageDataFromFile(file, { onProgress })
 *     → { imageData, format, converted, note }
 * 保证：无论用户传进来的是 JPEG / GIF / WebP / BMP / AVIF 还是 TIFF、HEIC，
 *       最终都会变成浏览器内部的 RGBA 像素，供后续帧渲染或 APNG 编码使用。
 */

import { decodeImage, createCanvas, context2d } from '../utils/image.js';
import { detectFormat, ensureLibrary } from '../vendor/format-loader.js';
import { reporter } from '../ui/progress.js';

/**
 * 带进度的文件读取。
 * @param {File} file
 * @param {(ratio:number)=>void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export function readFileBytes(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (!onProgress) return;
      onProgress(event.lengthComputable && event.total ? event.loaded / event.total : 0);
    };
    reader.onload = () => {
      if (onProgress) onProgress(1);
      resolve(new Uint8Array(reader.result));
    };
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

/** 把裸 RGBA 数组包成 ImageData（兼容不支持 ImageData 构造函数的旧环境） */
export function toImageData(rgba, width, height) {
  const data = rgba instanceof Uint8ClampedArray ? rgba : Uint8ClampedArray.from(rgba);
  if (typeof ImageData === 'function') {
    try {
      return new ImageData(data, width, height);
    } catch (error) {
      console.warn('[image-io] ImageData 构造失败，改用 canvas 包装：', error);
    }
  }
  const canvas = createCanvas(width, height, { readFrequently: true });
  const ctx = context2d(canvas, { readFrequently: true });
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(data);
  return imageData;
}

/** 交给浏览器原生解码任意图片字节 → ImageData */
export async function decodeBytesNatively(bytes, mime) {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const drawable = await decodeImage(blob);
  const width = drawable.width || drawable.naturalWidth || 0;
  const height = drawable.height || drawable.naturalHeight || 0;
  if (!width || !height) {
    throw new Error('无法确定图像尺寸（矢量图可能需要指定 width/height）');
  }
  const canvas = createCanvas(width, height, { readFrequently: true });
  const ctx = context2d(canvas, { readFrequently: true });
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(drawable, 0, 0);
  if (typeof drawable.close === 'function') drawable.close();
  return ctx.getImageData(0, 0, width, height);
}

/** TIFF：走 CDN 上的 UTIF 解析 */
async function decodeTiff(bytes, report) {
  const UTIF = await ensureLibrary('tiff', (ratio, message) => report(0.45 + ratio * 0.12, message));
  report(0.62, '正在解析 TIFF 数据');
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const ifds = UTIF.decode(buffer);
  if (!ifds || !ifds.length) throw new Error('TIFF 中没有可用的图像帧');
  UTIF.decodeImage(buffer, ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]);
  report(0.85, '正在转换为 RGBA 像素');
  return toImageData(Uint8ClampedArray.from(rgba), ifds[0].width, ifds[0].height);
}

/** HEIC / HEIF：走 CDN 上的 heic2any 转成 PNG 后再解码 */
async function decodeHeic(bytes, report) {
  const heic2any = await ensureLibrary('heic', (ratio, message) => report(0.45 + ratio * 0.12, message));
  report(0.62, '正在解码 HEIC');
  const blob = new Blob([bytes], { type: 'image/heic' });
  const pngBlob = await heic2any({ blob, toType: 'image/png', multiple: false });
  report(0.85, '正在转换为 RGBA 像素');
  return decodeBytesNatively(new Uint8Array(await pngBlob.arrayBuffer()), 'image/png');
}

/**
 * 读取任意图片文件并转换为 RGBA 像素（全程上报进度）。
 * @param {File} file
 * @param {Object} [options]
 * @param {Function} [options.onProgress] 进度回调
 * @param {boolean} [options.allowNetworkLibrary=true] 允许按需加载 CDN 网络库
 * @returns {Promise<{file:File, imageData:ImageData, width:number, height:number, format:Object, converted:boolean, note:string, bytes:Uint8Array}>}
 */
export async function loadImageDataFromFile(file, options = {}) {
  const { onProgress = null, allowNetworkLibrary = true } = options;
  const report = (ratio, message) => reporter(onProgress, 'load')(ratio, message);

  report(0, `读取文件 ${file.name}`);
  const bytes = await readFileBytes(file, (ratio) => report(ratio * 0.35, `读取文件 ${file.name}`));
  const format = detectFormat(bytes);
  report(0.35, `识别格式：${format.label}`);

  let imageData = null;
  let note = '';

  if (format.id === 'tiff' || format.id === 'heic') {
    if (!allowNetworkLibrary) throw new Error(`${format.label} 需要网络解析库，当前已禁用`);
    imageData = format.id === 'tiff' ? await decodeTiff(bytes, report) : await decodeHeic(bytes, report);
    note = `${format.label} 已经由网络库转换为 PNG 像素`;
  } else {
    try {
      report(0.45, `浏览器原生解码 ${format.label}`);
      imageData = await decodeBytesNatively(bytes, format.mime);
      note = format.id === 'png' ? 'PNG 原生解析' : `${format.label} 已转换为 PNG 像素`;
    } catch (error) {
      if (!allowNetworkLibrary) throw error;
      report(0.45, `原生解码失败，改用网络库：${format.label}`);
      try {
        imageData = await decodeHeic(bytes, report);
        note = `${format.label} 已经由网络库转换为 PNG 像素`;
      } catch (fallbackError) {
        throw new Error(`无法解码该文件（${format.label}）：${error.message}`);
      }
    }
  }

  if (!imageData || !imageData.width || !imageData.height) {
    throw new Error(`无法得到有效像素：${file.name} 的尺寸为 0`);
  }
  report(1, `${file.name} 处理完成（${imageData.width}x${imageData.height}）`);
  // width / height / file 单独给一份，调用方不用每次都去读 imageData 或自己记住来源文件
  return {
    file,
    imageData,
    width: imageData.width,
    height: imageData.height,
    format,
    converted: format.id !== 'png',
    note,
    bytes,
  };
}

/**
 * ImageData → PNG 字节（导出 / 生成文件时使用）。
 * @param {ImageData} imageData
 * @param {Function} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function imageDataToPngBytes(imageData, onProgress) {
  const report = (ratio, message) => reporter(onProgress, 'encode')(ratio, message);
  report(0.1, '绘制到画布');
  const canvas = createCanvas(imageData.width, imageData.height);
  context2d(canvas).putImageData(imageData, 0, 0);
  report(0.4, 'PNG 编码中');
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('PNG 编码失败'))), 'image/png');
  });
  report(0.9, '写出字节流');
  const buffer = await blob.arrayBuffer();
  report(1, 'PNG 编码完成');
  return new Uint8Array(buffer);
}
