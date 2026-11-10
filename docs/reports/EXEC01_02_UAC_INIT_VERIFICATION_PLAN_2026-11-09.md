# EXEC-01-02：UAC 初始化验证方案（待用户确认后执行）

状态：**初始化方案待验证、真实隔离未收口**。

本文件是**执行方案**，不是结果。执行前需要用户明确同意。

## 0. 术语更正（2026-11-09）

先前表述"创建档案**必须**提权"**过度断言**。准确表述是：

> **本机在非提权进程中创建档案失败（`E_ACCESSDENIED`）；提权后是否成功，尚未验证。**

已排除的其它原因（实测）：令牌为普通中等完整性、无受限 SID；`%LOCALAPPDATA%\Packages` 可写；
AppContainer 注册表键可写；`DeriveAppContainerSidFromAppContainerName` 成功。

## 1. 范围（不扩大系统权限）

初始化**只**做三件事，全部限定在指定档案：

| 动作 | 对象 |
|---|---|
| 创建 AppContainer 档案 | 仅 `<prefix>-<projectHash>`（本项目档案名） |
| 验证派生 SID | 同一名字，只读 |
| 记录归属 | 当前用户名 + 档案名 + SID 字符串（写入本地状态目录，不入库） |

**不做**：不改系统服务、不加防火墙规则、不改其它用户档案、不写 HKLM、不安装驱动、不改全局 ACL。

## 2. 前置条件

- 一个**目标普通用户**账户（下文称「用户 U」），用于运行真实沙箱；
- 用户 U 的密码（用于"标准用户输入另一管理员凭据"的场景）；
- 明确同意本次 UAC 提权。

## 3. 场景 A：同账户提权（U 本人是管理员，提权后回到 U）

1. 以**用户 U** 登录（非提权会话）；
2. 运行 `sandbox-helper.exe init-sandbox --confirm-create-profile --profile astarray-exec-<hash>`；
3. UAC 弹出 ⇒ **确认**（这是唯一提权点）；
4. 期望输出：`profile-created name=…` + `derive-ok`；
5. **退出该提权进程**；
6. 回到**非提权**会话，执行 §5 的四项验收。

## 4. 场景 B：标准用户输入另一管理员凭据（U 不是管理员）

