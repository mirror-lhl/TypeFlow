# 开发者文档

这份文档面向想改代码或自己构建的人。普通用户请看 [README](../README.md)。

包含：架构、数据安全与安全基线、只读查看器的实现约束、验证体系与验证哲学、
构建与发布流程、环境问题、以及各阶段的验收记录索引。

---

## 目录

- [从源码运行](#从源码运行)
- [布局与显示区](#布局与显示区)
- [各层能力清单](#各层能力清单)
- [验证](#验证)
- [架构](#架构)
- [数据安全](#数据安全)
- [安全基线（后续级别不得放宽）](#安全基线后续级别不得放宽)
- [只读查看器](#只读查看器)
- [验证哲学](#验证哲学)
- [环境问题](#环境问题)
- [开发环境注意](#开发环境注意)
- [路线图与预算](#路线图与预算)

---

## 从源码运行

```bash
npm install                      # Electron 二进制下载失败见「环境问题」
npm run dev                      # 开发模式（热更新）
npm run build && npm start       # 生产模式启动
```

需要 Node 20+。

## 布局与显示区

布局有三态：**分屏 / 仅编辑区 / 仅预览**，菜单「视图 → 切换布局」（⇧⌘V）循环切换。
显示区开关长在**内容区右上角**（不在工具栏）：分屏时它在显示区里，点一下收起；
收起后同一个角落的按钮落在编辑区里，再点一下还原；仅预览时点它恢复分屏。
三种布局下按钮都在同一个屏幕角落，位置不跳。

分屏下编辑区与显示区**双向联动滚动**，按比例映射：两端首尾严格对齐，中部按高度比例近似。
选比例而非按块对齐，是因为显示区由 markdown 逐行构造（空行也是 `<br>`），
与内核的块结构并不一一对应，块级对齐在多数文档上都会错排。

## 各层能力清单

### L3 能力

| 能力 | 用法 |
|---|---|
| 行内公式 | `$E = mc^2$` |
| 块级公式 | 单独一行 `$$` 包裹 |
| 公式就地编辑 | 双击公式输入 LaTeX，`Enter` 确认 / `Esc` 取消 |
| 代码高亮 | 代码块左上角下拉选择语言（14 种常用语言） |
| 插入表格 | ⌥⌘T，或工具栏 ▦。默认 3 列表头 + 1 行正文 |
| 表格内导航 | `Tab` / `Shift-Tab` 在单元格间移动；最后一格按 Tab 自动追加行 |
| 增删行列 | 工具栏 `+行` `+列` `−行` `−列` `✕表`（不在表格内时自动禁用） |
| 插入图片 | 直接粘贴或拖入图片文件，自动写入文档同目录 `assets/` 并插入相对路径 |
| 导出 HTML | ⇧⌘E，或工具栏 `HTML`。**自包含单文件**：图片内联为 data URL |
| 导出 PDF | ⌘P，或工具栏 `PDF`。内置 `printToPDF`，中文嵌入字体已实测 |
| 切换排版主题 | ⌥⌘L。默认 / 衬线阅读 / 紧凑，与明暗**正交组合** |
| 自定义主题 | 工具栏 `导入主题`，选择任意 CSS 文件 |

> 图片需**先保存文档**：未保存时没有落点，会提示先另存为。
> 相对路径保证换机器/换目录后图片依然可用。

**CSP 未放宽任何指令**即可运行 KaTeX 与 highlight.js（两者都不使用 `eval`）。

### L5 能力（发布）

```bash
npm run pack:verify        # 打包 dir 目标 + 在产物上跑完整自检（推荐）
npm run pack:verify:zip    # 额外产出可分发 zip
npm run pack:open          # 验证通过后直接打开应用
```

**为什么要用 `pack:verify` 而不是直接 `electron-builder`**：
"打包成功"不等于"打包产物能跑"。本项目实际遇到过两个只在产物上出现的缺陷
（更新检查抛原始 ENOENT、依赖分类错误导致包大 40 MB）。
该脚本把"构建 → 打包 → 在产物上跑自检"固化成一条命令，
并会拒绝验证**早于源码的过期产物**。

产物位置与打开方式：

```bash
open "release/mac-arm64/TypeFlow.app"
# 未签名应用若被 Gatekeeper 拦下：右键 → 打开 → 弹窗中再点一次"打开"
```

期望自检输出 `断言 257 项，失败 0 项`。
> **关于自动更新**：本项目**不含**自动更新。macOS 上的 electron-updater 要求应用已签名，
> 而免费分发不做签名，因此这条路径必然失败。新版本请到 Releases 页面手动下载。

| 能力 | 说明 |
|---|---|
| 三平台打包 | electron-builder，配置见 `electron-builder.yml` |
| 界面语言 | 菜单「视图 → 切换界面语言」；210 键 × 中英双语 |
| 重置界面设置 | 菜单「帮助 → 重置界面设置…」；清空主题/排版/语言/布局，**不影响最近文件** |
| CI | 三平台矩阵：验证 + 打包（`.github/workflows/verify.yml`） |

安装包体积构成（macOS arm64，2026-10-19 实测）：Electron 框架 233 MB
+ 应用资源 10 MB（其中 `app.asar` 10,623,608 字节）= **243 MB**；
zip **97.7 MB**（`release/TypeFlow-0.1.0-arm64-mac.zip`，102,423,813 字节）、
DMG **98.1 MB**（`release/TypeFlow-0.1.0-arm64.dmg`，102,824,855 字节），
两者本机均已构建成功——见 [docs/L5-RELEASE.md](docs/L5-RELEASE.md) 第五节。

其中只读查看器占约 6.5 MB：pdf.js 主体 1,027,255 字节 + worker 2,348,879 字节
（两者都是动态 import 出来的独立 chunk，不打开 PDF 就不加载）
+ `out/renderer/pdfjs/` 3.1 MB（cMap、标准字体，以及 JPEG2000 / JBIG2 的纯 JS 解码器）。

### L4 能力

导出的 PDF/HTML 为**自包含**：图片内联为 data URL，换机器、拷给别人、
用浏览器打开都不缺东西。

公式在编辑器内用 KaTeX HTML（排版精细），**导出时改用 MathML**（零字体依赖）——
同一份 LaTeX 走两条输出路径，这是"可移植性优先于排版细节"的取舍。

排版主题与明暗是两轴：`data-theme` 管配色、`data-variant` 管排版，
因此"深色 + 衬线阅读"这类组合可以直接用。

## 验证

```bash
npm run verify:all               # 一条命令跑完全部验证（推荐）
```

拆开看：

| 命令 | 验证内容 | 耗时 |
|---|---|---|
| `npm run typecheck` | 主进程 + 渲染层双 tsconfig 类型检查 | ~1s |
| `npm run build` | 三个 target 构建（含 typecheck） | ~4s |
| `npm run verify:l0` | 编解码往返、原子写、产物完整性 | <1s |
| `npm run test:input-rules` | jsdom 逐字符复现输入规则 | <1s |
| `npm run smoke` | **真实启动 Electron**，231 项端到端断言 | ~2s |

耗时为 2026-10-19 本机（Apple Silicon）以 `/usr/bin/time -p` 实测，
`verify:all` 全程 8.8s（三次 8.95 / 8.68 / 8.89）。

`npm run smoke` 会校验构建产物是否早于源码，防止验证到过期代码。

发布：推一个 `v*` 标签即可触发 [release.yml](.github/workflows/release.yml)，
在 macOS runner 上分别构建 arm64 / x64 的 zip 并附到草稿 Release。

## 架构

```
src/
  shared/ipc.ts                    三方共享类型契约（唯一事实来源，改契约必然三端报错）
  shared/document-types.ts         可打开类型清单：可编辑文档 + 只读查看对象（主进程与渲染层共用）
  shared/i18n.ts                   中英双语文案表
  main/
    index.ts / menu.ts             应用入口、命令总线菜单
    file-io.ts                     编码探测、原子写、打开/另存为
    workspace.ts                   目录树 / 文件操作 / 搜索 / 变更监听
    asset-io.ts                    二进制资源（图片）读写与路径解析
    viewer-resources.ts            pdf.js 的 cMap / 标准字体回源（白名单目录 + 单段文件名）
    export-ipc.ts                  HTML/PDF 导出、主题 CSS 读取
    workspace-ipc.ts               工作区 IPC 与路径越界校验
    mas-access.ts                  MAS 沙箱授权（安全作用域书签），仅商店构建生效
    window-state.ts / close-guard.ts / preferences.ts
  preload/index.ts                 contextBridge 白名单桥（不暴露 ipcRenderer 本体）
  renderer/
    main.ts                        文档生命周期 / 布局 / 查找 / 命令派发 / 自检
    file-url.ts                    本地绝对路径 → `file://` URL（编辑器图片与查看器共用）
    editor/                        ProseMirror 内核（markdown 字符串进出的窄接口）
      schema.ts                   文档 schema（含公式节点）
      markdown.ts                 Markdown ↔ 文档转换（6 处保真修正）
      behavior.ts                 输入规则 / 键盘映射 / 命令
      math.ts                     公式 schema + KaTeX 渲染 NodeView
      code-block.ts               语言注册 + 语法高亮 + 代码块 NodeView
      table.ts                    表格 schema 规格 + 管道表解析/序列化
      table-plugins.ts            表格命令与键盘映射
      image.ts                    图片解析器 + 图片 NodeView + 插入逻辑
      index.ts                    内核封装
    export/document-html.ts       文档 → HTML、图片内联、导出样式
    workspace/
      session-store.ts             多标签会话模型（内核按需挂载；查看会话是独立一类；
                                   打开文件时就地替换空白的未命名标签）
      viewer.ts                    只读查看器：PDF 逐页栅格化 / 图片 / HTML
      html-sanitize.ts             HTML 白名单净化（解析 + 重建，不经 innerHTML）
      file-tree.ts                 文件树
      outline.ts                   大纲
      search-panel.ts              工作区搜索
      tab-bar.ts / text-search.ts
```

### 两条核心设计约束

**1. markdown 字符串是唯一真相。**
所见即所得模式 = 内核序列化结果；源码模式 = 直接编辑同一字符串。
两种模式共用一份数据，因此切模式不丢内容，也不存在"两份文档"不同步。

**2. 内核只暴露 markdown 进出的窄接口。**
上层完全不依赖 ProseMirror 节点模型，因此内核可整体替换而上层零改动。

**3. 内核按需挂载（L2）。**
只有活动标签持有编辑器实例与 DOM，切走时立即序列化并销毁。
因此标签数不影响内存，且**结构上不可能**存在隐藏编辑器读到过期数据。
代价是切标签会丢失各自独立的撤销栈——这是明确的取舍。

## 数据安全

编辑器最容易犯的错是"用户没改内容，保存却产生 diff"。本项目对此有明确防线：

- markdown 往返保真：13 类语法逐字往返（含代码块语言、列表标记风格、紧凑/松散列表）
- **纯文本（.txt）不参与 Markdown 规范化**：这类会话被钉在源码模式，保存内容取自文本框原文，
  切标签时也不用内核序列化结果覆盖会话内容（否则 `*` 会变 `\*`、单换行会被并进同一段）
- 原子写入：先写同目录临时文件再 rename，崩溃不会留下半截文档
- 编码无损：UTF-8 / UTF-8 BOM / UTF-16LE 原样回写；GBK 只读，含非 ASCII 时升级为 UTF-8 并**提示用户**，绝不静默损坏
- 关窗守卫：未保存内容弹原生三选一（保存 / 不保存 / 取消）
- **只读对象永不写回磁盘**：PDF / HTML / 图片会话没有权威文本，`saveSession` 直接返回失败，
  保存类命令在总线上被集中拦截（见「只读查看器」）

## 安全基线（后续级别不得放宽）

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`
- preload 逐个显式列方法，不做透传式 IPC 转发
- `will-navigate` 与 `setWindowOpenHandler` 一律拒绝，仅 https 外链交给系统浏览器
- 预览逐行构造受控 DOM，全程不用 `innerHTML`
- CSP 限定 `default-src 'self'`，无 `unsafe-eval`

## 只读查看器

PDF / HTML / 图片只渲染、不编辑。这不是"暂时没做编辑"，而是写进模型里的一条硬约束：

- **查看会话是独立的一类**（`session.kind === 'viewer'`），不是"markdown 恰好为空的文档"。
  它没有权威文本、不参与脏标记、不挂编辑内核，因此结构上不存在
  "看了一眼 PDF，保存时把空内容写回磁盘"这条路径
- 命令总线上有一份集中的拦截清单（保存 / 另存为 / 查找 / 撤销重做 / 插入表格 /
  切换模式 / 切换布局 / 显示区开关 / 导出 HTML / 导出 PDF），工具栏对应按钮同时置灰，
  查找条在切入查看会话时自动关闭。集中判定而不是在每个分支各自防御：
  漏掉一个的后果是数据损坏，不该靠人记着
- 只读对象**不进全文搜索索引**：搜到了也无处可跳（没有光标、没有行定位），
  给出死链接比不给结果更糟
- 目录树里用单独的图标区分；既非文本也非可查看的文件仍然置灰

### 三条不放宽安全基线的实现选择

| 对象 | 做法 | 为什么不用更常见的方案 |
|---|---|---|
| PDF | pdf.js **主线程 fake worker**（把 worker 模块赋给 `globalThis.pdfjsWorker`） | `new Worker()` 需要 CSP 增加 `worker-src`，且 `file://` 下取不到 worker 脚本 |
| HTML | `DOMParser` 解析成惰性文档 → **标签/属性白名单重建** → 挂进 `shadow root` | 沙箱 `<iframe>` 的 opaque origin 会让本地图片全部加载失败；加 `allow-same-origin` 又等于把父页面的 `file://` origin 交出去，还得放宽 `frame-src` |
| 图片 / SVG | `<img src="file://…">` | 经 `<img>` 加载的 SVG 不执行脚本、不发外部请求 |

**CSP 一个字都没改**：`img-src` 原本就放行 `file:`，`style-src 'unsafe-inline'`
原本就有（自定义主题需要），被查看文档的 `<style>` 注入 shadow root 内部，出不了那棵子树。
净化全程不使用 `innerHTML`；`script` `iframe` `object` `embed` `form` `svg` `math` `canvas`
等整棵丢弃，`on*` 属性与含 `javascript:` / `expression(` / `@import` 的样式值一律拒绝，
`src` 只放行 `file:` 与 `data:image/`，`href` 额外放行 `https:`（点击交给系统浏览器）。

pdf.js 的 cMap 与标准字体不能靠 `fetch` 取（CSP `connect-src 'self'` 与 Chromium 的
file 访问策略都不允许），改由主进程按名回源：`viewer-resources.ts` 只放行
`cmaps/` 与 `standard_fonts/` 两个目录下的**单段文件名**，跨段与 `..` 一律拒绝，
单文件上限 4 MB。构建时由 Vite 插件把这两个目录复制进 `out/renderer/pdfjs/`，
随 `files: out/**/*` 进包（开发期直接读 `node_modules/pdfjs-dist`）。
少了 cMap 的后果不是"字体不好看"，而是使用预定义编码的中文 PDF **整页失败**。

JPEG2000 / JBIG2 的纯 JS 解码器走的是**动态 import** 而不是 fetch，回源通道帮不上，
因此另有一个 `viewer:pdf-wasm-url` 只返回那个目录的 `file://` URL。目录里只有两个
`*_nowasm_fallback.js` 与其许可证，**没有 `.wasm`**——真要用 wasm 就得给 CSP 加
`wasm-unsafe-eval`，那是明确不做的取舍。渲染层由 `file://` 加载时这个 URL 落在
`script-src 'self'` 内；开发模式页面来自 dev server，跨源取不到，只影响 `npm run dev`。

**用 legacy 构建而不是默认构建**：pdf.js 6.4 的默认构建直接调用
`Uint8Array.prototype.toHex` / `toBase64`（算文档指纹、拼内嵌图片 data URL），
Electron 33 的 Chromium 130 没有这两个方法，实测打开任何 PDF 都抛
`hashOriginal.toHex is not a function`。legacy 构建自带这些方法的垫片，
API 与类型完全一致（其 `.d.mts` 就是 `export * from "pdfjs-dist"`）。

### 已知限制

- **JPEG2000 / JBIG2 走 pdf.js 自带的纯 JS 解码器**（`useWasm: false` 时 pdf.js 并不
  放弃这两种图像，而是 `import` 随包分发的 `*_nowasm_fallback.js`，共 597,790 字节），
  代价是比 wasm 慢。自检直接 import 这两个模块确认可加载（打包产物里是 asar 内的
  `file://` 路径，实测通过），但**含这类图像的 PDF 实际解码结果与耗时未实测**——手上没有样本
- **ICC 色彩管理不生效**：qcms 只有 wasm 实现，而 `WebAssembly.instantiate` 需要 CSP 的
  `wasm-unsafe-eval`；且 pdf.js 的 `ColorSpace.setOptions` 在 `useWorkerFetch` 为假时
  （用自定义 `BinaryDataFactory` 就是这种情况）会直接把它关掉。后果是带 ICC profile 的
  图像按设备空间渲染，颜色可能有偏差，版面与内容不受影响
- Type 4 后算函数退回 pdf.js 内置的 JS 解释器（同样因为 `useWasm: false`）
- PDF 走图片资源通道读取，**上限 32 MB**，超限提示"文档过大"
- PDF 先按首页尺寸铺等高占位块，再由 IntersectionObserver 逐页栅格化。
  一次渲染全部页面在大文件上会直接卡死界面；代价是页面尺寸不一致的 PDF
  滚动时会有一次轻微跳动
- PDF 内嵌的 JavaScript 不会执行：查看器不渲染注释层，pdf.js 只列出 JS 动作
- HTML 查看**不加载任何远程资源**，本地相对资源按 `file://` 解析；
  被丢弃的元素会在状态栏列出（如 `已忽略不支持或可能不安全的元素：iframe, script`）
- 仍未做：`electron-builder.yml` 未声明 `fileAssociations`，
  Finder 的"打开方式"里看不到 TypeFlow，拖文件到 Dock 图标也不会打开

## 验证哲学

每一级都保留前级的全部断言，因此**任何一级的功能退化都会立刻暴露**。

2026-10-19 实测各级结果：

| 命令 | 结果 | 计数方式 |
|---|---|---|
| `npm run verify:l0` | 9 项全通过 | 脚本 `check()` 逐条打印 |
| `npm run test:input-rules` | 23 个用例全通过 | 每个用例内部还有多个 `assert`，脚本不自报总数 |
| `npm run smoke` | **断言 231 项，失败 0 项** | 应用自检经 IPC 回传，自报总数 |

`smoke` 另有 4 项脚本级检查：主进程窗口创建、渲染层 init 完成、应用自检通过、
**自检未污染用户配置**。

> 只有 `smoke` 会自报总数，因此跨版本比较断言数请以它为准
> （L5 验收时为 96 项，见 [docs/L5-ACCEPTANCE.md](docs/L5-ACCEPTANCE.md) 文末补记）。

四条贯穿全程的原则：

**1. 断言必须验证行为，而不是文件存在。**
例如 PDF 导出不检查"文件生成了"，而是检查 PDF 字节里出现
`/FontFile2`（字体确实被嵌入）——否则"导出一份全是方框的 PDF"也能骗过测试。
同类例子：PDF 查看不检查"页面容器出现了"，而是检查 canvas 真的有像素尺寸；
正是这条抓到了 Chromium 130 缺 `Uint8Array.prototype.toHex` 导致的整页渲染失败
（容器在、画布 0×0，`typecheck` 与 `build` 全程绿灯）。

**2. 断言要覆盖"用户看到什么"，而不只是"数据对不对"。**
L5 有 4 个缺陷全部"功能正常"——数据流断言全绿，但界面呈现是错的
（空白按钮、查找框压住工具栏、重复提示、无法识别的图标）。
因此新增了结构性检查：每个按钮必须有可见内容或 SVG、查找框不得遮挡工具栏与标签栏、工具栏不得换行。

**3. 测试不得污染用户数据。**
自检会切换主题/语言/布局并写入偏好，曾因此改掉用户的真实配置。
现在自检使用隔离的 `userData` 目录，并有脚本级断言验证真实配置未被改动。

**4. 抓到的每个缺陷都要问"我的测试为什么没发现它"。**
L1 曾出现"读回内容无损"用空文档对比空文档而假通过；
L3 曾出现"高亮函数正确但断言读的是染色前的 DOM"。
这类问题靠修正断言解决，而不是靠更仔细地看代码。

## 环境问题

### Electron 二进制下载失败

Electron 的 postinstall 从 GitHub Releases 拉 ~100MB，直连实测约 75 KB/s 且频繁卡死。
用脚本走本地代理 + 镜像 + SHA256 校验：

```bash
./scripts/fetch-electron-binary.sh
# 自定义代理或版本：
PROXY=http://127.0.0.1:7891 ELECTRON_VERSION=33.4.11 ./scripts/fetch-electron-binary.sh
```

该脚本绕开三个坑：`~/Library/Caches/electron` 在部分环境不可写（EPERM）、
`@electron/get` 不认 `ELECTRON_CACHE` 覆盖、半成品 zip 残留。

### npm 缓存权限报错

若出现 `EPERM ... _cacache`，说明全局 npm 缓存被 root 拥有。
本项目固定使用仓库内缓存目录（`--cache ./.npm-cache`），不受影响。

## 开发环境注意

- **`ELECTRON_RUN_AS_NODE`**：该变量会让 Electron 退化为纯 Node 进程，此时
  `require('electron').app` 为 `undefined`，`process.mas` 也是 `undefined`
  （两个构建都一样，因此它不能用来判断产物是不是 MAS 版）。自检脚本已显式剔除。
- **Chromium 沙箱**：受限环境下 GPU 进程与沙箱无法初始化，自检启动附加
  `--no-sandbox --disable-gpu`。这只影响自检进程，正常启动不受影响。
- **`emptyOutDir`**：三个构建 target 各自清空输出目录。曾因残留旧 hash bundle
  导致自检读到陈旧产物，排查成本很高，不要改回 `false`。
- **渲染层 console 不可见于终端**：调试渲染层时不要依赖 `console.log`，
  用 `npm run smoke` 的结构化断言明细，或 `npm run test:input-rules`。

## 路线图与预算

逐级交付，每级通过退出条件后才投放下一级预算。详见：

- [TOKEN-BUDGET-electron.md](TOKEN-BUDGET-electron.md) — 逐级预算（合计 ≈ 6.5 M token）
- [docs/L0-ACCEPTANCE.md](docs/L0-ACCEPTANCE.md) — L0 验收报告
- [docs/L1-ACCEPTANCE.md](docs/L1-ACCEPTANCE.md) — L1 验收报告与 7 个内核缺陷复盘
- [docs/L2-ACCEPTANCE.md](docs/L2-ACCEPTANCE.md) — L2 验收报告与多标签取舍说明
- [docs/L3-ACCEPTANCE.md](docs/L3-ACCEPTANCE.md) — L3 验收报告、CSP 兼容性验证与 11 个缺陷复盘
- [docs/L4-ACCEPTANCE.md](docs/L4-ACCEPTANCE.md) — L4 验收报告、PDF 字体嵌入验证与 5 个缺陷复盘
- [docs/L5-ACCEPTANCE.md](docs/L5-ACCEPTANCE.md) — L5 验收报告、打包体积分析与性能度量（文末有验收后变更）
- [docs/L5-RELEASE.md](docs/L5-RELEASE.md) — 发布指南（签名 / 公证 / CI），供想自行签名的使用者参考

| 级别 | 内容 | 预算 | 状态 |
|---|---|---|---|
| L0 | 骨架：窗口 / 菜单 / IPC / 打开保存 | 0.5 M | ✅ 完成 |
| L1 | 所见即所得内核（ProseMirror 自研） | 2.4 M | ✅ 完成（IME 待实机验证） |
| L2 | 文件树 / 标签页 / 搜索 / 大纲 | 1.4 M | ✅ 完成 |
| L3 | 公式 / 代码高亮 / 表格 / 图片 | 0.9 M | ✅ 完成 |
| L4 | HTML/PDF 导出 + 主题系统 | 0.6 M | ✅ 完成 |
| L5 | 打包 / i18n / 性能 / CI | 0.7 M | ✅ 完成 |
| L5+ | 纯文本 `.txt`：钉在源码模式、逐字保存 | 未编列 | ✅ 完成 |
| L5+ | 只读查看 PDF / HTML / 图片：CSP 与安全基线零放宽 | 未编列 | ✅ 完成 |
| L5+ | Finder 文件关联（`fileAssociations` + `open-file`） | 未编列 | ⬜ 未做 |
| L5+ | Mac App Store 上架 | 未编列 | ⬜ 不在计划内（改为免费开源分发） |
