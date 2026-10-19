# TypeFlow — L1 验收报告（所见即所得内核）

> 日期：2026-10-16 ｜ 阶段：L1 编辑内核 ｜ 预算：2.4 M token（TOKEN-BUDGET-electron.md）
> 路线决策：**自研 ProseMirror 内核**（未选 Milkdown 复用方案）

## 一级结论

**L1 通过验收。20 项端到端断言全绿，其中 markdown 逐字往返 13/13、输入规则 8/8。**

```
$ npm run verify:all
✓ typecheck        （主进程 + 渲染层双 tsconfig）
✓ build            （98 模块，711 kB）
✓ 数据安全静态验证  （编解码往返 / 原子写）
✓ 输入规则 jsdom 复现（逐字符键入）
✓ 应用启动自检      （20 项断言，失败 0 项）
```

## 退出条件对照

| # | L1 退出条件 | 结果 | 证据 |
|---|---|---|---|
| 1 | 所见即所得编辑可用 | ✅ | ProseMirror 内核 + 工具栏 + 快捷键 |
| 2 | **打开→保存不得产生 diff** | ✅ | markdown 逐字往返 13/13 |
| 3 | 输入规则即时转换 | ✅ | 8/8（标题/列表/引用/代码块/粗体/行内代码） |
| 4 | 中日韩 IME 可用 | ⚠️ 部分 | 架构上走 ProseMirror 原生 composition 处理，但**未在真实输入法下验证** |
| 5 | 撤销栈正确 | ✅ | 撤销 + 重做均验证 |
| 6 | 源码模式可逃生 | ✅ | 双模式共用同一 markdown，切换不丢内容 |
| 7 | L0 能力不回归 | ✅ | 落盘逐字无损仍在断言内 |

> **唯一未闭环项是 IME 实机手感**。这一项无法用自动化断言证明，必须人工在真实输入法下试；
> 也正是 L1 预算中"手感"风险的唯一剩余敞口。

## 自研路线的实际成本

选择自研而非复用 Milkdown，实际排查了 **7 个真实内核缺陷**，全部由自检捕获：

| # | 缺陷 | 根因 | 影响 |
|---|---|---|---|
| 1 | 代码块语言丢失 | 默认解析规格完全忽略 fence info | ` ```ts ` 保存后退化为 ` ``` ` |
| 2 | `~~删除~~` 被破坏 | 默认 tokenizer 是 commonmark preset，**不识别 GFM 删除线**；`~` 又被转义 | 内容变成 `\~\~删除\~\~` |
| 3 | 紧凑列表变松散 | 覆写解析规格时丢失 `tight`，每个列表项之间多出空行 | 整文件 diff |
| 4 | `- item` 变 `* item` | 默认序列化器标记固定 `*` | 整文件 diff |
| 5 | 标记输入规则崩溃 | 偏移公式把"前导捕获组"当成长度 1，区间左偏一个字 → `addMark` 越界 | `Fragment.nodesBetween` 读 undefined |
| 6 | 标记规则静默失效 | 用 `nodesBetween` 判断可标记区间，对纯文本区间回调不符预期 | 加粗/行内代码规则永不命中 |
| 7 | 模式切换不一致 | 隐藏的 textarea 无法聚焦且持有过期内容 | 源码模式切回丢内容 |

**结论：自研路线的成本不是"写内核"，而是"发现并修正默认实现与你预期不一致的地方"。**
这 7 项里只有 1 项（#7）是真正的自研代码缺陷，其余 6 项都源于**对第三方默认行为的假设错误**。

## 调试方法论的修正

过程中有两次"改了半天没进展"，回看都是方法问题：

| 做法 | 结果 | 更好的做法 |
|---|---|---|
| 在应用里反复改代码 + 跑自检 | 每轮 ~90 秒，且只能看到终点对错 | **jsdom 逐步复现**：一次看清"哪一次按键开始不对"（第 6 项就是这样定位的） |
| 靠渲染层 `console.log` 调试 | 渲染进程日志**不会**出现在宿主终端，等于没打日志 | 结构化回传（IPC 附带诊断字段），让状态可见 |
| 推断第三方默认行为 | 6 项缺陷全部源于推断错误 | 写 5 行脚本**实测**（`proseMirror-markdown` 的 token 输出、`esc` 转义集、`someProp` 语义） |

已固化为工具：`scripts/probe-input-rules.mjs`（jsdom 逐字符复现）、`autoInsert` 的结构化诊断。

## 新增交付物

| 路径 | 职责 |
|---|---|
| `src/renderer/editor/schema.ts` | 文档 schema（默认 schema + 列表标记风格 + 删除线） |
| `src/renderer/editor/markdown.ts` | Markdown ↔ 文档转换（4 处保真修正） |
| `src/renderer/editor/behavior.ts` | 输入规则、键盘映射、块级/行内命令、状态查询 |
| `src/renderer/editor/index.ts` | 内核封装：markdown 字符串进出的窄接口 |
| `scripts/probe-input-rules.mjs` | jsdom 逐字符输入规则复现 |

### 内核接口边界（刻意设计）

```ts
interface EditorApi {
  getMarkdown(): string            // 文档 → markdown
  setMarkdown(markdown: string)    // markdown → 文档
  insertText(text: string): void   // 直接改文档
  autoInsert(text: string): ...    // 走输入规则管线（逐字注入/听写/AI 续写）
  applyDefaultInput(text: string)  // 只跑规则不兜底（供精确断言）
  execute(command): boolean
  undo(): boolean
  redo(): boolean
  selectAll(): void
  readonly view: EditorView
  readonly state: EditorState
}
```

上层（渲染层、未来的标签页/导出/搜索）只依赖这个接口，**不了解 ProseMirror 节点模型**。
因此内核实现可以整体替换（例如换成 Milkdown），上层功能一行都不用改。

## 已知限制

- **IME 未实机验证**（最大敞口，见上）
- 无自动配对（输入 `(` 不会补 `)`）与选中后输入标记
- 表格、公式、图表、图片、任务列表 → L3
- 查找在所见即所得模式下只计数、不定位（markdown 偏移与文档位置不对应）→ L2 解决
- 无文件树、多标签、全局搜索、大纲 → L2
- 无导出 → L4
- GBK 仍为只读（含非 ASCII 时保存升级为 UTF-8 并提示，不静默丢数据）

## 下一步：L2（预算 1.4 M）

文件树、标签页、全局搜索、大纲、设置持久化、拖拽打开。
L1 已为其留好接入点：`openDocumentByPath` 已导出（最近文件/拖拽复用），
`EditorApi` 的 markdown 进出接口使多标签只需多份内核实例。
