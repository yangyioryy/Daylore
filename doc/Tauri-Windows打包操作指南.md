# Daylore 打包为 Windows 应用：新手操作指南

编写日期：2026-10-19。适用于当前项目和 **Tauri 2**。

这份文档是操作说明。本次只创建文档，没有安装软件、初始化 Tauri 工程、修改应用代码或生成安装包。下面的命令需要你之后按顺序执行。

## 1. 先知道我们要做什么

当前 Daylore 是 HTML、CSS、JavaScript 网页。Tauri 会给它加上一个 Windows 窗口，再生成可安装的 `.exe` 安装程序。不需要重写为 Vue 或 React，也不需要先学习 Rust。

操作分为五段：安装开发工具 → 给现有项目添加 Tauri → 配置窗口和权限 → 在电脑上试运行 → 生成并验证安装包。

本教程先做 Windows x64 安装包，适用于常见 Intel/AMD 的 64 位 Windows 10/11。可在“设置 → 系统 → 系统信息/关于 → 系统类型”查看。如果写着 ARM，请先停在环境准备阶段，不要照抄后面的 x64 选择。

请提前留出数 GB 以上的可用磁盘空间，首次安装编译工具和下载 Rust 依赖会比较久。开发电脑需要这些工具；以后只安装你的应用的用户，不需要 Node.js、Rust 或 C++ 编译工具。

### 特别注意现有日记

- 浏览器版日记保存在浏览器的 `localStorage` 中。桌面版使用自己的 WebView2 数据目录，**不会自动带入浏览器里的日记**。
- 当前项目没有日记导入/导出功能。如果浏览器版已有重要内容，请先另外复制保存，之后再考虑迁移功能。
- 桌面版仍然使用 `localStorage`，不是自动变成独立的 Markdown 文件，也不包含云同步或加密。
- 开发运行和正式安装后的存储来源可能不同。先用测试文字验收，不要在开发版写唯一一份重要日记。

## 2. 如何打开命令窗口

1. 打开 Windows 文件资源管理器。
2. 进入 `C:\Users\huawei\Desktop\Daylore`。
3. 点击顶部地址栏，输入 `powershell`，按回车。
4. 在出现的蓝色或黑色窗口执行：

```powershell
Get-Location
```

结果应为 `C:\Users\huawei\Desktop\Daylore`。不是这个位置时执行：

```powershell
Set-Location -LiteralPath 'C:\Users\huawei\Desktop\Daylore'
```

下文未特别说明的命令，都在这个项目目录执行。代码块里没有 `PS C:\...>` 提示符，复制命令本身即可。多行命令按顺序执行，有报错时先解决，不要继续往下复制。

文档使用 `npm.cmd`，这是 Windows 上 npm 的命令入口，可避免 PowerShell 的 `npm.ps1` 执行策略问题，无需修改系统执行策略。

## 3. 安装开发环境：只做一次

### 3.1 Node.js

在命令窗口先检查：

```powershell
node --version
npm.cmd --version
```

如果能显示版本，且 Node.js 为 24.x，可直接继续。项目现有测试以 Node.js 24 为基准。

