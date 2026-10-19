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
- 底角翻前后一天，书签回到今天。
- 右上暗红丝带合上日记：先保存，再播放合上动画；浏览器可再次翻开。
- 保存失败会保留当前内容，阻止带着未保存文字翻页或合上，恢复存储权限/空间后点击“重试保存”。

日记只保存在当前浏览器的 `localStorage`，不会上传。清理站点数据、使用临时浏览器会话或更换来源可能导致日记不可用。当前原型不包含云同步、文件导出或加密。

## 素材与兜底

默认读取 `asset/cover.png`、`asset/paper.png`、`asset/font.ttf`。皮革、金色内框和泛黄纸张均有 CSS 兜底，字体回退为 `Kaiti`、`STKaiti`、`serif`。`body` 保持透明；浏览器本身可能仍以白色呈现透明背景。

## 数据接口

`diary-core.js` 通过 `window.DiaryCore` 暴露：

```javascript
const { saveDiary, loadDiary } = window.DiaryCore;
saveDiary('2026-10-19', { content: '今日的小事。', weather: 'sunny' });
const diary = loadDiary('2026-10-19');
// { content, weather, updatedAt }
```

键为本地日期 `YYYY-MM-DD`，`updatedAt` 为保存时的 ISO 时间字符串。天气值：`sunny`、`cloudy`、`rainy`、`snowy`。无记录返回空正文、晴天、`updatedAt: null`。接口同步返回，保存/读取失败抛异常，界面负责提示。损坏记录保留原值并禁用该日编辑，以防覆盖。

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

已验证：12 项单元测试与 8 个真实浏览器场景全部通过。包括直接双击打开、持久化恢复、字体横线对齐、素材缺失和三种视口布局。

验收截图：[合上封面](doc/验收-合上.png)、[展开书写](doc/验收-展开.png)。重新生成截图可执行 `node tests/browser.test.cjs --screenshots`。
