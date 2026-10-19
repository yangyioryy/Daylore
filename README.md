# 拾页 · Daylore

一本复古拟物的私人日记。纯 HTML、CSS、JavaScript，无框架、无构建和运行依赖。

## 预览

直接用浏览器打开 `index.html`。也可在项目目录运行：

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

访问 `http://127.0.0.1:4173`。建议固定使用同一地址和端口；不同来源的浏览器存储彼此独立，`file://` 的存储行为取决于浏览器。

## 使用

- 点击封面：打开封面，再自动连翻三页，停在今天。
- 右页直接书写，停止输入 300ms 后保存。支持中文输入法和 `Ctrl+S`。
- 点击天气图标在晴、阴、雨、雪之间轮换。
- 左页日历选日期，有正文的日期下方显示圆点。月份箭头只调整日历。
- 点击日历、上一天、下一天或回到今天，会按日期方向翻动纸页；中途锁定操作，旧页先保存。
- 底角翻前后一天，书签回到今天。
- 左页寄语会请求随机短句，点击“一日一笺 ↻”可换一句；网络不可用时使用本地治愈短句。
- 点击右下角印章，选择开心、平静、疲惫、迷茫、期待、低落；心情立即保存并显示在月历上，也可更换或移除。
- 右上暗红丝带合上日记：先保存，再播放合上动画；浏览器可再次翻开。
- 翻开/翻页播放 `asset/flip.mp3`，合上播放 `asset/close.mp3`；音量较轻，播放被浏览器拒绝或素材缺失时不影响使用。
- 保存失败会保留当前内容，阻止带着未保存文字翻页或合上，恢复存储权限/空间后点击“重试保存”。

日记只保存在当前浏览器的 `localStorage`，不会上传。清理站点数据、使用临时浏览器会话或更换来源可能导致日记不可用。当前原型不包含云同步、文件导出或加密。

## 素材与兜底

默认读取 `asset/cover.png`、`asset/paper.png`、`asset/font.ttf`。皮革、金色内框和泛黄纸张均有 CSS 兜底，字体回退为 `Kaiti`、`STKaiti`、`serif`。`body` 保持透明；浏览器本身可能仍以白色呈现透明背景。

## 数据接口

`diary-core.js` 通过 `window.DiaryCore` 暴露：

```javascript
const { saveDiary, loadDiary } = window.DiaryCore;
saveDiary('2026-10-19', { content: '今日的小事。', weather: 'sunny', mood: 'happy' });
const diary = loadDiary('2026-10-19');
// { content, weather, mood, updatedAt }
```

键为本地日期 `YYYY-MM-DD`，`updatedAt` 为保存时的 ISO 时间字符串。天气值：`sunny`、`cloudy`、`rainy`、`snowy`。心情值：`happy`、`calm`、`tired`、`confused`、`hopeful`、`sad`，未盖章为 `null`；旧记录没有心情字段也可直接读取。每次保存应带上当前心情，省略时按未盖章保存。无记录返回空正文、晴天、`mood: null`、`updatedAt: null`。接口同步返回，保存/读取失败抛异常，界面负责提示。损坏记录保留原值并禁用该日编辑，以防覆盖。

## 随机寄语与声音

`diary-services.js` 独立封装外部请求和声音。寄语调用 `GET https://uapis.cn/api/v1/saying` 的顶层 `text` 字段，不发送日记正文、日期或心情。接口是随机名言语料，无法保证每条都为治愈主题；客户端会过滤 HTML 和控制字符，限制最多 32 个 Unicode 码点（窄屏优先 16 字短句），过长只接受完整短首句，否则重试后回退本地文案。总超时 1.6 秒，翻书动画不等待请求，过期响应不能覆盖新页面。

本地音效复用播放器、音量 0.25，同类音效不会因连点叠加；自动播放策略或解码错误不会阻断保存和翻阅。

在线寄语建议通过上面的本地 HTTP 地址预览。接口对 `file://` 的空来源可能不允许跨域，此时自动使用本地随机短句，不影响日记。原合书素材实际为 M4A/AAC，保留在 `asset/close-source.m4a`，播放用 `close.mp3` 已转为标准 MP3。

本机启用 IDM 等媒体接管软件时，HTTP 页面里的音效请求可能被下载器接管；直接双击本地页面播放音效不会发起 HTTP 媒体请求。自动化验收使用完整无网络播放器替身，音频文件另以本地解码验证，不修改下载器设置。

后续接入 Tauri fs 时替换上述两个函数与日历查询即可；若采用异步 API，应同时把交互层的保存/读取链改为 `async/await`，确保保存完成后再翻页和退出。

## Tauri 接入预留

当前交付是网页原型，没有 Tauri 工程或打包产物。后续窗口配置应启用透明、无边框和全局 Tauri API，并设置合适窗口尺寸与窗口关闭权限。

- 皮革外框预留 `data-tauri-drag-region`，交互按钮和正文不属于拖动区域。
- v2 检测 `window.__TAURI__.window.getCurrentWindow().close()`。
- v1 检测 `window.__TAURI__.window.appWindow.close()`，并兼容 `getCurrent()`。
- 关闭 API 只在保存成功且约 800ms 合上动画结束后调用；缺少权限或 API 会在页面显示失败信息。
- 浏览器环境仅合上，不主动关闭标签页。

## 验证

需要 Node.js 24；无需安装 npm 包。

```powershell
npm test
npm run check
npm run test:browser
```

浏览器测试使用本机 Chrome/Edge 无头模式和 Node 内置 CDP 客户端，自动启动临时本地服务器与独立浏览器资料目录，不使用个人浏览器数据。可用环境变量 `DAYLORE_BROWSER` 指定浏览器可执行文件。测试设置 60 秒上限。

计划与真实验收结果见 `plan/开发计划-10-19.md`、`doc/开发进度-10-19.md`。

第二轮验收：31 项单元测试、三个应用 JS 语法检查、13 个浏览器子场景及父测试全部通过（浏览器报告 14/14）。涵盖心情持久化、API 异常兜底、日期翻页和开合中间态。音效调用由完整 FakeAudio 验证，两份 MP3 另经本地 FFmpeg 完整解码，未做真实扬声器听音。本次浏览器媒体请求为零，下载目录前后无变化。

验收截图：[合上封面](doc/验收-合上.png)、[展开书写](doc/验收-展开.png)、[火漆心情](doc/二轮-心情印章.png)。重新生成截图可执行 `node tests/browser.test.cjs --screenshots`。
