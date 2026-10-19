# TypeFlow 发布指南

面向"要把 TypeFlow 分发给真实用户"的操作手册。所有步骤都已在本地验证过，
除了**签名、公证与 App Store 提交**——那需要真实证书与开发者账号，本文说明如何接入。

## 一、本地打包（无需证书）

```bash
npm install

# macOS 应用（不压缩，最快，用于本地验证）
npm run pack:mac:dir

# macOS 分发件（zip 是自动更新实际消费的格式）
npm run pack:mac

# 其他平台
npm run pack:win
npm run pack:linux
```

产物在 `release/`。

### 验证打包产物真的能跑

**不要只看"打包成功"**——那只能证明文件写出来了。用打包后的应用跑一遍完整自检：

```bash
# macOS
env -u ELECTRON_RUN_AS_NODE ELECTRON_SMOKE_TEST=1 \
  "release/mac-arm64/TypeFlow.app/Contents/MacOS/TypeFlow" > /tmp/packaged.log 2>&1
grep "断言" /tmp/packaged.log
```

期望输出：`断言 231 项，失败 0 项`（2026-10-19 在打包产物上实测）。

这一步能抓到"构建成功但运行时找不到资源"这类只在打包后暴露的问题
（路径解析、asar 内文件读取、`file://` 加载）。

> `env -u ELECTRON_RUN_AS_NODE` 不可省略：该变量若被继承，Electron 会退化成
> 纯 Node 进程，报 `bad option: --no-sandbox` 之类的假错误。

> `dir` 目标与 `zip` / `dmg` 目标的产物**不完全一样**：只有后者会写入
> `Contents/Resources/app-update.yml`（自动更新的配置来源）。因此在 `zip` / `dmg`
> 产物上跑自检时，"更新检查"这一步会真的去请求 `publish.url` 配置的地址；
> 离线机器上得到 `error / net::ERR_NAME_NOT_RESOLVED`，属预期，自检断言已放过网络层失败
> （但仍会因配置层的原始错误失败——那正是 L5 修掉的缺陷形态）。
> 注意构建 `zip` / `dmg` 会**重新打包 `release/mac-arm64/`**，
> 想要一份不含 `app-update.yml` 的本地验收件，就把 `npm run pack:verify`（`dir`）放在最后跑。

## 二、启用签名与公证

### macOS

需要 **Apple Developer Program 会员**（$99/年）。

1. 在 Apple Developer 后台创建 **Developer ID Application** 证书
2. 导出为 `.p12` 并转 base64：
   ```bash
   base64 -i DeveloperID.p12 | pbcopy
   ```
3. 修改 `electron-builder.yml`，**移除** `identity: null` 这一行
   （它当前是为了本地无证书验证而显式关闭签名）
4. 把 `notarize: false` 改为 `true`
5. 注入凭据（CI 用 Secrets，本地用环境变量）：
   ```bash
   export CSC_LINK="<p12 的 base64>"
   export CSC_KEY_PASSWORD="<p12 密码>"
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="XXXXXXXXXX"
   npm run pack:mac
   ```

`build/entitlements.mac.plist` 已就位。**不要删减其中的条目**：
`allow-jit` 与 `allow-unsigned-executable-memory` 是 V8 的硬性要求，
`disable-library-validation` 是 Electron 加载框架所必需。
缺少任何一项，签名后的应用会在启动时崩溃——而这个问题在未签名构建里看不到。

### Windows

需要 **代码签名证书**（约 $200–400/年，OV 或 EV）。

```bash
export CSC_LINK="<pfx 的 base64>"
export CSC_KEY_PASSWORD="<pfx 密码>"
npm run pack:win
```

未配置证书时 electron-builder 会产出未签名安装包并给出警告，
而不是失败——这样 fork 与本地环境仍能跑通打包流程。

### 验证签名结果

```bash
# macOS：检查签名与公证票据
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/TypeFlow.app"
spctl --assess --type execute --verbose "release/mac-arm64/TypeFlow.app"
xcrun stapler validate "release/mac-arm64/TypeFlow.app"

# Windows（需在 Windows 上执行）
signtool verify /pa /v "release/TypeFlow Setup 0.1.0.exe"
```

## 三、自动更新

更新配置在 `electron-builder.yml` 的 `publish` 段，当前指向：

