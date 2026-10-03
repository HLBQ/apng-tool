# apng-tool —— APNG 伪装图分析与制作

浏览器直接打开即可运行的前端工具，没有任何 npm 依赖、没有构建步骤。


## 目录结构

```
apng-tool/
  index.html              页面入口
  start-server.bat        本地起静态服务（Python http.server）
  package.json            npm run test / npm run verify:python
  css/style.css
  js/
    main.js               入口脚本，挂载两个面板
    core/
      crc32.js            CRC32 表 + 计算
      pngchunks.js        PNG 签名、块解析/构造、IHDR/fcTL/acTL/tEXt 读写
      zlib.js             DEFLATE 解压（fixed/stored 全支持）与压缩（CompressionStream + stored 回退）
      zip.js              无压缩 ZIP 打包（导出全部帧用）
      apng-decoder.js     inspect() 结构解析 + 逐帧渲染（renderAllFrames / renderFrameAt）
      apng-encoder.js     encodeApng() / encodeDisguiseApng() / DISGUISE_DEFAULTS
      image-io.js         文件 -> RGBA 像素（非 PNG 自动转 PNG），带进度回调
    ui/
      analyze-view.js     面板 1：查看与导出
      create-view.js      面板 2：制作伪装图
      dropzone.js  modal.js  progress.js  toast.js
    utils/
      dom.js  format.js  image.js  download.js
    vendor/
      format-loader.js    TIFF / HEIC 需要时再从 CDN 加载解码库
```

## 运行

双击 `start-server.bat`（内部是 `python -m http.server 8080`），然后访问 http://localhost:8080
浏览器若允许 `file://` 下的 ES Module，也可以直接双击 `index.html`。


## 已知限制

- 输出固定为 8bit RGBA、非隔行、颜色类型 6，单个 `IDAT`/`fdAT`，不做调色板与隔行编码
- 解析阶段依赖浏览器原生 PNG 解码，不自己实现反隔行与调色板展开
- 压缩优先用 `CompressionStream('deflate')`，环境不支持时退化为 stored 块（合法但体积更大）
- TIFF / HEIC 需要首次联网从 CDN 加载解码库，其余格式完全离线可用
- 生成的是标准 APNG，不修改文件签名或伪装扩展名，能否“骗过”某个具体软件取决于它读的是 `IDAT` 还是播放动画