1. 以**用户 U**（标准用户）登录；
2. 运行同一条 `init-sandbox` 命令；
3. UAC 弹出 ⇒ 输入**管理员账户 A** 的凭据；
4. 期望：档案建在 **U** 的档案空间下（`%LOCALAPPDATA%\Packages\` 属 U），SID 属 U；
5. **退出提权进程**；
6. 以 U（非提权）执行 §5。

> 关键判定：档案必须**属于 U**（发起者），不是属于 A。若档案落在 A 名下，
> 则 U 运行期 `Derive` 拿不到 SID ⇒ 该场景**失败**，需改为"每个用户各自初始化"。

## 5. 验收（必须在**提权进程退出后**、以普通用户执行）

| # | 检查 | 期望 | 判定依据 |
|---|---|---|---|
| 1 | 正常执行 | 沙箱内 Node 打印一行并退出 0 | 真实 stdout + 退出码 |
| 2 | 文件越界拒绝 | 读取**未授权**目录（如另一个项目根、用户桌面）失败 | 错误码/异常，且**确实未读到内容** |
| 3 | 网络拒绝 | `https` 请求与 DNS 解析均失败 | 连接错误 / 解析失败 |
| 4 | 子进程限制 | 并发起超过登记上限的子进程被拒 | 创建失败，进程数不超限 |

四项**全部**通过才算"真实隔离收口"。

## 6. 跨项目并发隔离（同一用户、两个项目）

**风险**：两个项目若共用一个 `astarray-exec` SID，又各自把项目目录授权给该 SID，
则项目 A 能读项目 B。**这正是必须避免的**。

**设计**：档案名按**项目标识**派生（`astarray-exec-<sha256(projectId)[:12]>`）⇒ 每个项目一个独立 SID。

**验证步骤**（同一用户 U，非提权）：

1. 初始化两个档案：项目 A、项目 B（各自一次提权，或安装期一次建两个）；
2. 并发启动两个沙箱：A 的进程尝试读 **B 的项目目录**，B 的进程尝试读 **A 的项目目录**；
3. 期望：**双向都失败**；
4. 同时各自读**自己的**项目目录：**都成功**。

若任一方读到了对方目录 ⇒ 判失败（说明共用了 SID 或授权被累积）。

## 7. 未通过时的状态

在 §5 与 §6 全部通过前，本卡状态保持：

> **初始化方案待验证、真实隔离未收口。**

并明确：以下**均不构成**"开箱即用"的证据 ——
① 成功分支的断言（从未真实执行）；② SID 派生可用；③ 拒绝路径测试；
④ 参数构造与协议测试。

## 执行记录（2026-11-10，用户已批准触发）

用户已明确同意触发本次 UAC 验证。实际尝试与结果：

| 尝试 | 方式 | 结果 |
|---|---|---|
| 1 | `Start-Process pwsh -Verb RunAs` 包装（写日志） | 进程返回，**未生成日志**，无 `astarray-exec` 档案 |
| 2 | `Start-Process sandbox-helper -Verb RunAs -PassThru -Wait` | 长时间挂起（无 `consent.exe` 出现），已终止 |
| 3 | `Start-Process cmd /c "helper … > log" -Verb RunAs` | `exit=1`，**无日志** |
| 4 | 同上 + 显式 `1>` 重定向与 ERRORLEVEL | `exit=1`，**无日志** |

**环境事实**（实测）：
- 当前进程 `本机账户`，`IsInRole(Administrator) = False`（未提权）；
- 非提权直接运行 `sandbox-helper.exe init-sandbox …` ⇒ `HRESULT=0x80070005`（预期）；
- 触发 UAC 期间**未见 `consent.exe`**，也**未生成任何日志文件**。

**结论**：本会话（非交互式宿主）**无法真正弹出并完成 UAC 同意**，
因此 EXEC-01-02 的成功分支**仍未验证**。这不是"已执行但失败"，而是"**没能发起提权**"。

## 需要用户在本机交互式执行

请在**你自己登录的桌面会话**中打开一个 PowerShell，执行：

```powershell
cd C:\Users\<username>\Documents\astarray\astarray
.\native\sandbox-helper\sandbox-helper.exe init-sandbox --confirm-create-profile --profile astarray-exec
```

预期：弹出 UAC ⇒ 点"是" ⇒ 输出 `profile-created name=…` 与 `derive-ok`。

然后**关闭该提权窗口**，在**普通**PowerShell 中按 §5 的四项验收逐条执行并把输出贴回。
我据此更新本卡与台账（当前状态：`02 安装期初始化入口 = implemented-unverified`，成功分支未验证）。

## 执行记录（2026-11-10 第二段：用户已在桌面完成初始化）

**用户执行结果**（真实输出，非推断）：

```
profile-created name=astarray-exec
derive-ok
```

档案已存在：`%LOCALAPPDATA%\Packages\astarray-exec`（创建时间 2026-11-10 12:30）。

### 初始化成功后暴露的三个真实缺陷（已修）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 非提权 `run` 仍报 `CreateAppContainerProfile 失败: HRESULT=0x80070005`（档案明明已存在） | 回退派生只覆盖 `ERROR_ALREADY_EXISTS`/`0x800700B7`，**没覆盖 `E_ACCESSDENIED`**；而"档案已存在 + 调用者未提权"正是返回 5 的情形 | 把 `0x80070005` 也纳入派生回退（派生不需要提权） |
| 2 | 修 ①后 `UpdateProcThreadAttribute 失败: 87` | `SECURITY_CAPABILITIES` 结构**字段顺序错**：把 `CapabilityCount` 放在 `Capabilities` 指针之前 ⇒ 布局与 Win32 不一致 | 改为 `AppContainerSid, Capabilities, CapabilityCount, Reserved` |
| 3 | 属性列表缓冲区 | `Vec<u8>` 只有 1 字节对齐，属性列表要求指针对齐 | 改用 `Vec<usize>` 分配 |

### 验收进度（非提权执行，真实输出）

| # | 检查 | 结果 |
|---|---|---|
| — | Job Object 半区（`--no-appcontainer`） | ✅ `job-assigned` → `job-ok` → `exit-code 0` |
| 1 | AppContainer 内正常执行 | ❌ `CreateProcessW 失败: 5`（拒绝访问） |
| 2–4 | 文件越界 / 网络 / 子进程 | 未执行（被 ①阻塞） |

### 结论与下一步

- **初始化（提权建档案）已真实验证通过**：`profile-created` + `derive-ok` + 档案目录存在；
- **Job Object 限额半区已真实验证通过**；
- **AppContainer 执行半区仍失败**（`CreateProcessW` 返回 5）。

**最可能原因**：AppContainer SID 对目标可执行文件（`C:\Windows\System32\cmd.exe` 亦然）没有读取/执行权限，
即"档案建好后还需要把受控执行所需路径**授权给该 SID**"这一步尚未实现——这一步需要提权，
属安装期 provisioning 的一部分（EXEC-01-04/05），不是 `run` 阶段能自行完成的。

**因此 EXEC-01-02 状态**：初始化分支 **verified**；受控执行分支 **仍 implemented-unverified**，
断点在上面的"授权给 SID"。

## 执行记录（2026-11-10 第三段：用户在普通窗口跑验收）

用户实测输出（真实）：

| 检查 | 结果 |
|---|---|
| 1 沙箱内正常执行 | `CreateProcessW 失败: 5` |
| 2 文件越界 | `CreateProcessW 失败: 5` |
| 3 网络拒绝 | `CreateProcessW 失败: 5` |
| 对照 `--no-appcontainer` | ✅ `job-assigned` → `job-ok` → `exit-code 0` |

**结论**：Job Object 半区通过；AppContainer 半区在**进程创建**这一步就失败（连检查 2/3 都跑不到）。

### 追加排查（本轮）

| 排查 | 结果 | 含义 |
|---|---|---|
| `probe` | `derive` 成功、**`appcontainer-created sid-present=true`**、`job-created` | 非提权下**建档案**本身可行；不是权限面被整体封死 |
| 显式给工作目录（`%LOCALAPPDATA%\Packages\<profile>\Temp`） | 仍 `失败: 5` | **不是**"继承父进程工作目录导致无权" |
| 显式全路径 `C:\Windows\System32\cmd.exe` | 仍 `失败: 5` | **不是** PATH 解析问题 |

**仍未定位**：`CreateProcessW` 在挂载 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 后返回
`ERROR_ACCESS_DENIED`。已排除：档案不存在、结构布局错、缓冲区对齐、工作目录、PATH。

**下一步排查顺序（未做）**：
1. 用 `icacls` 查 `astarray-exec` 的 SID 对 `cmd.exe` 的实际 ACL（确认是否缺 `ALL APPLICATION PACKAGES` 读执行）；
2. 用同一 SID 建一个**最小**测试（仅 `CreateProcessW` + 空 capability），确认是否与 capability 集为空有关；
3. 检查档案创建者上下文（提权建 vs 非提权建）是否影响 SID 可用性——`probe` 显示非提权建档案可行，
   可尝试用**非提权**方式重建同名档案后重测。

## 排查记录（2026-11-10 第四段：ACL 事实）

用 `icacls` 直接看两个目标可执行文件的 ACL（真实输出）：

| 目标 | `ALL APPLICATION PACKAGES` 授权 |
|---|---|
| `C:\Windows\System32\cmd.exe` | **有** `(RX)` |
| `C:\Program Files\nodejs\node.exe` | **没有**（`icacls` 无该条目） |

**两个结论**：

1. **node.exe 默认对 AppContainer 不可执行** ⇒ 即使 `CreateProcessW` 修好，
   验收 §5 的第 1–3 项（都用 `node -e`）仍会失败在"无法执行 node"。
   ⇒ **运行时路径必须显式授权给项目派生 SID**，这是安装期 provisioning 的一部分（EXEC-01-04）。
2. `cmd.exe` 有 `(RX)` 却仍返回 5 ⇒ `CreateProcessW 失败: 5` **不是**"目标文件不可读"，
   问题在**进程创建属性**本身（capability 集为空 / 属性列表构造 / 令牌约束）。

**因此下一步（按顺序）**：

1. 给 helper 加 `print-sid` 子命令（`ConvertSidToStringSidW`），拿到 `astarray-exec` 的**权威 SID 字符串**
   （本轮用名称哈希手算的 `S-1-15-2-2959418034-…` **无法被 Translate 解析**，说明手算不可信，不得据此下结论）；
2. 用权威 SID 复核 `cmd.exe`/`node.exe` 的 ACL；
3. 做**最小复现**：只调 `CreateProcessW` + 空 capability（不建 Job、不建属性列表外的任何东西），
   确认 5 是否来自属性列表；
4. 修好后**再**请用户复跑 §5 四项，并先补 node 路径授权。

## 排查工具：`print-sid`（2026-11-10）

新增子命令，用系统 API（`DeriveAppContainerSidFromAppContainerName` + `ConvertSidToStringSidW`）
打印档案的**权威 SID 字符串**：

```powershell
.\native\sandbox-helper\sandbox-helper.exe print-sid --profile astarray-exec
# → profile=astarray-exec sid=S-1-15-2-3142755585-…（7 段）
```

**为什么必须用 API**：此前按名称哈希手算得到 `S-1-15-2-2959418034-…`（4 段），
既不等于真实值、也无法被 `Translate` 解析 —— **手算不可信，不得据此判断 ACL**。

### 据此复核到的事实

| 检查 | 结果 |
|---|---|
| 档案目录存在 | ✅ `%LOCALAPPDATA%\Packages\astarray-exec` |
| `cmd.exe` 对 AppContainer | ✅ 有 `ALL APPLICATION PACKAGES:(RX)`（`icacls` 按名称显示，故 grep `S-1-15-2` 无结果） |
| `node.exe` 对 AppContainer | ❌ 无该条目 ⇒ **node 默认不可被容器执行** |
| 我们的档案 SID 是否在 `node.exe` ACL 中 | ❌ 没有 |

⇒ 即使 `CreateProcessW` 修好，`node -e` 类验收仍会失败在"无法执行 node"。
必须把运行时路径授权给**项目派生 SID**（安装期 provisioning，属 EXEC-01-04）。

**`CreateProcessW 5` 仍未定位**；已排除：档案不存在、结构布局、缓冲区对齐、工作目录、PATH、目标文件不可读。
