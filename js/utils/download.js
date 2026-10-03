/**
 * download.js —— 本地下载工具（全部离线，不发起任何网络请求）
 */

/**
 * 触发浏览器下载。
 * @param {Blob|Uint8Array|string} data
 * @param {string} fileName
 * @param {string} [mime]
 */
export function download(data, fileName, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1500);
}

/** canvas → Blob(PNG) */
export function canvasToBlob(canvas, mime = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob 返回空值，导出失败'));
    }, mime, quality);
  });
}

/** canvas → Uint8Array(PNG) */
export async function canvasToBytes(canvas) {
  const blob = await canvasToBlob(canvas);
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 把「文件名 → PNG 字节」打成一份 zip 下载（避免浏览器拦截多文件下载）。
 * @param {string} zipName
 * @param {Array<{name:string,data:Uint8Array}>} entries
 */
export async function downloadZip(zipName, entries) {
  const { buildZip } = await import('../core/zip.js');
  download(buildZip(entries), zipName, 'application/zip');
}