```yaml
publish:
  - provider: generic
    url: https://updates.example.com/typeflow
    channel: latest
```

**部署前必须改掉这个 URL。** 更新流程：

1. 把 `release/` 下的安装包与 `.yml`（`latest.yml` / `latest-mac.yml`）
   上传到该 URL 对应的静态目录
2. 客户端启动 15 秒后会静默检查（`scheduleStartupUpdateCheck`）
3. 发现新版本时只在状态栏提示，**不弹窗、不阻塞**
4. 用户在"帮助 → 检查更新"中主动触发检查

`electron-updater` 是**唯一**的运行时第三方依赖。若不打算启用自动更新，
可以从 `dependencies` 移除它，并删除 `src/main/auto-update.ts` 的引用——
安装包会再小一点。

## 四、CI

`.github/workflows/verify.yml` 提供两个 job：

| Job | 触发 | 内容 |
|---|---|---|
| `verify` | push + PR | 三平台矩阵跑 typecheck / build / 静态验证 / jsdom 复现 / 启动自检 |
| `package` | 仅 push | 三平台打包，产物作为 artifact 上传 |

PR 阶段不打包是为了反馈快——打包一次要几分钟。

需要在仓库 Secrets 中配置的项（不配也能跑，只是产出未签名包）：

| Secret | 用途 |
|---|---|
| `CSC_LINK` / `CSC_KEY_PASSWORD` | macOS 签名证书 |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | 公证 |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows 签名证书 |

## 五、已知的构建环境问题

### DMG 构建：曾失败，现已可用

**现状：本机 DMG 构建成功。** `release/TypeFlow-0.1.0-arm64.dmg`（102,824,855 字节）
连同 `.blockmap`、`latest-mac.yml` 与 zip（`TypeFlow-0.1.0-arm64-mac.zip`，
102,423,813 字节）已于 2026-10-19 11:23 由 electron-builder 26.15.3 产出。
命令：`npx electron-builder --mac zip dmg --arm64`。
（`release/` 下另有一份 2026-10-16 的 `TypeFlow.dmg`，100,518,428 字节，
是加入只读查看器之前的产物，已被上面这份取代，未删除。）

早期记录的失败是：

```
plistlib.InvalidFileException: Invalid file
```

即 `dmgbuild` 用 Python 解析 `hdiutil` 输出，而 Python 3.13+ 的 `plistlib.loads` 变严。
当前依赖版本下这条代码路径已经不同，两点可核实：

1. **不再使用系统 Python。** `dmg-builder` 改为下载带 SHA256 校验的 dmgbuild bundle
   （release `dmg-builder@1.2.5`，`dmgbuild-bundle-arm64-75c8a6c.tar.gz`，23 MB），
   缓存在 `~/Library/Caches/electron-builder/dmg-builder@1.2.5/`。bundle 内自带解释器，
   `dmgbuild` 只是一个设好 `PYTHONPATH` 再 exec 自带 `python/bin/python3` 的 bash 包装。
   注意 `VERSION.txt` 显示 bundle 里的 Python 仍是 **3.14.2**（dmgbuild 1.6.7），
   所以这不是靠降 Python 版本绕开的。
2. **`hdiutil` 输出改由 JS 解析。** 设备名与挂载点用正则直接从 `hdiutil attach` 的
   stdout 取（`node_modules/dmg-builder/out/dmgUtil.js` 的 `attachAndExecute`），
   `plistlib` 在 dmg-builder 26.15.3 的产物里已**完全不存在**（全目录 grep 零命中）。
   同处注释还记录了一个相关坑：APFS 镜像会合成一个新的 disk 设备，
   与容器 disk 不同名，因此靠 `hdiutil info` 匹配设备名会漏掉该卷。

首次构建需联网下载该 bundle，缓存后可离线构建。zip 仍是 electron-updater
实际消费的格式，两者都产出即可。

### 自定义 Electron 下载缓存

`~/Library/Caches/electron` 在受限环境（沙箱、无 GUI 会话的 CI）下不可创建：

```
EPERM: operation not permitted, mkdir '/Users/.../Library/Caches/electron'
```

这个错误发生在**下载完成之后**，看起来像下载失败，容易误判。
`electron-builder.yml` 里已把缓存指向可写位置：

