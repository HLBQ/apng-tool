/**
 * image.js —— 浏览器图像解码 / 画布小工具
 */

/**
 * Blob/Uint8Array → 可 drawImage 的对象（ImageBitmap 或 HTMLImageElement）。
 * @param {BlobPart} source
 * @returns {Promise<ImageBitmap|HTMLImageElement>}
 */
export async function decodeImage(source) {
  const blob = source instanceof Blob ? source : new Blob([source], { type: 'image/png' });

  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch (error) {
      console.warn('[image] createImageBitmap 失败，改用 <img> 解码：', error);
    }
  }
  return await decodeWithImgTag(blob);
}

function decodeWithImgTag(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      // 图像已解码完成，可以安全释放 URL
      setTimeout(() => URL.revokeObjectURL(url), 0);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图像解码失败，可能不是浏览器支持的图像格式'));
    };
    img.src = url;
  });
}

/** 创建画布（宽高强制为不小于 1 的整数） */
export function createCanvas(width, height, { readFrequently = false } = {}) {
  const canvas = document.createElement('canvas');
  // 传 undefined / NaN / 0 会让画布变成 0 尺寸，之后 drawImage 会直接抛
  // "The image argument is a canvas element with a width or height of 0"，所以这里兜一层
  canvas.width = Math.max(1, Math.round(Number(width)) || 1);
  canvas.height = Math.max(1, Math.round(Number(height)) || 1);
  canvas.getContext('2d', { willReadFrequently: readFrequently });
  return canvas;
}

/** 取 2D 上下文（带常用设置） */
export function context2d(canvas, { readFrequently = false } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: readFrequently, alpha: true });
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');
  return ctx;
}

/**
 * 把 ImageData 适配到目标尺寸（用于「第 1 帧」与「第 0 帧」尺寸不一致时）。
 * @param {ImageData} imageData
 * @param {number} width
 * @param {number} height
 * @param {'stretch'|'contain'|'cover'} fit
 * @param {string} [background] 例：'#0000' 透明 / '#ffffff'
 * @returns {ImageData}
 */
export function fitImageData(imageData, width, height, fit = 'cover', background = null) {
  const src = createCanvas(imageData.width, imageData.height, { readFrequently: true });
  context2d(src, { readFrequently: true }).putImageData(imageData, 0, 0);

  const dst = createCanvas(width, height, { readFrequently: true });
  const ctx = context2d(dst, { readFrequently: true });
  ctx.clearRect(0, 0, width, height);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  if (fit === 'stretch') {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, width, height);
  } else {
    const scale = fit === 'contain'
      ? Math.min(width / imageData.width, height / imageData.height)
      : Math.max(width / imageData.width, height / imageData.height);
    const w = imageData.width * scale;
    const h = imageData.height * scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (width - w) / 2, (height - h) / 2, w, h);
  }

  return ctx.getImageData(0, 0, width, height);
}

/** 按最长边生成缩略图（返回新的 canvas） */
export function thumbnail(sourceCanvas, maxSide = 180) {
  const scale = Math.min(1, maxSide / Math.max(sourceCanvas.width, sourceCanvas.height));
  const canvas = createCanvas(Math.max(1, Math.round(sourceCanvas.width * scale)), Math.max(1, Math.round(sourceCanvas.height * scale)));
  const ctx = context2d(canvas);
  ctx.imageSmoothingQuality = 'high';
  // 用棋盘格背景，便于观察透明区域
  drawCheckerboard(ctx, canvas.width, canvas.height, 8);
  ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** 画透明棋盘格 */
export function drawCheckerboard(ctx, width, height, size = 8) {
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      const dark = ((x / size) + (y / size)) % 2 === 0;
      ctx.fillStyle = dark ? '#e4e4e4' : '#ffffff';
      ctx.fillRect(x, y, size, size);
    }
  }
}
