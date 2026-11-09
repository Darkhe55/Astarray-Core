# EXEC-01-02 B1：Windows 沙箱真实可行性验证（2026-11-09）

对应裁决第 3 项：**逐平台证明隔离和正常执行同时成立，不以接口、布尔探测或模拟测试代替真实后端**。

本文件只报告**本机实际跑出来的结果**。未验证的部分明确标为未验证。

## 1. 环境

| 项 | 值 |
|---|---|
| 平台 | Windows（`DESKTOP-*`） |
| 进程完整性 | **非管理员**（`IsInRole(Administrator) = False`） |
| 编译 | `rustc 1.97.1` + MSVC `link.exe` + Windows SDK（均已有，**未新增依赖**） |
| 辅助程序 | `native/sandbox-helper`（纯 `extern "system"` FFI，**零第三方 crate**） |

## 2. 已真实验证：Job Object 半区（资源隔离）

辅助程序以 `CREATE_SUSPENDED` 创建子进程 → **先** `AssignProcessToJobObject` → **再** `ResumeThread`，
保证限额先于执行。

| 验证项 | 命令要点 | 实测结果 |
|---|---|---|
| 正常执行成立 | `run --no-appcontainer -- node -e "console.log('ok')"` | `exit-code 0`，输出 `ok` ✅ |
| 参数保真（含空格/引号） | `-- node -e "console.log('带 空格 的参数')"` | 输出 `带 空格 的参数` ✅ |
| 内存上限生效 | `--max-memory-mb 64` + 子进程无界分配 | 子进程 `RangeError: Failed to allocate memory`，未突破限额 ✅ |
| 进程数上限生效 | `--max-processes 3` + 并发起 8 个子进程 | 第 4 个起 `Error: spawn UNKNOWN`（作业拒绝创建）✅ |
| 超时终止**整个进程树** | `--timeout-ms 3000` + 子进程 `setTimeout(60000)` | `timed-out`、`exit 124`、**3.1 秒返回**，无残留子进程 ✅ |

### 2.1 过程中修掉的两个真实缺陷（不是测试问题）

1. **参数未引用**：早期实现用空格拼接参数，`node -e "…含空格…"` 被拆成多个参数，子进程收到残缺脚本后语法错误。
   已实现与 `CommandLineToArgvW` 一致的引用算法。
2. **超时不杀进程树**：早期实现只打印 `timed-out` 就退出，**子进程继续跑满 60 秒**，
   调用方的输出管道一直被占着 —— 表面"已取消"、实际资源仍在跑。现在超时会 `TerminateJobObject`，
   实测 3.1 秒返回且无残留。**这条正是卡内"取消必须真的停住"的要求，属于实测发现的产品缺陷。**

## 3. 未能验证：AppContainer 半区（文件/网络隔离）

**实测结果**：`CreateAppContainerProfile` 在非管理员进程中返回
`E_ACCESSDENIED (0x80070005)`；`DeleteAppContainerProfile` 同样 `0x80070005`。

```
appcontainer-unavailable CreateAppContainerProfile 失败: HRESULT=0x80070005
```

**这不是接口缺失或探测失败，而是权限模型约束**：创建 AppContainer 档案需要提权。
非提权进程无法在运行时创建档案，因此"运行期临时建沙箱档案"的路线在普通用户下**不可行**。

**因此 AppContainer 的文件/网络隔离在本机未验证**，不能声称"隔离成立"。

## 4. 可行的两条路线（需你裁决）

| 路线 | 做法 | 代价 | 是否需提权 |
|---|---|---|---|
| A. 安装期预建档案 | 安装包（B3）以 UAC 提权执行一次 `CreateAppContainerProfile`，运行时只 `DeriveAppContainerSidFromAppContainerName`（无需提权） | 安装时需要一次 UAC；档案名需固定且可升级 | 仅安装期 |
| B. 非提权后备 | 受限令牌（低完整性）+ Job Object：资源隔离已验证，文件写隔离依赖低完整性 ACL，**网络默认不封** | 隔离强度弱于 AppContainer；无网络阻断 | 不需要 |

裁决第 6 项要求"默认隔离不可用时禁止静默退回无限制宿主执行" —— 两条路线都不属于"无限制宿主执行"，
但 B 的强度明显更弱，需要你确认是否可接受作为**降级档**（并明确对外标注强度）。

## 5. 仍未做（如实）

- **Linux（bubblewrap）**：本机无 Linux 环境，**未验证**；
- **macOS（App Sandbox 辅助程序）**：无 macOS 机器与签名身份，**未验证**；
- AppContainer 的文件系统/网络隔离反例（网络必须失败、宿主目录不可读）：因 §3 权限约束**未验证**；
- 本辅助程序尚未接入 `ProcessExecutionController` 的 `SandboxExecutionBackend` 端口（下一步）。