```yaml
electronDownload:
  cache: /tmp/typeflow-electron-cache
  mirror: https://npmmirror.com/mirrors/electron/
```

直连 GitHub Releases 实测约 75 KB/s 且频繁卡死，镜像可达 9 MB/s。

## 六、Mac App Store 上架

商店版是**与站外分发完全分离的第二条构建线**，不是给站外包换个签名。

### 两套 entitlements 不能混用

| 构建 | entitlements | 沙箱 | 用途 |
|---|---|---|---|
| `mac` | `build/entitlements.mac.plist` | 无 | Developer ID 签名 + 公证，站外分发 |
| `mas` | `build/entitlements.mas.plist` + `…mas.inherit.plist` | App Sandbox | App Store 提交 |

`mas` 段在 `electron-builder.yml` 里单独声明了 `extendInfo`
（`CFBundleDevelopmentRegion` 与 `CFBundleLocalizations: [en, zh-Hans]`），
不依赖从 `mac` 段继承——mas 构建的平台配置是单独解析的。
Helper 进程用 inherit 版：只继承主应用沙箱，不额外扩权。

两份 plist 里的 `allow-jit`、`allow-unsigned-executable-memory`、
`disable-library-validation` 同样是 V8 与 Electron 加载框架的硬性要求，不要删减。

### 本地验证（无需证书）

```bash
npx electron-builder --mac mas --dir --arm64 -c.directories.output=release/mas-dev-arm64
open "release/mas-dev-arm64/mas-arm64/TypeFlow.app"
```

`--mas` **不是** CLI 参数：electron-builder 26.15.3 会直接报 `Unknown argument: mas`
并打印 help 就退出，产物目录里只剩上一次的旧应用，看起来像"构建成功但没变化"。
`mas` 是 `--mac` 的目标名，`--dir` 才是"只产出未打包目录"的开关。

`identity: null` 时产出未签名应用。注意这**不等于**站外构建换个目录：
mas 目标用的是 MAS 版 Electron 运行时，与 `mac` 目标的框架二进制 SHA256 不同
（2026-10-18 重测：`Electron Framework` 分别为 `057cc0b5…`（mas）与 `8a35f37a…`（站外）；
应用包 mas 241 MB、站外 243 MB），因此 `process.mas === true`，
`mas-access.ts` 的代码路径确实会执行。

同一轮在这份未签名 MAS 产物上直接跑了应用自检：

```bash
ELECTRON_SMOKE_TEST=1 ./release/mas-dev-arm64/mas-arm64/TypeFlow.app/Contents/MacOS/TypeFlow \
  --no-sandbox --disable-gpu
# [typeflow:smoke] 断言 217 项，失败 0 项
```

> 这份 MAS 产物是 2026-10-18 构建的，217 是**当时代码**的自检总数，不是当前值；
> 2026-10-19 加入显示区开关、滚动联动、预览列表项/转义修复与开关移入内容区后，
> 站外 `dir` 产物为 231 项。
> 要在 MAS 产物上看到同样的数字，需要重新构建它。

输出里那三条 `Error occurred in handler for …` 是**预期**的——它们来自负路径断言
（拒绝 `.sh` 当图片写入、拒绝越界资源路径、拒绝删除工作区外文件）。

想快速确认某个产物是不是 MAS 版，不能用 `ELECTRON_RUN_AS_NODE=1 … -e "process.mas"`：
该模式下 Electron 跳过浏览器进程初始化，两个构建都打印 `undefined`（本轮实测）。

但**未签名构建没有被系统真正沙箱化**：App Sandbox 的强制来自签名时注入的
entitlements，不签名就不生效，文件系统访问实际不受限。所以这种构建只能验证
"书签代码不崩、不阻断正常读写"，**验证不了授权是否真的生效、以及重启后能否恢复**。

### 沙箱授权：三项能力必须越出对话框授权范围

沙箱下进程对文件系统没有任何默认权限，只有用户当次经系统对话框选中的文件可读写。
而 TypeFlow 有三项核心能力不满足这个前提：

| 能力 | 为什么越界 |
|---|---|
| 启动时重开最近文档 | 用户这次没有选它 |
| 图片写入文档同目录 `assets/` | 用户选中的是文档文件，不是目录 |
| 工作区目录树 / 搜索 / 监听 | 重启后仍需保留访问 |

