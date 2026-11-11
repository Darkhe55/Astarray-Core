# EXEC-01-02 根因定位（2026-11-11）：`CreateProcessW` 错误 5 的隔离结论

> 本轮前提（用户明确要求）：**不把错误码 5 等同为"必须安装期提权"**；
> 优先为**应用自带运行时**设计最小权限配置；真要改系统权限时，单独列明账户/对象/权限/回滚并请求授权。

## 1. 决定性隔离实验

新增诊断开关 `--empty-attributes`（属性列表按 0 项初始化，仍带
`EXTENDED_STARTUPINFO_PRESENT`），与完整属性路径对比：

| 运行 | 结果 |
|---|---|
| `run --profile astarray-exec2 --empty-attributes -- cmd.exe /c "echo ok"` | ✅ `job-assigned` → `ok` → `exit-code 0` |
| `run --profile astarray-exec2 -- cmd.exe /c "echo ok"` | ❌ `CreateProcessW 失败: 5` |
| `run --no-appcontainer -- cmd.exe /c "echo job-ok"` | ✅ 通过（Job Object 半区正常） |

**结论**：`CreateProcessW` 的参数、`STARTUPINFOEX` 结构与
`EXTENDED_STARTUPINFO_PRESENT` 标志**都是对的**——
空属性列表能成功创建进程。失败**只**发生在挂上
`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 这一条属性时。

因此"错误 5"**不是**"整个沙箱必须提权"，也**不是**"目标文件不可读"
（`cmd.exe` 对 `ALL APPLICATION PACKAGES` 有 `(RX)`）。

## 2. 顺带发现的一处异常

| 观察 | 值 |
|---|---|
| `init-sandbox --profile astarray-exec2`（**非提权**） | 输出 `profile-created name=astarray-exec2` + `derive-ok`，退出码 0 |
| `%LOCALAPPDATA%\Packages\astarray-exec2` 是否存在 | **不存在** |
| `%LOCALAPPDATA%\Packages\astarray-exec`（提权创建的） | 存在，但**缺 `Temp` 子目录** |

⇒ "创建成功"只意味着**SID 可派生**，不代表档案在磁盘/注册表被**完整物化**。
而 `SECURITY_CAPABILITIES` 路径需要完整档案才能建出容器令牌，
这与"只有这条属性失败"的现象一致。

## 3. 最小权限方案（不需提权，优先采用）

既然 Job Object 半区已证明可用，建议**应用自带运行时**走"受限令牌 + Job Object"：

| 机制 | 是否需要提权 | 已在本机验证 |
|---|---|---|
| Job Object（内存/进程数/CPU 限额） | 否 | ✅ `job-assigned` / 限额生效 |
| 受限令牌（`CreateRestrictedToken`，按需 deny-only SID） | 否 | 未验（下一步） |
| AppContainer（`SECURITY_CAPABILITIES`） | 创建档案本身**不需**提权（已验），但需档案完整物化 | ❌ 当前失败 |

**下一步实现顺序**：
1. 给 helper 加 `CreateRestrictedToken` + `CreateProcessAsUser`（或 `CreateProcessW` 配受限令牌）路径；
2. 与 Job Object 组合，验证文件越界/网络/子进程三项；
3. 若受限令牌仍不足，再回到 AppContainer——那时才需要讨论系统权限变更。

## 4. 若确需修改系统权限（**本轮未做，需授权**）

仅列预案，**未执行**：

| 项 | 内容 |
|---|---|
| 账户 | `本机账户`（SID `SID |
| 对象 | `C:\Program Files\nodejs`（应用自带运行时的实测位置） |
| 权限 | 对该 AppContainer SID 授予 `(OI)(CI)(RX)`（读+执行，**不含写**） |
| 需提权 | 是（改 ACL 需要管理员） |
| 回滚 | `icacls "C:\Program Files\nodejs" /remove:g "<SID>" /T`；执行前先 `icacls ... > backup.acl` 留底 |
| 影响面 | 只增加该 SID 的读执行，不改变其他用户/其他容器 |

**为什么现在不要做**：错误 5 已定位到属性而非 ACL（第 1 节），
先按第 3 节做无提权方案；若最终仍需 AppContainer，再拿这张表请你批准。

## 5. 本轮状态

- `--empty-attributes` 诊断开关已加入源码（`native/sandbox-helper/src/main.rs`）；
- EXEC-01-02 状态**不变**：初始化 verified，受控执行 **implemented-unverified**；
- **未申请、也未执行**任何系统权限变更。
