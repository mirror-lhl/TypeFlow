# TypeFlow — App Store Connect 上架文案草稿

> 状态：草稿。账号开通后按此填入 App Store Connect；字数限制以 Connect 实时校验为准。
> 定价、销售地区、隐私 URL、支持 URL 需账号开通后由用户最终确认。

## 基础信息

| 字段 | 值 |
| --- | --- |
| App 名称 | TypeFlow |
| 副标题（≤30 字） | 所见即所得的 Markdown 编辑器 |
| 类别 | 主：生产力（Productivity）；副：效率工具（Utilities） |
| 版权 | Copyright © 2026 TypeFlow |
| 年龄分级 | 4+（无用户生成内容分发、无购物、无限制内容） |
| 出口合规 | 仅使用系统标准加密（HTTPS 之外无自定义加密实现），按豁免申报 |
| 定价 | 一次买断（目标价位 9.99 美元档），非订阅；后续同 App 更新免费 |

## 关键词（≤100 字符）

markdown,编辑器,写作,笔记,公式,代码高亮,导出PDF,离线,所见即所得,中文排版,查看PDF,纯文本

## 描述（中文）

TypeFlow 是一款面向严肃写作的 Markdown 编辑器：左边写，右边即时预览，所见即所得。

**为中文写作优化**
流畅的中英混排、多编码支持（UTF-8 / GBK / UTF-16），打开旧文档不再乱码。

**写作该有的都有**
- 公式：行内与块级 LaTeX 实时渲染
- 代码：多语言语法高亮
- 表格：可视化编辑，无需手写竖线
- 引用、列表、标题：连续回车自然退出，不打断思路

**本地优先，隐私干净**
文档与图片始终保存在你自己的磁盘上；不注册、不登录、不上传、不收集任何数据。

**导出与整理**
一键导出 PDF 与 HTML；工作区文件树、全文搜索、大纲跳转，长文档也不迷路。

**参考资料就地查看**
PDF、HTML 与图片可直接在标签页里打开查看（只读，绝不改动原文件），
查资料时不必再切到别的应用。

一次购买，永久使用；后续更新免费。

## Description (English)

TypeFlow is a Markdown editor for serious writing: write on the left, see the rendered result on the right — truly WYSIWYG.

- Live math (LaTeX), code highlighting and visual table editing
- Multi-encoding support (UTF-8 / GBK / UTF-16) for legacy documents
- Workspace tree, full-text search and outline navigation
- One-click export to PDF and HTML
- Read PDFs, HTML files and images right in a tab (read-only — the original file is never touched)
- Local-first: your documents never leave your disk; no accounts, no tracking, no uploads

Pay once, keep forever. Free updates for the same app.

## 审核备注（Review Notes）草稿

TypeFlow 是完全离线的本地文档编辑器：无需登录、无测试账号、无网络服务依赖。
启动后通过"打开"或拖入 .md / .txt 文件即可体验全部编辑功能；
.pdf / .html / 图片（png、jpg、gif、webp、svg 等）以**只读**方式在标签页中查看，
不提供任何写入路径。未提供文档时会显示空白编辑区。
macOS 沙箱授权：首次打开/保存文件夹时系统会请求访问授权，属预期行为。

## 素材清单

- 应用图标：build/icon-store-1024.png（1024×1024，无透明通道）
- Mac 截图：store/screenshots/mac-1440x900.png（简中商店页）与 mac-1440x900-en.png（英文主语言商店页，全英文界面+英文演示文档），均为 1440×900 App Store Connect 接受尺寸
- 隐私政策：store/privacy-policy.md（需托管为公开 URL 后填入 Connect）

> 现有两张截图拍摄于只读查看器之前，画面里只有编辑与预览。
> 描述中新增的"参考资料就地查看"目前没有对应截图；若要在商店页展示，
> 需要改 `scripts/capture-screenshots.mjs` 的演示文档并重拍（非上架必需）。

## 待账号开通后确认

1. 最终价格点（9.99 美元档或等值其他币种档位）
2. 销售地区范围
3. 是否加入 App Store Small Business Program（佣金 15%）
4. 支持 URL / 营销 URL 的托管位置
5. 站外（GitHub Releases）免费版与商店付费版的关系
