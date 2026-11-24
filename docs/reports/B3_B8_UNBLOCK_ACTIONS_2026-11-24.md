# B3–B8 阻塞解除清单（2026-11-24）

> 依据你最新的优先级指令：**B3 → B8 先做，B9 最后做**。
> 本文件只回答两件事：**现在卡在哪**、**你（用户）需要做什么才能解除**。
> 每一项都给出可复制的命令与"做完后我能继续什么"。

## 0. 当前状态（本机实测）

```text
node scripts/verify-exec01-03-preconditions.mjs
→ platform-supported: ok（win32/x64）
→ sandbox-helper-built: blocked（缺 native\sandbox-helper\sandbox-helper.exe）
→ rust-toolchain: blocked（未找到 rustc/cargo/link/cl）
→ elevated-for-appcontainer: blocked（当前会话非管理员）
→ readyForAcceptance: false
```

本机事实：Windows 10.0.26300 x64、Node v26.13.1、winget 1.29、**非管理员会话**。

## 1. B3 / B5：真沙箱后端（Windows）

### 卡在哪

| 项 | 现状 |
|---|---|
| 代码 | 已有 `native/sandbox-helper/src/main.rs`（AppContainer + Job Object，零第三方 crate）与 TS 侧 `sandbox-helper-backend.ts` 接线 |
| 前置 ① | 本机无 Rust/MSVC 工具链 ⇒ 无法编译 `.exe` |
| 前置 ② | `CreateAppContainerProfile` 需**一次提权**；非管理员返回 `E_ACCESSDENIED` |

### 你需要做的（两步）

**第一步：安装工具链**（需网络 + 安装授权；约 10–20 分钟）

```powershell
winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements `
  --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
rustup default stable-msvc
```

> 安装后新开一个终端，确认 `rustc --version` 能输出。

**第二步：构建 + 一次提权探测**

```powershell
# 普通会话（构建；probe 预期报 appcontainer-unavailable，这是正常的"还差提权"证据）
node scripts/build-sandbox-helper.mjs

# 管理员会话（只跑一次 probe，创建 AppContainer 档案）
& .\native\sandbox-helper\sandbox-helper.exe probe