解法是苹果的**安全作用域书签**（security-scoped bookmarks）：对话框授权时把授权
序列化为 bookmark 持久化到 `userData/typeflow-bookmarks.json`（临时文件 + rename 原子写），
下次启动用它恢复访问。实现在 `src/main/mas-access.ts`，接入点：

| 位置 | 作用 |
|---|---|
| `main/index.ts` | 启动 `restoreBookmarks()`、退出 `stopAllBookmarks()` |
| `main/file-io.ts` | 读前 `assertReadAccess`、写前 `ensureWriteAccess`、打开/另存为后登记书签 |
| `main/workspace-ipc.ts` | 目录授权登记；启动恢复工作区时校验授权 |
| `main/asset-io.ts` | 图片写盘前 `hasAccess` / `requestDirectoryAccess` |
| `main/export-ipc.ts` | 导出目标登记书签 |

整个模块以 `process.mas === true` 为开关，**站外构建行为逐字不变**。
失效书签（文件被移动、系统重置授权）在恢复时被剔除，不阻断启动；
目录授权覆盖其全部子路径，文件授权只覆盖它自身。
授权不足时的用户可见文案已进 i18n（`grantFolderAccess` /
`grantFolderAccessMessage` / `sandboxAccessLost`，中英双语）。

### 验证缺口（提交前必须补）

`mas-access.ts` 的 `hasAccess()` 在 `ELECTRON_SMOKE_TEST === '1'` 时**直接放行**。
这是必要的：自检跑在无沙箱环境，合成事件拿不到真实书签数据，若不放行，
每次写操作都会弹一个无人点击的系统对话框，自检直接挂起。

代价是**书签的登记、持久化与恢复路径目前没有任何自动化覆盖**，
`scripts/` 下也没有针对 mas 产物的自检入口。这条路径只能在真机、真沙箱、
真证书下人工验证。提交前至少要手工过一遍：

1. 打开一个文档 → 退出 → 重开，确认最近文档自动恢复（验书签持久化与恢复）
2. 打开文件夹 → 退出 → 重开，确认目录树 / 搜索 / 监听仍可用（验目录授权覆盖子路径）
3. 向已保存文档粘贴图片，确认写入 `assets/` 不弹授权框（验目录授权已覆盖该路径）
4. 把文档移到别处再启动，确认失效书签被剔除、应用不崩、错误文案可读
5. 未保存文档时粘贴图片，确认提示"先另存为"而不是沙箱授权错误

### 正式提交还需要

1. **证书**：Apple Developer Program（$99/年）下的
   "3rd Party Mac Developer Application" 与 "…Installer" 两张证书
2. **provisioning profile**：App Store 类型，绑定 `com.typeflow.app`
3. **移除 `mas.identity: null`**，注入 `CSC_LINK` / `CSC_KEY_PASSWORD`
4. **产出 `.pkg`**：`npx electron-builder --mas --arm64`
   （目前只跑过 `dir` 目标，`.pkg` 未验证）
5. 用 Transporter 上传，在 App Store Connect 建版本
6. 填入 `store/listing.md` 的文案与素材；隐私政策需先托管成公开 URL
7. 结清 `store/listing.md` 末尾 5 项商务确认（价格点、销售地区、
   Small Business Program、支持 / 营销 URL 托管、站外免费版与商店付费版关系）

### 商店素材

| 素材 | 位置 |
|---|---|
| 商店图标 1024×1024（无透明通道） | `build/icon-store-1024.png` |
| 简中商店页截图 1440×900 | `store/screenshots/mac-1440x900.png` |
| 英文商店页截图 1440×900（全英文界面 + 英文演示文档） | `store/screenshots/mac-1440x900-en.png` |
| 中英描述 / 关键词 / 审核备注 / 分级 | `store/listing.md` |
| 隐私政策 | `store/privacy-policy.md` |

截图由 `scripts/capture-screenshots.mjs` 一次跑出中英两套：以截图模式启动
`out/` 构建结果（不必先打包成 `.app`），渲染层铺好演示文档后回报，
主进程按 App Store Connect 接受尺寸抓图。使用隔离 `userData`，不污染真实配置；
对跨屏移动窗口偶发的 SIGSEGV 会重试一次。
