# TypeFlow — Mac App Store 上架指南

> 目标：以 **$9.99 付费应用**形式上架 Mac App Store。
> 商店负责收款、税务、退款与分发，因此**应用内不得有任何授权/付费门**
> （否则触发审核条款 3.1.1：数字功能必须走 Apple 内购）。

---

## 一、代码侧已就绪（无需证书即可验证）

```bash
npm run verify:mas:static   # 秒级：entitlements / 构建配置 / 商店材料
npm run verify:mas          # 数分钟：真的构建 MAS 包并在其上跑完整自检
```

`verify:mas` 覆盖的关键项：

| 检查 | 为什么重要 |
|---|---|
| `com.apple.security.app-sandbox` | 商店强制沙箱 |
| **`com.apple.security.files.bookmarks.app-scope`** | 缺了它，安全作用域书签在**下次启动时无法解析**——最近文档、`assets/` 写入、工作区搜索全部失效 |
| `com.apple.security.files.user-selected.read-write` | 对话框选中的文件可读写 |
| `com.apple.security.cs.allow-jit` | Electron/Chromium 的 JIT |
| 子进程 entitlements 同样启用沙箱 | Electron Helper 进程也需沙箱 |
| 站外版 entitlements **不含**沙箱 | 两套配置必须分离，混用会让站外版无法读写任意路径 |
| `bundleVersion` 已声明 | 商店要求 `CFBundleVersion` 单调递增 |
| 图标 1024×1024 | 商店营销图标要求 |
| 在 MAS 包上跑完整自检 | 确认 `process.mas` 分支真的生效（自更新被禁用） |

**当前状态**：`verify:mas` 全绿，MAS 包自检 **257 项断言通过**。

---

## 二、需要 Apple Developer 账号的部分

### 1. 加入 Apple Developer Program

- 个人/公司账号，**$99/年**
- 公司账号需 D-U-N-S 编号

### 2. 创建证书（两种，缺一不可）

| 证书 | 用途 |
|---|---|
| **3rd Party Mac Developer Application** | 签名 App 及其内嵌框架 |
| **3rd Party Mac Developer Installer** | 签名最终上传的 `.pkg` |

在 Apple Developer → Certificates 创建，导入本机钥匙串。

### 3. 注册 App ID 与 Provisioning Profile

1. Apple Developer → Identifiers 新建 App ID：`com.typeflow.app`
2. Capabilities 勾选 **App Sandbox**
3. Profiles 新建 **Mac App Store** 类型 profile，绑定上述 App ID 与证书

### 4. 配置构建

证书就绪后，`electron-builder.yml` 的 `mas` 段需要：

```yaml
mas:
  identity: "3rd Party Mac Developer Application: <你的团队名> (TEAMID)"
  provisioningProfile: "build/typeflow.provisionprofile"
  bundleVersion: "1"     # 每次上传都必须递增
```

> 也可以用环境变量注入，避免把证书名写进仓库：
> `CSC_NAME`、`CSC_LINK`、`CSC_KEY_PASSWORD`。
> `provisioningProfile` 通过 `PROVISIONING_PROFILE_SPECIFIER` 指定。

### 5. 生成上传包

```bash
npx electron-builder --mac mas --arm64 --publish never
```

产物是 `.pkg`，用 **Transporter**（Mac App Store 应用）上传。

---

## 三、App Store Connect 填写项

文案素材已备在 [store/listing.md](../store/listing.md)，逐项对应：

| 字段 | 来源 |
|---|---|
| App 名称 | `TypeFlow` |
| 副标题 | 「所见即所得的 Markdown 编辑器」 |
| 类别 | 主：生产力；副：效率工具 |
| 价格 | 9.99 USD（一次性买断） |
| 年龄分级 | 4+ |
| 关键词 | `listing.md` 的「关键词」段 |
| 描述 | `listing.md` 的中英文描述 |
| 截图 | `store/screenshots/mac-1440x900.png`（简中）、`-en.png`（英文） |
| 隐私政策 URL | **必须是一个公网地址**，内容取自 [store/privacy-policy.md](../store/privacy-policy.md) |
| 支持 URL | 同上，可指向同一个站点或邮箱页 |
| 出口合规 | 仅使用系统标准加密，按豁免申报 |

### 隐私政策 / 支持页托管

商店要求的是**可访问的 HTTPS 地址**，不是文件。三个低成本选项：

1. **GitHub Pages**（免费）——在仓库里放 `docs/` 并开启 Pages。
   注意：这只是托管静态页面，与"用 GitHub 分发应用安装包"是两回事。
2. Cloudflare Pages / Netlify（免费额度足够）
3. 自有域名静态页

---

## 四、审核重点（提前规避）

| 条款 | 风险点 | 我们的处理 |
|---|---|---|
| **3.1.1** | 应用内出现任何"付费解锁"逻辑 | 商店版**不含**授权代码；`process.mas` 分支只影响更新与沙箱 |
| **2.4.5** | 沙箱合规、文件访问需说明用途 | 已有 `user-selected.read-write` + 书签授权，且只在用户主动选择后生效 |
| **2.1** | 应用完整性、无崩溃 | `verify:mas` 在真实打包产物上跑 257 项自检 |
| **反引导** | 不得引导用户去站外购买 | 商店版不出现任何外部购买链接或价格对比 |
| 自更新 | 商店版自带更新器会被拒 | `auto-update.ts` 在 `process.mas` 时直接短路，已断言 |

---

## 五、版本号与构建号策略

两者独立，**不要混用**：

| 字段 | 含义 | 何时改 |
|---|---|---|
| `package.json` 的 `version`（→ `CFBundleShortVersionString`） | 市场版本 | 每次对外发布：`0.1.0` → `1.0.0` |
| `mas.bundleVersion`（→ `CFBundleVersion`） | 构建号（整数） | **每次上传都递增**，包括同一市场版本的重新上传 |

上传被拒但提示"构建号重复"时，只需把 `bundleVersion` 加一。

---

## 六、提交前自检清单

```bash
# 1. 全部验证（257 项断言 + 打包产物自检）
npm run verify:all
npm run pack:verify

# 2. 商店版专用校验（静态 + 真实 MAS 包自检）
npm run verify:mas

# 3. 确认版本号与构建号已更新
grep -n '"version"' package.json
grep -n 'bundleVersion' electron-builder.yml
```

四条都通过再上传，可以避免绝大多数"上传后才发现"的问题。

---

## 七、已知限制

| 项 | 状态 |
|---|---|
| 构建签名 | 当前 `identity: null`（本地验证用），提交前必须配置真实证书 |
| 公证 | MAS 不需要公证（走商店分发），站外版才需要 |
| Windows / Linux | 未做真机验证；本期只上 MAS |
| 自动更新 | 商店版由 App Store 负责；站外版暂缓 |
| `app-update.yml` | MAS 包内仍存在，但 `process.mas` 会短路更新器，且沙箱禁止改写 App 包，实际不可用。若审核追问可移除 |