# 回到普通会话复检
node scripts/verify-exec01-03-preconditions.mjs --strict
```

### 做完后我继续什么

- 把 `readyForAcceptance=true` 的 JSON 记入 PLAN_STATUS；
- 跑 EXEC-01 验收（受控执行、资源上限、超时、输出扫描），把结果写进 EXEC-01 卡；
- 若 probe 仍失败，我按输出分类排查（Job Object 半区可先用 `--no-appcontainer` 单独验证）。

## 1.5 B3 实测结论（2026-11-25，用户机）

| 会话 | `helper run ... cmd /c echo` | 结论 |
|---|---|---|
| **管理员** | `job-assigned` + 输出 + `exit-code 0` | AppContainer 进程创建成功 |
| **普通用户** | `CreateProcessW 失败: 5`（ACCESS_DENIED） | 非提权父进程无法创建 AppContainer 子进程 |

补充实验：尝试 LPAC（`--lpac`，退出 ALL APPLICATION PACKAGES）在普通会话下同样不可用
（`UpdateProcThreadAttribute` 返回 **50 / ERROR_NOT_SUPPORTED**）。工作目录已修正为
`%LOCALAPPDATA%\Packages\<profile>\AC\Temp`（并主动创建），排除"cwd 不可访问"这一假设。

**这不再是代码缺陷，而是平台约束 + 产品裁决冲突**：

- 裁决要求"客户端整体不提权、运行期非管理员"；
- 但本机（Windows 10.0.26300）上，**非提权进程无法把子进程放进 AppContainer**。

可选方案（需要你裁决）：

| 方案 | 做法 | 代价 | 与既有裁决 |
|---|---|---|---|
| A. 安装期常驻 broker/service | 提权一次安装服务；普通会话经 IPC 请求它创建沙箱子进程 | 3–5 人日 + 安全评审 | **兼容**（运行期不提权） |
| B. 会话级提权 broker | 用户每次会话手动起一个提权 helper 进程 | 0.5–1 人日 | 冲突（需显式同意"提权会话"） |
| C. 换隔离原语 | 受限令牌 + Low IL + Job（不用 AppContainer） | 1–2 人日 | 冲突（隔离强度下降） |
| D. 维持 fail-closed | 不实现非提权执行；如实拒绝 | 0 | 兼容，但 B3 长期 blocked |

## 2. B6：Linux / macOS 平台证据

### 卡在哪

只有 Windows 物证；`EXEC-01` 的平台矩阵需要 Linux（bubblewrap）与 macOS 至少各一次真实执行证据。

### 你需要做的（二选一）

- **A. 提供一台 Linux 主机/CI runner**（Ubuntu 22.04+ 即可）：我能 SSH 或你本地执行；
- **B. 在 GitHub Actions/自建 CI 加一个 `ubuntu-latest` job**（我写好 workflow，你只需要允许运行）。

Linux 侧命令（给你或 CI 用）：

```bash
sudo apt-get update && sudo apt-get install -y bubblewrap
node scripts/verify-exec01-03-preconditions.mjs --strict
node scripts/verify-exec01-03-preconditions.mjs
```

macOS 当前**没有后端实现**（卡内明确"保留后继能力"）；若要求 macOS 证据，需要先裁决是否新增后端（这是产品决定，不是补测）。

### 做完后我继续什么

- 记录平台矩阵证据；把 B6 从"无证据"改为"有证据（范围明确）"；
- 如 Linux 上发现差异，按缺陷修复并补反例。

## 3. B7 / REMOTE-01：远程投递

### 卡在哪

代码只有**通用端口 + 本地假适配器**；真实 IM 平台未选定，因此没有：真实验签、回执查询、限流语义。
`platformSignatureValid` 目前是调用方传入的布尔声明 ⇒ 不能当作"平台验签已实现"。

### 你需要做的（选定平台后提供 5 项）

| # | 需要你提供 | 用途 |
|---|---|---|
| 1 | 平台名称 + 测试租户（sandbox） | 联调目标 |
| 2 | 签名算法与**一条测试向量**（原始请求 + 签名 + 密钥标识，密钥不入库） | 实现真实验签 |
| 3 | 单条消息回执查询 API（成功/失败/未知可区分） | 实现 `unknown` 语义 |
| 4 | 限流/重试语义（哪些错误可重试、退避上限） | 实现退避与幂等 |
| 5 | 凭据注入方式（本地环境变量名，不得进仓库） | 零凭据入库 |

### 做完后我继续什么

- 写平台适配器（`RemoteDeliveryTransport` 实现）+ 真实验签（替换布尔声明）+ 回执映射；
- 补反例：错项目/错设备/过期/重放/撤销/受理无回执 ⇒ `unknown` 不假成功；
- 跑一次端到端演练：`sent` / `unknown` / `refused` 各一次。

## 4. B8：人工体验签收

### 卡在哪

`E2E-01`、`GUI-01-R-04b`、`B6R-04b` 需要真人按脚本走查并签字；自动化只能给证据，不能代替签收。

### 你需要做的（约 30–60 分钟）

```powershell
npm run verify:internal-user-walkthrough   # 12 步自动走查（当前 12/12）
npm run verify:e2e01                       # fixture 端到端
```

然后按 [内部用户测试就绪度与使用说明](./INTERNAL_USER_TEST_READINESS_2026-11-24.md) §5 走一遍，
在签收表里记录：日期 / 执行人 / 通过项 / 不通过项 / 备注。

> `GUI-01-R-04b` 需要 Web GUI，**公开仓库不含 UI 源码**；要签收这一项，需要私有仓库或产品侧提供可运行构建。

### 做完后我继续什么

- 把签收结果写进对应卡片，状态从 `implemented-unverified` 改为 `done`（仅在你签字后）；
- 对不通过项开新反例并修复。

## 5. 我在等待期间会做什么（不需要你操作）

1. 为 B7 准备**平台适配器一致性夹具**（签名向量加载、回执状态映射、限流语义），在无平台时 fail-closed；
2. 为 B6 准备 Linux CI workflow 草案（你允许运行即可）；
3. 之后按你的指令**最后**再做 B9（当前 82.01%，差约 735 条分支）。

## 6. 一句话总结

- **B3/B5**：你装 Rust + VS Build Tools，然后跑 `node scripts/build-sandbox-helper.mjs` 并在管理员会话跑一次 `probe`；
- **B6**：给一台 Linux（本机或 CI），macOS 需先裁决是否做后端；
- **B7**：选定 IM 平台并给 5 项联调资料；
- **B8**：按脚本走查并签字（GUI 项需私有仓库构建）。

以上任一项完成后把输出贴给我，我立即接续对应验收，不再等齐全部。
