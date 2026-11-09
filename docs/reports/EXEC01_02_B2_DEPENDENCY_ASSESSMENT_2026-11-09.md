# EXEC-01-02 B2：沙箱依赖评估（2026-11-09）

对应裁决第 4 项：**先检查已有工具链，列明最小新增依赖、版本、安装范围、用途及费用**。
本文件是**评估**，不是安装授权：新增安装、证书购买、签名账户使用均仍需单独申请。

## 1. 本机已有工具链（实测）

| 组件 | 实测结果 | 版本 |
|---|---|---|
| Node.js | 存在 | 见 `node --version`（构建与运行宿主） |
| npm | 存在 | 随 Node |
| Rust | **存在** | `rustc 1.97.1`、`cargo 1.97.1` |
| Rust 目标三元组 | 已装 `x86_64-pc-windows-msvc`（另有 Android 目标） | — |
| MSVC 链接器 | **存在** | `BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\link.exe` |
| Windows SDK | **存在** | `C:\Program Files (x86)\Windows Kits\10` |
| CMake | 存在 | `C:\Program Files\CMake\bin\cmake.exe` |
| Python | 存在 | `C:\Python314` |
| Git | 存在 | `C:\Program Files\Git` |
| signtool | **缺失** | 需 Windows SDK 组件（见 §3） |
| bubblewrap | **缺失**（Windows 上本就不适用） | 仅 Linux |
| WSL/容器 | 未使用（按卡内要求不得依赖） | — |

**结论**：Windows 侧的原生构建链**已经具备**（Rust + MSVC + Windows SDK + CMake），
因此 **B1 的 Windows 验证不需要新增编译工具链**。

## 2. 各平台最小新增依赖

### Windows（x64 / arm64）

| 项 | 最小需求 | 说明 |
|---|---|---|
| 编译 | **无新增**（已有 Rust + MSVC + SDK） | 辅助程序用 Rust，静态链接 CRT |
| 交叉编译 arm64 | `rustup target add aarch64-pc-windows-msvc` | 仅当要出 arm64 包；仍需 MSVC arm64 链接器组件 |
| 运行时 | 无（Windows 自带 AppContainer / Job Object） | 隔离原语是系统能力，不引入第三方运行时 |
| 签名 | `signtool`（Windows SDK 组件） | 仅发布签名需要；本地验证不需要 |

### Linux（x64 / arm64）

| 项 | 最小需求 | 说明 |
|---|---|---|
| 隔离原语 | `bubblewrap`（静态构建，版本固定） | 需在 Linux 机器上构建或使用发行版静态包；**本机为 Windows，无法在此验证** |
| 交叉编译 | 需 Linux 构建环境或交叉链接器 | 本机无 |
| 运行时 | 无（bubblewrap 单二进制） | 许可 LGPL-2.1+，需随包提供许可与来源 |

### macOS（x64 / arm64）

| 项 | 最小需求 | 说明 |
|---|---|---|
| 隔离原语 | App Sandbox（`sandbox_init`）+ `setrlimit` | 需 macOS 构建机与签名身份 |
| 编译 | Xcode Command Line Tools | 本机无 |
| 签名/公证 | Apple Developer Program 账号 | **需购买/独立申请** |

## 3. 费用与授权状态

| 项 | 费用 | 状态 |
|---|---|---|
| Rust / MSVC Build Tools / Windows SDK / CMake / Python / Git | 0（已具备） | **无需新增** |
| `rustup target add aarch64-pc-windows-msvc` | 0 | 未安装；需单独确认（会改本机 Rust 工具链） |
| `signtool`（Windows SDK 组件） | 0 | 缺失；安装属"新增安装"，**需单独申请** |
| Windows 代码签名证书（OV/EV） | 约 ¥1k–4k/年（视 CA 与类型） | **未购买，需你决定** |
| Apple Developer Program | US$99/年 | **未购买，需你决定** |
| Linux 构建机（或 CI 上的 Linux runner） | 0（可用现有 CI）或按云主机计价 | 未配置 |

## 4. 与 B1 验证的直接关系

- **Windows 的 AppContainer + Job Object 可行性验证**：现有工具链足够，**可以立即做**，
  只需要写辅助程序与验证脚本，不需要任何新安装或购买；
- **Linux 的 bubblewrap 验证**：本机无 Linux 环境 ⇒ 需要 Linux 机器/CI 或 WSL（卡内明确
  不得把 WSL 作为交付前提，但可作为**验证**手段？—— 卡内禁止的是"要求用户装 WSL"，
  不禁止开发者用 WSL 做实验；不过 WSL 内核与真实发行版不同，结论需标注边界）；
- **macOS 的 App Sandbox 验证**：需要 macOS 机器与签名身份 ⇒ 属外部条件。

## 5. 结论

1. Windows 侧**无新增依赖即可开始 B1 验证**；
2. Linux/macOS 的验证受**机器可用性**限制，不是依赖问题；
3. 需要你决定的只有三件：是否装 `signtool` 组件、是否购买 Windows 签名证书、
   是否购买 Apple Developer Program；
4. 本文不构成任何安装或购买授权。