没有安装时，打开 [Node.js 官网](https://nodejs.org/)，选择 Windows 的 Node.js 24 LTS 安装程序，按默认选项安装。装完后关闭并重新打开 PowerShell，再执行上面两条命令。

### 3.2 Microsoft C++ Build Tools

Rust 在 Windows 上编译 Tauri 需要微软的 C++ 编译工具。

1. 打开 [Visual Studio Build Tools 官方页面](https://visualstudio.microsoft.com/visual-cpp-build-tools/)。
2. 下载并运行 Build Tools 安装程序。
3. 在“工作负载”里勾选 **使用 C++ 的桌面开发**。
4. 保留右侧推荐的 MSVC x64/x86 编译工具和 Windows 10/11 SDK。
5. 点击安装，等到完成；安装器要求重启时按提示重启。

不需要安装完整 Visual Studio IDE。已经有 Visual Studio 的话，可在“Visual Studio Installer → 修改”里补选上述工作负载。

### 3.3 Microsoft Edge WebView2 Runtime

WebView2 是桌面窗口内显示网页的运行环境。Windows 10/11 通常已有，但不是每台电脑都一定存在。

可在“设置 → 应用 → 已安装的应用”中查找 `Microsoft Edge WebView2 Runtime`；找不到或后续提示缺失时，打开 [WebView2 官方下载页面](https://developer.microsoft.com/microsoft-edge/webview2/#download-section)，下载 **Evergreen Bootstrapper** 并安装。

只安装普通 Edge 浏览器不等于已经确认了 WebView2 Runtime。

### 3.4 Rust

1. 打开 [Rust 官方安装页面](https://www.rust-lang.org/tools/install)。
2. 下载适用于 Windows x64 的 `rustup-init.exe`。
3. 运行它，按默认方式安装；如果提示缺少 C++ 工具，先完成上一步。
4. 安装后关闭并重新打开 PowerShell，再进入项目目录。

检查：

```powershell
rustc --version
cargo --version
rustup show active-toolchain
```

前两条应显示版本，第三条工具链应包含 `x86_64-pc-windows-msvc`。常见正确结果类似 `stable-x86_64-pc-windows-msvc`。

如果误装了 GNU 工具链，在普通 x64 电脑上执行：

```powershell
rustup default stable-x86_64-pc-windows-msvc
```

到这里，Node、npm、Rust、Cargo 都能显示版本后，再开始下一节。

## 4. 在现有项目中加入 Tauri

### 4.1 先备份

在资源管理器中，把整个 Daylore 文件夹复制一份作为备份，例如 `Daylore-打包前备份`。原有浏览器日记仍需按第 1 节另行保留；复制代码目录不会备份浏览器存储。

本节以后会真正修改项目文件。请只在你准备开始打包时执行。

### 4.2 安装项目内的 Tauri CLI

确认终端位于项目根目录，然后执行：

```powershell
npm.cmd install --save-dev @tauri-apps/cli@^2
npm.cmd pkg set "scripts.tauri=tauri"
npm.cmd pkg set "scripts.prepare:desktop=node scripts/prepare-desktop.mjs"
```

这些命令会添加项目本地的开发依赖、`package-lock.json` 和两个 npm 脚本。**不需要全局安装 Tauri，也不需要运行 `npm init`**，项目已经有 `package.json`。

检查：

```powershell
npm.cmd run tauri -- --version
```

应显示 `tauri-cli 2.x.x`。使用这一系列命令时，npm 会选择项目本地安装的 CLI。

### 4.3 创建前端素材整理脚本

不要把 Tauri 的 `frontendDist` 直接指向整个项目根目录，否则可能把 `doc`、`node_modules`、Rust 目录和其他无关文件一起嵌入应用。

我们会创建一个 `dist` 目录，只复制实际运行需要的页面、脚本、样式、图片、字体和两个音效。

在项目根目录执行：

```powershell
New-Item -ItemType Directory -Path '.\scripts' -Force
notepad .\scripts\prepare-desktop.mjs
```

记事本询问是否创建新文件时选择“是”。粘贴下面的全部内容，按 `Ctrl+S` 保存，然后关闭记事本。确保文件名是 `prepare-desktop.mjs`，没有多出的 `.txt`。

```javascript
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const files = [
  'index.html',
  'styles.css',
  'app.js',
  'diary-core.js',
  'diary-services.js',
  'asset/cover.png',
  'asset/paper.png',
  'asset/font.ttf',
  'asset/flip.mp3',
  'asset/close.mp3',
];

// 只整理应用实际依赖，避免把文档、依赖目录和原始备份打进安装包。
await mkdir(path.join(output, 'asset'), { recursive: true });
for (const file of files) {
  await copyFile(path.join(root, file), path.join(output, file));
}
console.log('桌面版前端已准备完成：dist');
```

执行：

```powershell
npm.cmd run prepare:desktop
Test-Path .\dist\index.html
```

应看到“桌面版前端已准备完成：dist”，以及 `True`。

后续编辑源文件仍然编辑项目根目录的 `app.js`、`styles.css` 等，**不要直接修改 dist**。它是每次运行/打包时重新复制的产物。当前脚本不会自动监听源文件变化，改完后需要重启 Tauri 开发运行。

### 4.4 初始化桌面工程

仅首次执行：

```powershell
npm.cmd run tauri -- init --ci --app-name Daylore --window-title 拾页 --frontend-dist ../dist
```

成功后根目录会出现 `src-tauri`，其中包含 `tauri.conf.json`、`Cargo.toml`、`src`、`icons` 等。

如果提示已经存在 `src-tauri`，不要追加 `--force` 覆盖。先查看是否此前已经初始化成功，成功的话直接进入配置步骤。

## 5. 配置桌面窗口和权限

### 5.1 编辑 tauri.conf.json

执行：

```powershell
notepad .\src-tauri\tauri.conf.json
```

首次按本教程初始化后，可以将该文件全部替换为下面内容，保存。JSON 不允许注释、末尾多余逗号或中文引号，请原样复制：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Daylore",
  "version": "1.0.0",
  "identifier": "com.daylore.diary",
  "build": {
    "beforeDevCommand": "npm.cmd run prepare:desktop",
    "beforeBuildCommand": "npm.cmd run prepare:desktop",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "label": "main",
        "title": "拾页 · Daylore",
        "width": 1200,
        "height": 860,
        "minWidth": 800,
        "minHeight": 760,
        "center": true,
        "resizable": true,
        "fullscreen": false,
        "decorations": false,
        "transparent": true,
        "backgroundColor": "#00000000",
        "shadow": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src ipc: http://ipc.localhost https://uapis.cn"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper"
      },
      "nsis": {
        "installMode": "currentUser"
      }
    }
  }
}
```

关键配置的含义：

- `frontendDist: "../dist"`：相对于 `src-tauri`，找到根目录的 `dist`。
- 没有 `devUrl`：使用 Tauri 自带的静态开发服务器，不需要 Python、Vite 或额外启动网页服务器。初始化生成的默认 `devUrl` 不能残留。
- 两个 `before...Command`：每次启动或打包前，先复制最新的前端文件。
- `withGlobalTauri: true`：现有页面通过 `window.__TAURI__` 关闭窗口，需要这个开关。
- `decorations: false`：去掉系统标题栏和系统关闭按钮，展示书本外观。
- `transparent` 和透明背景色：启用窗口透明背景；`shadow: false` 去掉整个矩形窗口的系统阴影，书本自己的 CSS 阴影仍然保留。
- `identifier`：应用固定标识。开始保存正式日记后不要随意更换，否则数据目录可能改变。公开发布前，可改成你自己稳定且唯一的反向域名形式标识；不要求真的拥有该域名。
- `targets: ["nsis"]`：先生成一种 `.exe` 安装包，步骤比同时生成 MSI 更少。
- `currentUser`：按当前 Windows 用户安装，通常不需要管理员权限。
- `downloadBootstrapper`：安装时发现没有 WebView2，联网下载安装它。已经安装 WebView2 时通常直接使用。

初次可保留 Tauri 生成的默认图标，先把应用跑通。上面图标列表对应初始化模板，保存前确认 `src-tauri/icons` 中确实存在这些文件；模板有差异时保留它实际生成的有效图标路径。

### 5.2 允许关闭窗口和拖动窗口

在资源管理器中进入 `src-tauri\capabilities`。通常初始化时已经有 `default.json`；若没有这个文件夹，就先创建它：

```powershell
New-Item -ItemType Directory -Path '.\src-tauri\capabilities' -Force
notepad .\src-tauri\capabilities\default.json
```

将 `default.json` 内容替换为：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "允许主窗口执行日记合上退出与书本边缘拖动",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-start-dragging"
  ]
}
```

配置文件放在默认 `capabilities` 目录后会被 Tauri 发现。`main` 必须和上面窗口的 `label` 一致。

编辑器首次提示 `gen/schemas` 不存在，可能只是因为还没有编译；先确认 JSON 正确，首次运行会生成相关 schema。

现有页面已经有保存后关闭窗口的代码和 `data-tauri-drag-region` 拖动区域，不需要为了本教程改写 `app.js`。当前教程不添加文件系统、Shell 或 HTTP 插件；网页随机短句继续使用浏览器原生 `fetch`。

### 5.3 忽略构建产物

打开项目根目录 `.gitignore`：

```powershell
notepad .\.gitignore
```

保留里面原有内容，在末尾补充尚未存在的几行：

```gitignore
node_modules/
dist/
src-tauri/target/
src-tauri/gen/
```

之后需要保存到 Git 的是应用源码、整理脚本、`src-tauri` 的源文件/配置/图标，以及 `package-lock.json`、`Cargo.lock` 等锁文件。不要把下载的依赖和编译缓存提交进仓库。

## 6. 第一次运行 Windows 应用

在项目根目录执行：

```powershell
npm.cmd run tauri -- dev
```

首次会下载 Rust 依赖并编译，通常明显慢于后续运行。终端持续出现下载、`Compiling` 等输出属于正常过程，不要不断重新执行同一条命令。

成功后会打开真正的桌面窗口。此时 PowerShell 暂时被开发任务占用是正常的；退出开发运行可在终端按 `Ctrl+C`。

如果窗口超出当前屏幕，尤其是屏幕开启了较高缩放比例，可以先在 `tauri.conf.json` 中将尺寸改小，例如 `width: 1000`、`height: 780`，并相应保证最小尺寸不超过初始尺寸，然后重新运行。窗口尺寸使用逻辑像素。

### 必须手动检查的内容

用“测试日记”进行以下检查：

1. 书本外侧是透明背景，封面完整，没有白色矩形底。
2. 点击封面，翻开、连续翻页和日历出现时机正常。
3. 天气按钮与合上丝带分开，都能点击。
4. 能输入中文，停下后显示“墨迹已存”；翻日期后再回来，文字仍在。
5. 点击日历、前后一天、回到今天都有对应方向的翻页。
6. 六种心情可以选择、更换和移除，左侧日历同步显示。
7. 能听到翻页与合书声音；调低系统音量后测试即可。
8. 用鼠标拖动皮革外沿，整个桌面窗口跟随移动。正文和按钮不应该拖动窗口。
9. 点击“合上”，应先保存、播放合上动画，随后**退出桌面窗口**。这是现有页面在 Tauri 下的行为；它不会默认驻留后台，也没有托盘。
10. 开发任务结束后再次执行 `npm.cmd run tauri -- dev`，确认刚才的测试文字、天气和心情还在。

没有系统标题栏时，需要结束应用可用“合上”丝带或 `Alt+F4`。日常优先使用“合上”，它会走保存和动画流程；不要把强制结束进程当作保存操作。

### 在线短句为什么可能没有联网效果

桌面应用仍然受浏览器 CORS 限制。`connect-src` 允许访问接口，并不代表接口一定允许来自 Tauri 来源的跨域请求。

若接口不接受桌面版来源，当前程序会显示本地随机短句，日记照常使用。这不等于打包失败。开发模式可按 `Ctrl+Shift+I` 打开开发者工具，在 Console/Network 查看接口错误。

如果后续要求桌面版一定通过在线 API 获取短句，需要单独开发 Tauri HTTP 插件或 Rust 请求桥接，并配置对应权限。本教程不包含这次功能改造，也不要靠关闭 WebView 安全选项绕过跨域。

### 关于之前 IDM 重复下载的问题

Tauri 的开发运行会使用本地静态服务器；如果当前下载器仍会接管媒体请求，可能再次影响开发模式的音效。

如果观察到 `Downloads\Music` 又出现音频副本，停止当前开发运行，不要反复点击试音。本项目自动浏览器测试已使用无网络音频替身，**不能代替真实桌面版听音验收**。

不要批量删除下载目录来“修复”应用。正式安装后的本地资源加载方式与开发服务器不同，仍需单独检查，不能提前保证下载器一定不会干预。

## 7. 生成 Windows 安装包

开发模式验收通过后，在开发运行的 PowerShell 按 `Ctrl+C` 停止，再依次执行：

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run tauri -- build
```

前两项是已有网页代码的单元测试和语法检查；最后一项才是正式编译和打包。测试有失败先解决，再继续打包。

首次正式打包可能下载 NSIS 等打包工具，或因网络慢而等待；它们是生成安装程序需要的开发工具，与重复下载日记音效不是同一件事。以终端具体提示和来源为准，报错时不要无限重试。

当前配置生成的安装程序通常位于：

```text
C:\Users\huawei\Desktop\Daylore\src-tauri\target\release\bundle\nsis\
```

快速打开：

```powershell
explorer .\src-tauri\target\release\bundle\nsis
```

里面应有类似 `Daylore_1.0.0_x64-setup.exe` 的文件，名字以实际产物为准。这就是可以双击安装的安装包。

`src-tauri\target\release` 里也可能有应用主程序 `.exe`，它与 `bundle\nsis` 里的安装程序用途不同。第一次分享时选 `*-setup.exe`；应用启动仍需要目标电脑有 WebView2。

如果设置过自定义 Cargo target 输出位置，或手动指定了 target，产物目录可能多一层目标架构目录；优先看打包成功时终端输出的完整路径。

### 在自己电脑上安装一次

1. 双击生成的 `*-setup.exe`。
2. 按提示完成安装，从开始菜单启动 Daylore。
3. 写一段新的测试文字、切换天气、盖章，再“合上”退出。
4. 从开始菜单再次启动，确认文字和状态保留。
5. 再验收透明背景、拖动、所有动画和音效。

安装版验证通过，才算完成桌面交付；开发窗口能打开，不等于安装包已经验证通过。之后有条件再在另一台 Windows 电脑上试装，重点检查 WebView2 和显示缩放适配。

### 需要给没有网络的电脑安装时

普通安装包在目标机缺少 WebView2 时需要联网。如果要覆盖“没有 WebView2 且没有网络”的机器，将配置中的：

```json
"webviewInstallMode": {
  "type": "downloadBootstrapper"
}
```

改为：

```json
"webviewInstallMode": {
  "type": "offlineInstaller"
}
```

再重新打包。这样会把 WebView2 离线安装组件一起带上，安装包会明显变大，构建电脑也需要先能下载该组件。已有 WebView2 的目标电脑通常不需要这样做。

## 8. 想换自己的应用图标

先保留默认图标完成首次打包；换图标是之后的可选步骤。

准备一张正方形 PNG，建议 1024×1024，保存为项目根目录 `app-icon.png`。封面图片不是正方形，不建议直接拿来当图标。

执行：

```powershell
npm.cmd run tauri -- icon .\app-icon.png
npm.cmd run tauri -- build
```

图标命令会在 `src-tauri\icons` 生成常用图标。确认配置中的图标路径与实际文件一致即可。

## 9. 常见报错怎么处理

### 找不到 node、npm、rustc 或 cargo

安装后先完全关闭当前终端，再重新打开。Rust 的工具一般位于 `%USERPROFILE%\.cargo\bin`。不要从网上随意复制改系统 PATH 的脚本，先确认对应安装器是否成功完成。

### npm.ps1 不能运行，因为此系统禁止运行脚本

用本教程的 `npm.cmd` 命令。例如 `npm.cmd run tauri -- dev`。不需要为此把整个系统的执行策略调低。

### link.exe not found、缺少 MSVC 或 Windows SDK

回到 Visual Studio Installer，确认已安装“使用 C++ 的桌面开发”、对应 MSVC x64/x86 工具链和 Windows SDK。检查 Rust active toolchain 是否为 `windows-msvc`。安装完成后重新开终端，必要时重启。

### 卡在 Waiting for your frontend dev server to start

检查 `src-tauri\tauri.conf.json` 的 `build`。本教程不设置 `devUrl`，删除初始化残留的默认地址；保留 `frontendDist: "../dist"` 和两个复制前端的命令。

### 前端不存在、窗口空白、图片或字体不显示

在根目录执行 `npm.cmd run prepare:desktop`，检查 `dist/index.html` 和 `dist/asset`。不要把路径写成原电脑的 `C:\...`，应用里的资源继续使用现有 `./asset/...` 相对路径。

如果显示的是配置解析错误，先检查 JSON 逗号、引号和字段层级；不要删权限或安全配置来碰运气。

### 合上后提示 close not allowed，或者拖不动

检查 `app.withGlobalTauri` 是否为 `true`；检查 `capabilities/default.json` 中 `windows` 是否是 `["main"]`，两个 `allow-close` 和 `allow-start-dragging` 权限是否存在。应拖动皮革外沿的窄条，而非文字编辑区。

### 透明背景仍然是白色或黑色

检查 `transparent: true`、`backgroundColor: "#00000000"`，以及页面 `html/body` 的透明背景是否保留。当前项目 CSS 已有透明背景。重新启动应用后再看；还异常时检查 WebView2、显卡驱动和实际显示环境，而不是先改整套页面布局。

### 寄语换了，但看不出是不是来自网络

本地短句和在线短句都会正常显示。以开发者工具中的请求成功/失败为准；CORS、断网、超时或过长内容都会触发本地兜底。日记正文不会发给接口。

### Rust 依赖、NSIS 工具下载失败

保留终端最后的完整错误信息，先确认网络能访问报错中的官方地址。不要关闭证书校验、随意换未知镜像或反复运行下载命令。已经成功下载的 Rust 依赖通常会缓存，不必先删整个 `target` 目录。

### 打包提示缺少 icon.ico

检查 `src-tauri/icons/icon.ico` 是否存在。保留初始化生成的图标，或按第 8 节使用有效的正方形 PNG 生成图标，再构建。

### Windows 提示“Windows 已保护你的电脑”

本教程没有配置代码签名，个人开发的未签名新应用可能触发 SmartScreen。只对自己刚构建且来源确认的安装包按系统提示操作，不要关闭全系统防护。以后公开分发可单独配置签名证书和签名流程，首次自己试用不必先购买证书。

### 安装后找不到浏览器版日记

这是独立存储造成的，不代表原浏览器数据被删除。回原浏览器、原网址/端口或原文件地址查看。不要不断更换桌面应用 identifier、删除 WebView2 数据目录或卸载重装尝试找回内容。

## 10. 以后改代码，如何更新安装包

1. 修改根目录的页面代码，不改 `dist`。
2. 执行 `npm.cmd test` 和 `npm.cmd run check`。
3. 执行 `npm.cmd run tauri -- dev`，验证新的行为后停止运行。
4. 将 `tauri.conf.json` 的 `version` 从例如 `1.0.0` 改为 `1.0.1`。
5. 同步 `package.json` 的版本；若保留了 Rust 工程自己的版本号，也一并保持一致。不要更改应用 identifier。
6. 执行 `npm.cmd run tauri -- build`，安装新的安装包，再验证持久化。

不要为了更新先卸载旧版本或清空应用数据。正式日记需要单独的备份/导出功能，当前原型尚未提供。本教程也没有添加自动更新功能，更新安装包需要手动分发和安装。

## 11. 最后核对清单

- [ ] Node.js 24、npm、Rust、Cargo 检查通过。
- [ ] C++ 编译工具、Windows SDK 和 WebView2 准备好。
- [ ] 有 `scripts/prepare-desktop.mjs`，且 `dist/index.html` 已生成。
- [ ] Tauri CLI 是 2.x，存在 `src-tauri` 工程。
- [ ] 窗口配置、全局 API、关闭/拖动权限已保存。
- [ ] 开发模式能开窗，中文输入、保存、心情、翻页和开合均正常。
- [ ] `npm.cmd test` 和 `npm.cmd run check` 通过。
- [ ] `tauri build` 成功，找到 NSIS 安装程序。
- [ ] 真实安装后重启应用，测试内容仍在，声音和拖动正常。

如果中途卡住，记下“做到第几节”，保留终端最后约 30 行错误信息，就能准确定位；不用从头重装所有工具。

## 官方参考

以下链接于编写时核对。Tauri 使用 2.x，同一教程内不要混用 1.x 配置。

- [Windows 开发前置环境](https://v2.tauri.app/start/prerequisites/)
- [Tauri CLI：init、dev、build、icon](https://v2.tauri.app/reference/cli/)
- [配置：frontendDist、内置开发服务器、窗口与安装包](https://v2.tauri.app/reference/config/)
- [窗口权限列表](https://v2.tauri.app/reference/acl/core-permissions/)
- [Capabilities 权限机制](https://v2.tauri.app/security/capabilities/)
- [Windows 安装包、NSIS 与 WebView2 安装模式](https://v2.tauri.app/distribute/windows-installer/)
