# 沙箱辅助程序（Windows）

EXEC-01-02 的受控执行后端：用**系统自带 API** 提供真实隔离，不使用第三方 crate。

## 构建

```powershell
rustc -O src/main.rs -o sandbox-helper.exe
```

需要 Rust（已装 MSVC 目标）与 Windows SDK 链接器。**不新增任何编译依赖。**

## 用法

```powershell
# 1) 原语探测（不是隔离验证，只证明 API 可用）
.\sandbox-helper.exe probe

# 2) 在沙箱中执行
.\sandbox-helper.exe run --profile astarray-exec --max-memory-mb 512 --max-processes 8 --timeout-ms 60000 -- node script.js
```

## 输出协议（供 `ProcessExecutionController` 解析）

| 行 | 含义 |
|---|---|
| `job-assigned` | 子进程已进入 Job Object（限额已生效） |
| `exit-code <n>` | 子进程正常结束，退出码 n |
| `timed-out` | 超时，已 `TerminateJobObject` 终止整棵进程树，退出码 124 |
| `appcontainer-unavailable <detail>` | AppContainer 不可用（非管理员） |
| `job-unavailable <detail>` | Job Object 创建/设限失败 |

子进程 stdout/stderr 直接透传（控制台继承）。

## 已知限制

- **`CreateAppContainerProfile` 需要提权**：非管理员进程返回 `E_ACCESSDENIED (0x80070005)`。
  因此 AppContainer 路线需要**安装期**预建档案，运行时只派生 SID。
- `--no-appcontainer` 仅用于**单独验证 Job Object 半区**，不是产品默认路径。
- 目前未接入 `ProcessExecutionController`（下一步）。
