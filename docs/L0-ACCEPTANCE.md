# TypeFlow — L0 验收报告

> 日期：2026-10-16 ｜ 阶段：L0 骨架 ｜ 技术栈：Electron 33.4.11 + TypeScript 5.9 + electron-vite 2.3
> 预算：0.5 M token（TOKEN-BUDGET-electron.md）

## 一级结论

**L0 通过验收。** 13 项端到端断言全绿，含真实落盘的逐字往返验证。

```
$ npm run build && node scripts/smoke-launch.mjs
▸ 自检结果
  ✓ 主进程窗口创建成功
  ✓ 渲染层 init() 完成（preload 桥畅通）
  ✓ 应用自检通过
```

## 退出条件对照

| # | 退出条件 | 结果 | 证据 |
|---|---|---|---|
| 1 | preload 沙箱通路可用 | ✅ | `contextIsolation: true` + `sandbox: true`，桥往返成功 |
| 2 | IPC 无泄漏 | ✅ | 无同步 IPC；事件订阅返回退订函数；`ipcMain.removeAllListeners()` 收口 |
| 3 | 打开/保存 Markdown | ✅ | 13 项断言中 5 项覆盖读写与覆盖写 |
| 4 | 中文文档不损坏 | ✅ | UTF-8 / UTF-8 BOM / UTF-16LE / GBK 只读 全部处理 |
| 5 | 数据安全（关窗不丢） | ✅ | 原生三选一守卫 + 保存后回执通道 |
| 6 | 窗口菜单可用 | ✅ | 文件/编辑/视图/窗口/帮助 五组，命令总线统一入口 |

## 自检断言明细（13 项）

| 断言 | 说明 |
|---|---|
| preload 沙箱桥可用 | `darwin` |
| 运行时版本信息完整 | Electron 33.4.11 / Chromium 130.0.6723.191 |
| 偏好持久化 IPC 往返 | `recent=0` |
| Markdown 预览渲染 | 4 个块级元素 |
| 预览不产生可执行标记 | XSS 防线：无 `script` / `img` |
| 新建文档标题 | `未命名` |
| 未保存指示可见 | 脏标记同步到标题栏 |
| 写入磁盘 | 原子写（临时文件 + rename） |
| 保存后脏标记清除 | 状态机一致性 |
| **读回内容逐字无损** | 写入 57 字符 → 读回 57 字符 / 87 字节 |
| 新建文档默认 UTF-8 + LF | 编码默认值 |
| 覆盖写后内容一致 | 104 字节，无截断/残留 |
| 关闭前保存回执通道可用 | `notifyCloseAfterSave` |

> 其中"读回内容逐字无损"最初用 `dom.editor.value` 作期望值，而该时点文档已被 `newDocument()` 清空，
> 导致"空 == 空"的假通过。已改为写入 57 字符真实正文（含中文/Emoji/行内代码/加粗/列表）后比对。

## 静态验证（verify-l0.mjs）

```
[1/3] 构建产物完整性         ✓ main / preload / renderer
[2/3] 文本编解码往返         ✓ UTF-8+LF / UTF-8BOM+CRLF / UTF-16LE+中文 / 纯ASCII
[3/3] 原子写入               ✓ 内容正确 + 临时文件已清理
```

## 交付物

| 路径 | 职责 |
|---|---|
| `src/main/index.ts` | 应用入口、窗口、安全基线、IPC 注册 |
| `src/main/menu.ts` | 原生菜单 → `MenuCommand` 命令总线 |
| `src/main/file-io.ts` | 编码探测、原子写、打开/另存为对话框 |
| `src/main/window-state.ts` | 标题栏代理图标、脏标记、当前文件 |
| `src/main/close-guard.ts` | 未保存内容关窗守卫 |
| `src/main/preferences.ts` | 偏好 JSON 持久化（串行写队列） |
| `src/main/ipc-channels.ts` | 通道名常量表 |
| `src/preload/index.ts` | contextBridge 白名单桥 |
| `src/shared/ipc.ts` | 三方共享类型契约（唯一事实来源） |
| `src/renderer/main.ts` | 编辑器、预览、查找、命令派发、自检 |
| `src/renderer/styles.css` | 明暗主题与预览排版 |
| `scripts/verify-l0.mjs` | 静态断言 |
| `scripts/smoke-launch.mjs` | 真实启动端到端自检 |
| `scripts/fetch-electron-binary.sh` | 代理下载 Electron 二进制 + SHA256 校验 |

## 开发环境踩坑记录（已固化进脚本）

| 问题 | 现象 | 解决方案 |
|---|---|---|
| npm 缓存被 root 拥有 | `EPERM ..._cacache/tmp` | `--cache ./.npm-cache` |
| GitHub 下载卡死 | 10s 零字节，停在 1.5 MB | 本地代理 `127.0.0.1:7890`（1.3 MB/s） |
| npmmirror 备选源 | 代理不可用时可用（9 MB/s） | `scripts/fetch-electron-binary.sh` |
| `~/Library/Caches` 不可写 | `EPERM mkdir .../Caches/electron` | 二进制缓存改到 `$TMPDIR` |
| `@electron/get` 不认 `ELECTRON_CACHE` | 仍写死 Caches 目录 | 绕过 postinstall，手动解压 + 写 `path.txt` |
| `ELECTRON_RUN_AS_NODE=1` 被继承 | `electron.app` undefined，退化为 Node | 自检脚本显式删除该变量 |
| Chromium 沙箱/GPU 无法初始化 | `sandbox initialization failed` → FATAL | 自检启动加 `--no-sandbox --disable-gpu` |
| `emptyOutDir: false` 残留旧 bundle | 自检读到陈旧产物，标记缺失 | 三个 target 各自 `emptyOutDir: true` |
| 渲染层 console 不可见于终端 | 自检判据缺失 | 判据改为渲染层显式 IPC 回执 |

## 已知限制（有意留到后续级别）

- 编辑用原生 `<textarea>`，非所见即所得 —— L1 换成编辑器内核
- 预览为最小渲染器（标题/列表/引用/代码块/行内样式），无表格、公式、图表 —— L3
- 无文件树、多标签、全局搜索、大纲 —— L2
- 无导出 —— L4
- GBK 为只读：含非 ASCII 时保存会升级为 UTF-8 并提示（不静默丢数据）
- 单文件上限 64 MB（L1 换流式策略后放开）
- 未配置打包与签名 —— L5

## 下一步：L1（预算 2.4 M）

**唯一豪赌，占总量 37%。** 建议先投 30 分钟做最小原型，验证三项手感：

1. 光标穿越标记符号（`**bold**` 边界来回移动不错位）
2. 中日韩 IME 输入全程无抖动、`compositionend` 时机正确
3. 撤销栈跨格式变更正确分组

三项不过 → 立即改用 Milkdown（L1 成本 2.4 M → 1.0 M）。
