# EXEC-01-02 平台实现清单（沙箱与基础工具链）

日期：2026-11-09。状态：**清单已提交，编码未完成**。对应卡：[EXEC01_CONTROLLED_EXECUTION_AND_CAPABILITY_CLOSURE.md](../tasks/EXEC01_CONTROLLED_EXECUTION_AND_CAPABILITY_CLOSURE.md) §02。

本文件是卡内 §02 要求的"首先提交平台实现清单"，逐项注明系统隔离原语、可再分发组件、最低系统要求与验证方式。**它不是完成声明**：清单之后的真实适配、资源打包与干净设备验收尚未进行，见 §5 阻塞项。

## 1. 约束回顾（来自卡内，不得放宽）

- 产品安装**不得**要求用户预装 Docker、WSL、虚拟机管理软件、Python、Git 或编译工具；
- Docker 只可作为可选适配，**不能**用其测试结果代替默认后端验收；
- 禁止仅用 cwd、环境变量白名单或普通受限账户名称冒充完整隔离；
- 基础交付至少包含：版本固定的沙箱执行辅助组件、**独立 Node.js 运行环境**（不是假设宿主可当解释器）、Node 标准库与离线测试夹具；
- 默认禁止网络、不暴露宿主控制接口/用户目录/设备/凭据；文件访问、子进程、提权限制与 CPU/内存/进程数/磁盘额度由底层机制落实；
- 启动前逐项探测能力，不支持则**阻断该执行**并把该平台列为未达交付要求，而不是标成"可选功能"。

## 2. 候选隔离原语（逐平台）

### 2.1 Windows（x64 / arm64）

| 项 | 内容 |
|---|---|
| 原语 | **AppContainer**（低权限完整性 + 能力集为空）+ **Job Object**（内存/CPU/进程数/子进程限制）+ 受限令牌 |
| 为什么不是其它 | 仅 Job Object 只限资源、不限文件/网络/注册表访问；仅受限令牌无法可靠阻断网络与设备。两者叠加才能同时满足"文件范围 + 无网络 + 资源额度" |
| 最低系统 | Windows 10 1809 及以上（AppContainer 稳定可用）；arm64 需同样验证 |
| 可再分发组件 | 自研原生辅助程序（Rust 或 C++，静态链接 CRT），**不含**任何第三方运行时；Node.js 官方 Windows 构建 |
| 许可 | 辅助程序随产品分发（自有）；Node.js 按其许可随包分发 |
| 验证方式 | ① 进程内 `Get-AppContainerSid`/令牌能力集为空；② 网络连接尝试必须失败；③ 对宿主 `%USERPROFILE%`、`C:\Windows`、注册表 HKCU 的读取必须失败；④ 超出 Job Object 额度必须被终止并报资源耗尽 |
| 风险 | AppContainer 下 Node 需要可写的临时目录与命名管道支持；需实测确认 stdlib 与 `node --test` 可用 |

### 2.2 Linux（x64 / arm64）

| 项 | 内容 |
|---|---|
| 原语 | **bubblewrap**（unprivileged user namespaces + mount namespace + network namespace + seccomp 过滤） |
| 为什么不是其它 | 仅 chroot 需 root；仅 cgroup 不限文件系统视图；bubblewrap 是扁平化、可再分发的单一静态二进制 |
| 最低系统 | 内核 ≥ 5.10，且允许非特权 user namespace（部分发行版默认关闭 ⇒ 探测必须如实报不可用） |
| 可再分发组件 | bubblewrap 静态构建（版本固定、SHA256 登记）、Node.js 官方 Linux 构建 |
| 许可 | bubblewrap 为 LGPL-2.1+，需随包提供许可与来源；Node.js 按其许可 |
| 验证方式 | ① `/proc/self/status` 的 `CapEff` 为 0；② 网络命名空间内无外网；③ 宿主路径不可见（mount namespace 只挂载受控快照）；④ cgroup v2 额度生效 |
| 风险 | 发行版 `kernel.unprivileged_userns_clone=0` 时不可用 ⇒ 按"未达交付要求"记录，**不得**退回无隔离执行 |

### 2.3 macOS（x64 / arm64）

| 项 | 内容 |
|---|---|
| 原语 | **App Sandbox**（`sandbox_init` / `sandbox-exec` 的 seatbelt profile）+ `setrlimit` 资源限制 |
| 为什么不是其它 | macOS 无 Linux 式 namespace；seatbelt 是系统自带且可编程的唯一可行原语 |
| 最低系统 | macOS 12 及以上 |
| 可再分发组件 | 自研辅助程序（签名 + 公证），Node.js 官方 macOS 构建 |
| 许可 | 辅助程序自有；Node.js 按其许可 |
| 验证方式 | ① 沙箱 profile 拒绝网络与宿主目录；② `setrlimit` 生效；③ 子进程继承限制 |
| 风险 | `sandbox-exec` 已被 Apple 标记为 deprecated（仍可用）；若未来移除需改用 App Sandbox 的 entitlement 方案 |

## 3. 资源清单字段（每个平台/架构一项）

| 字段 | 说明 |
|---|---|
| `platform` / `architecture` | 例如 `win32` / `x64` |
| `componentIdentifier` | `sandbox-helper` 或 `node-runtime` |
| `componentVersion` | 版本固定（不得"最新"） |
| `sha256` | 交付物内容哈希 |
| `sourceDescription` | 来源（自研构建流水线 / 上游发行版地址） |
| `licenseIdentifier` | SPDX 标识 |
| `minimumSystemRequirement` | 例如 `windows-10.1809` |
| `isIntegrityRequired` | 恒 `true`（缺失即阻断该执行） |

辅助程序**只从产品管理路径加载**，不搜索用户 `PATH`。

## 4. 探测与自检（已编码部分）

已实现且已测：

- `packages/core/src/execution/sandbox-capability-probe.ts`
  - `verifySandboxResourceManifest`：逐项校验存在性、SHA256 一致性、平台/架构匹配；
  - `probeSandboxCapability`：按"当前平台 → 清单项 → 完整性 → 版本"顺序探测，返回**具体原因**，
    不可用时给 `reasonUnavailable`，绝不返回 `isAvailable: true` 的模糊结果；
  - 无清单项 / 哈希不符 / 组件缺失 / 平台未支持 四种情形分别有稳定原因码。

未实现（属 §02 编码剩余）：真实辅助程序与 Node 运行时打包、安装自检执行、原子升级与损坏修复。

## 5. 阻塞项（需要用户或外部条件）

| 阻塞 | 具体内容 | 需要谁 |
|---|---|---|
| B1 原语决策 | 上表三种原语是否作为首版支持范围；是否接受 macOS 的 deprecated `sandbox-exec` 路线 | 用户（安全与产品决策） |
| B2 依赖与构建授权 | 需要新增原生构建链（Rust 或 C++ 工具链）与签名/公证流程；按卡内施工纪律"新增依赖需先询问并取得安装授权" | 用户 |
| B3 二进制分发 | 三个平台 × 两个架构的辅助程序与 Node 运行时需要随包分发（体积与供应链），需确定分发载体（npm 可选依赖 / 独立安装包） | 用户 |
| B4 干净设备验收 | §06 要求"无 Docker/WSL/外部工具链、无开发者缓存的干净设备"验收真实交付包 | 外部条件（虚拟机或独立机器） |

在上述四项落地前，**02 不能标 implemented**；当前状态为"清单已提交、探测已编码、真实后端未交付"。
