# EXEC-01：受控进程执行与工作能力闭环补充卡

日期：2026-11-09。状态：pending。核查基线：`5fa12ef3`。本卡补充已有任务范围，不追认已有模块为产品能力，不改变其它卡历史验收结论。

用户修订（2026-11-09）：取消用户预装 Docker/工具链的要求。执行能力依赖由产品交付负责，支持平台必须通过干净设备开箱即用验收；不把“提示用户自行找依赖”当作完成。

## 0. 现状与关联卡

- [TOOLKIT-01](TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md) 的 05 完成对象为 CSV→JSON 纯转换器，不启动进程；原完成状态保留，不代表通用程序执行完成。
- [AUDIT-REPAIR-01](AUDIT_REPAIR01_RUNTIME_CONFORMANCE.md) 最新记录：01 应用级 allow/deny 矩阵未闭合；03 缓存组件完成但未接生产；04 已完成当时候选分诊；05 prepack 失败保留。本卡只补执行与可观测性，不将上述遗留自动标 done。
- [SEC-02 通道矩阵](SEC02_CHANNEL_MATRIX.md) 当前命令输出通道以“无通用 shell”排除。新增执行后必须重新纳入 stdout/stderr、环境、日志、产物等安全检查，不继续使用不适用结论。
- `permission-capability-catalog.ts` 已有 process.execute-sandboxed / process.execute-host；权限项不是执行器。
- `mission-orchestrator.ts` 和 `git-integration-coordinator.ts` 内部使用 spawnSync 执行配置命令，不能直接包装为无限制模型工具。

## 1. 固定范围与施工规则

一次一个检查点，依次 01→02→03→04→05→06；超过三小时记录断点。先核对最新源码和在途修改，已有等价实现复用。修改前备份，变量名称清晰，时间字段带单位。

必须写反例、运行验证、更新本卡和相关状态；共享文档冲突时提交独立状态补丁。显式路径暂存，按检查点分别提交并尝试推送，不提交别人的改动。不运行付费 Provider。施工机器需要新增依赖时仍先询问已有资源并取得安装授权；此施工纪律不得转化为最终用户自行寻找依赖的产品前提。最终交付包含基础执行依赖，不改走无限制宿主兜底。

首版实现非交互、受限、有限时长的进程执行及查询/取消。模型使用一个工具族 `processExecution`，action 为 start/status/readOutput/cancel；不建立多个近义工具。只有次级分配后的执行 Agent 可使用，主 Agent 和 ponder 拒绝。每个 action 独立映射权限及参数规则，并保留已有整工具授权模式。

首版不实现任意宿主 shell、PTY、stdin 交互、持久开发服务器、任意网络或安装器执行。缺这些能力时返回精确 unsupported，不伪装成成功。后续范围见 §8，不能由 coder 顺手开放。

## 01：运行环境与执行契约

复用现有工具注册、策略包装、作用域门禁、环境白名单、任务预算和备份设施。工具参数不得包含宿主命令字符串或模型自报已授权字段。

start 参数：environmentIdentifier、executableIdentifier、arguments（字符串数组）、workingDirectory（项目相对目录）、timeoutMilliseconds、idempotencyKey。环境由认证控制面登记，包含确定的工具链/镜像版本、可执行标识映射、输入范围、输出范围、资源与网络策略；模型不得选择挂载、宿主路径、环境变量或容器启动参数。

timeout 默认 60000 毫秒，允许 1–180000 毫秒，仍取任务剩余预算更严值。首版无交互输入，stdin 关闭。模型不能直接选择 shell、包管理器或安装 action；项目脚本即使间接调用也不能突破底层资源边界。

执行 ID 由本地生成，绑定 project/agentInstanceId/mission/task/attempt、授权 revision 和环境指纹；同一幂等键同参数返回原执行状态，不重启进程，异参拒绝。status/readOutput/cancel 只能访问本主体及明确授权的上级可管理执行，不按显示名或裸 taskId 判断归属。

## 02：产品自带沙箱与基础工具链

实现可替换的 SandboxExecutionBackend 及真实平台适配，不绑定 Docker。产品安装不得要求用户预装 Docker、WSL、虚拟机管理软件、Python、Git 或编译工具来获得基础执行能力。Docker 只可作为可选适配，不能用其测试结果代替默认后端验收。禁止仅用 cwd、环境变量白名单或普通受限账户名称冒充完整隔离。

基础交付至少包含版本固定的沙箱执行辅助组件、独立 Node.js 运行环境（不是假设应用宿主可直接当解释器）、Node 标准库及离线测试夹具。基础目标是运行 JavaScript 项目脚本与 Node 内置测试；Python、编译器和其它运行时不冒称已支持，作为产品管理的扩展环境提供。不承诺任意项目依赖已预装，但新增环境必须由软件负责发现、说明、授权后安装及校验，不能让用户寻找下载地址、手动设置 PATH 或拼装环境。

每个宣称支持的系统/架构须提供匹配的真实后端与二进制资源。默认禁止执行网络、不暴露宿主控制接口、用户目录、设备或凭据；文件访问、子进程、提权限制和 CPU/内存/进程数/磁盘额度由底层机制落实。启动前逐项探测能力，不支持则阻断该执行，并将该平台列为未达交付要求，而非以“可选功能”掩盖失败。

02 首先提交平台实现清单，逐项注明采用的系统隔离原语、可再分发组件、最低系统要求和验证方式，然后编码真实适配。不得自行缩减已发布支持平台；无法实现的平台应记录发布阻塞。安全原语选择以实测满足本卡边界为准，不强行用同一种实现覆盖所有系统。

发布资源清单包含系统/架构、版本、SHA256、来源、许可及完整性认证机制；辅助程序使用产品管理路径加载，不搜索用户 PATH。完整安装载体必须离线包含基础执行资源。npm 分发允许 npm 本身所需的 Node 前提，但不额外要求用户安装沙箱引擎；按平台打包资源，不将 npm 的 Node 前提宣传成独立安装载体的前提。

安装后自动注册内置环境并运行无副作用自检。安装权限需要用户确认时由产品明确请求，不静默修改系统策略、启用系统功能或要求用户自己查教程。版本升级原子切换，失败保留上一个可用版本；运行中任务锁定原环境版本。组件损坏由产品提供修复流程，不擅自退回无隔离执行。首次运行基础任务不得临时联网下载依赖。

项目输入经已授权读取和敏感内容过滤后放入独立快照，不直接挂载完整宿主项目；拒绝逃逸链接和不受支持的特殊文件。受控快照和临时 scratch 可写，宿主原文件不可写。工具链来自固定环境，不继承宿主凭据或全局配置。

每次执行以独立暂存副本运行，保留执行前输入快照；覆盖、删除产生的变更可从该快照恢复。输出仅通过受控代理读取。首版禁止直接将整个输出树合回项目；模型修改项目仍用原有受保护写工具。大文件/输出磁盘超限终止并报告，禁止写满宿主磁盘。

集成真实后端及能力探测，不能只实现 SandboxCapabilityProfile 布尔接口。异常时其它产品功能继续运行并明确提示修复；但在声明支持的干净系统上基础执行不可用，属于发布阻塞，不能以正常降级结案。

## 03：异步生命周期、输出与恢复

start 异步返回执行 ID；持久化 queued/running/succeeded/failed/cancelled/timed-out/unknown/rejected 状态及退出码。退出码 0 仅代表进程成功，不自动判任务验收通过。

stdout/stderr 分流，readOutput 使用字节游标及单次有界输出（默认 32 KiB，最大 128 KiB）；单流存储上限默认 8 MiB，超限标记截断，不把截断当执行成功。正确处理 UTF-8 跨块、ANSI/终端控制序列和敏感信息；敏感模式跨块匹配，不能先发送秘密片段再补扫描。未扫描原始输出不进入普通日志或模型历史。

取消和超时作用于整个隔离执行单元。用户取消、超时、权限撤销分别记录；在输出截断、进程故障、引擎断连时保留可诊断状态，不吞错。任务取消后不启动排队进程。

服务重启先按执行 ID 查询隔离单元并对账，禁止自动重跑；不确定是否执行过就保持 unknown，拒绝复用该幂等键启动新副作用。预算、输出游标和执行状态可恢复。清理暂存资源与删除备份分别处理，沿用既有保留与授权规则，不自动删除恢复证据。

## 04：生产接线与内部命令去同步阻塞

注册描述符、映射能力、加入适用任务工具子集，走 ScopeGatedToolPort 和现有策略包装，不能用特殊分支绕过。提供公共 SDK 的执行查询/取消和脱敏事件，CLI 运行路径能够消费同一事件；事件含具体主体、执行 ID、状态、退出码与输出引用，不暴露凭据和完整未扫描命令内容。

内部 runEvidenceCommand / runIntegrationTestCommand 改为可取消的异步实现，更新调用方 await，不改变既有配置命令的来源与授权语义。它们仍是可信控制面配置，不直接授予模型调用任意宿主 shell 的能力。明确记录其隔离等级，不将环境白名单称为沙箱。内部命令与新模型工具共享可复用的状态/输出处理，但不得共享或扩大授权。

异步执行期间用户通信、状态查询、取消请求继续响应。保留 timeout、错误原因和输出证据，不再仅用 boolean 隐藏所有失败细节；兼容原消费方通过适配层得到成功判断。

## 05：开发闭环与缺失能力分诊

使用本地脚本化 Provider 经真实应用装配完成：读取夹具→修改代码→调用 processExecution 运行测试→观察真实失败→修正→复跑→取得退出码和产物→独立完成门禁。至少一条测试故意失败，证明模型看到的不是预设成功文本。

新可观测事件同时用于复核 AUDIT-REPAIR-01 的 proposeGoal allow/deny 场景：明确区分未暴露工具、未分配、权限拒绝、处理器失败和成功落盘；成功要有真实提案产物，不能只看 mission done。失败反例保留，不因阻塞测试而删除或弱化断言。

重新核对当前可达性报告，不把 21 个候选直接定为缺陷。独立报告列：定义、注册、分配、实际处理器、权限、依赖装配、应用正反例、包级证据。对事实搜索明确区分证据记录与实际搜索；对安装明确区分检测/批准与真正执行；对文件操作逐项核对复制/移动/重命名/删除是否已有入口或仅缺任务范围。

## 06：验收与状态纠偏

- 先红后绿：未分配/deny/ponder/主 Agent 拒绝且进程数为零；批准只覆盖绑定参数；撤销后拒绝新执行并停止可继续越权的在途执行单元。
- 真实隔离反例：父路径/绝对路径/UNC/链接逃逸、读取宿主凭据、网络、宿主挂载及子进程绕过均失败；正常批准项目代码可运行。不得只测参数分类函数。
- 验证取消、超时、超量输出、资源耗尽、引擎断连、宿主进程重启、重复调用和跨项目查询；失败不重复副作用。
- 拔掉工具注册、子集分配或执行后端，正向闭环测试必须失败。内部慢命令期间状态查询和取消可响应，不靠长 sleep 制造脆弱断言。
- 运行 typecheck/lint/定向测试/全量 check:low-parallel；npm pack 经正常 prepack，通过隔离安装包的公开入口运行同一闭环，记录 SHA256、HEAD、命令与退出码。施工环境缺失写 blocked，不把 fake 后端通过当真实隔离验收。
- 对每个声明支持的系统/架构，在无 Docker/WSL/外部工具链、无开发者缓存的干净设备或虚拟机上验收真实交付包；独立安装载体额外要求无系统 Node，npm 载体只保留其必要 Node/npm 前提。安装完成后断网，普通用户权限下运行内置 Node 脚本、故意失败测试、修正复跑、取消及隔离负例。发布者环境上的通过结果不能替代此项。
- 覆盖安装路径含空格/非 ASCII 字符、组件损坏修复、升级失败恢复、资源不足和不支持系统。不得通过偷偷放宽隔离获得“成功”；声明支持的平台不能以提示安装依赖代替验收。不支持的系统在安装前准确说明，不承诺任意设备可用。
- 更新 SEC-02 的 stdout/stderr、子进程环境、输出存档和导出通道状态；更新 TOOLKIT 对通用执行的范围说明但保留纯转换器历史完成。隔离后端未验证的平台单列，不宣称跨平台全通过。

## 7. 当前状态

| 检查点 | 状态 |
|---|---|
| 01 契约 | implemented-unverified（2026-11-09，`8657d10e`+`6d6e2b99`） |
| 02 自带沙箱、基础工具链与安装自检 | **阻塞**：清单已提交（`fd16a4ee`）、探测已编码；真实后端/工具链/干净设备验收未交付，见 §02 阻塞项 |
| 03 生命周期 | 部分交付（2026-11-09，`04e2b371`）：持久化、输出游标/截断、重启对账已交付；敏感扫描闸、取消/超时分类未接 |
| 04 生产接线与异步内部执行 | implemented-unverified（2026-11-09，提交待推送）：可达性与去阻塞已证；SDK/CLI 事件面未接 |
| 05 开发闭环及分诊 | 部分交付（2026-11-09，`96fc126e`+`783b971a`）：分诊报告与应用级 allow/deny 矩阵已交付；**闭环本身阻塞**（需真实沙箱后端） |
| 06 包级与安全验收 | pending |

本文件作为关联补充入口及状态补丁，未改原卡已完成范围。隔离闭环、权限和包验收全部具备证据前不得标整卡 done。

### 01 收口（2026-11-09）

交付物与位置：

| 内容 | 位置 |
|---|---|
| 环境登记与参数契约（越界即拒） | `packages/core/src/execution/execution-contract.ts` |
| 执行控制器（幂等/归属/状态/输出游标/后端端口） | `packages/core/src/execution/process-execution-controller.ts` |
| 单一工具族 `processExecution`（start/status/readOutput/cancel） | `packages/core/src/tools/tool-action-registry.ts`、`tools/builtins.ts` |
| 逐 action 权限映射（`process.read`/`process.control`） | `packages/core/src/tools/permission-capability-catalog.ts`（目录版本 1→2） |
| 范围映射（start 走路径解析；查询/控制无路径目标） | `packages/core/src/tools/scope-authorization-gate.ts`、`tools/scope-resolution.ts` |
| 稳定错误码 | `packages/core/src/core/errors.ts` |

**已证伪的越界（反例优先，25+18 条断言）**：

- 环境登记：空可执行映射、缺输入范围、声明允许网络、绝对路径/含 `..` 的前缀、缺资源额度、重复标识 —— 全部拒绝；
- 模型参数：`command`/`shell`/`environmentVariables`/`mounts`/`isAuthorized` 等字段一律"不接受参数"；
  `arguments` 只接受字符串数组；`workingDirectory` 拒绝绝对路径与 `..`；超时 1–180000ms；
- 无后端 ⇒ `execution-backend-unsupported`（**不**降级宿主执行）；未登记环境/可执行标识 ⇒ 精确拒绝；
- 幂等：同键同参返回原执行且**不再启动进程**，异参 ⇒ `execution-idempotency-conflict`；
- 归属：其他主体查询 ⇒ `execution-not-authorized`；明确授权的上级可管理；
- 角色：主 Agent 只读投影与 ponder 白名单均不含 `processExecution`；
- 权限：四个 action 各自映射不同能力，未登记 action 回退整工具映射（不放宽）。

公开全量 **637 files / 4382 tests** 通过（`npm run check:low-parallel`）。

**仍未做（如实）**：本检查点只有**契约与判定**，`SandboxExecutionBackend` 未提供真实实现
（测试用的是明确标注的契约替身）；真实隔离、工具链交付、安装自检属 02。

## 8. 明确保留的后继能力（本卡不实施）

| 能力 | 目前缺口或待核查点 | 后续边界 |
|---|---|---|
| 依赖安装 | 分类和询问不是安装执行 | 已有资源询问、独立开关、精确授权、受限网络、安装脚本隔离；不得通过本卡禁网络执行器伪装支持 |
| PTY/stdin 与长期服务 | 本卡只做非交互有限任务 | 独立会话身份、输入授权、端口和生命周期后再立项 |
| 复制/移动/重命名/删除 | 内置通用入口覆盖待逐项对账 | 若缺失采用文件工具族 action；逐项备份、版本冲突、授权，不借 Shell 绕过 |
| 联网事实搜索 | 代理未装配时不可用 | 明确 Provider/凭据/出口和来源，不把记录实验当成执行实验 |
| 宿主应用控制与额外语言工具链 | 不属于基础 Node 执行范围 | 产品管理的扩展适配与环境配置；精确授权，不静默降级至宿主，不要求用户自行寻找依赖 |

这些条目只保留缺口和后继范围，不冒充已排入本卡编码。未来权限规划与其它未立项功能不因本卡自动启用。

### 02 清单与阻塞（2026-11-09）

平台实现清单已提交：[EXEC01_02_PLATFORM_SANDBOX_INVENTORY_2026-11-09.md](../reports/EXEC01_02_PLATFORM_SANDBOX_INVENTORY_2026-11-09.md)。

- 逐平台原语：Windows = AppContainer + Job Object + 受限令牌；Linux = bubblewrap（非特权 user namespace）；macOS = seatbelt（`sandbox-exec`）；
- 每项注明最低系统要求、可再分发组件、许可、验证方式与风险；
- 已编码 `sandbox-capability-probe.ts`：清单校验（空清单/平台/架构/组件缺失/不可读/版本浮动/哈希不符）+ 能力探测，
  不可用一律给具体原因，**不返回模糊的可用**；
- `tests/core/integration/exec01-02-sandbox-probe.test.ts` 12/12。

**阻塞（需用户决策或外部条件，未编码真实后端）**：

| 编号 | 阻塞 | 需要谁 |
|---|---|---|
| B1 | 三种隔离原语是否作为首版支持范围；macOS 是否接受 deprecated 的 `sandbox-exec` 路线 | 用户（安全/产品决策） |
| B2 | 新增原生构建链（Rust/C++）与签名/公证流程的安装授权（卡内纪律要求先询问） | 用户 |
| B3 | 三平台 × 两架构的辅助程序与 Node 运行时随包分发载体（npm 可选依赖 / 独立安装包） | 用户 |
| B4 | 干净设备/虚拟机验收（§06） | 外部条件 |

在上述四项落地前，02 **不能**标 implemented。

### 03 部分交付（2026-11-09）

| 内容 | 位置 | 状态 |
|---|---|---|
| 输出缓冲（字节游标、UTF-8 跨块不切断码点、ANSI 清除、8 MiB 上限+截断标记） | `packages/core/src/execution/process-execution-output-buffer.ts` | 已交付，7/7 |
| 持久化执行记录 + 幂等索引 + 毒化键（跨重启保留） | `packages/core/src/execution/process-execution-store.ts` | 已交付，12/12 |
| 重启对账（查隔离单元；查不到/抛错 ⇒ `unknown` + 毒化键；终态不重写；绝不自动重跑） | 同上 `reconcileProcessExecutionsAfterRestart` | 已交付 |
| 控制器拒绝毒化幂等键 | `process-execution-controller.ts` `start` | 已交付 |

公开全量 **640 files / 4413 tests** 通过。

**仍未做（如实）**：① 输出**返回前**的敏感内容扫描闸（跨块匹配）尚未接进 `readOutput`；
② 用户取消/超时/权限撤销的**分类记录**未实现（当前只透传后端终态）；
③ 任务取消后"不启动排队进程"的判定未实现（没有排队队列）；
④ 暂存资源清理与备份删除的分开处理未实现。

### 04 收口（2026-11-09）：生产接线与内部命令去同步阻塞

**生产接线（可达性已实测）**：

| 内容 | 位置 |
|---|---|
| 控制器 + 归属注入策略包装层 → 内置工具上下文 | `application-runtime.ts`、`tools/policy-wrapper.ts` |
| 环境登记表默认空、后端显式 `null`（不降级宿主执行） | `application-runtime.ts` |
| 后端探测**先于**环境查找（缺后端是更根本的事实） | `process-execution-controller.ts` |

**证据**（`tests/core/integration/exec01-04-production-wiring.test.ts` 3/3，真实装配 + 脚本化 worker 运行时）：

- assist：调用 `processExecution` 走到**权限询问**（`需要权限调用 processExecution`）⇒ 证明描述符已注册、能力已映射、任务子集已分配、策略链已放行到裁决层，**不是** `tool-not-found`；
- devolve：放行后真正执行 ⇒ 回填给模型的结果是"未装配沙箱执行后端"，**不降级**到宿主进程执行；
- 主 Agent 工具投影不含 `processExecution`。

**内部命令去同步阻塞**：

- 新增 `orchestration/internal-command-runner.ts`：异步 `spawn`、超时/取消按进程树终止、受限环境变量、有界尾部诊断输出、**隔离等级如实标注为"非沙箱"**；
- `mission-orchestrator.runEvidenceCommand` 与 `git-integration-coordinator.runIntegrationTestCommand` 改为异步并 `await`；
- 失败不再只有 boolean：报告里带原因、退出码与 stderr 尾部。

**证据**（`tests/core/integration/exec01-04-internal-command.test.ts` 7/7）：

- 慢命令执行期间并发定时器照常推进（`spawnSync` 会卡到接近 0 次）—— 直接证伪同步阻塞；
- 超时 400ms 内终止、取消 300ms 后返回、执行前已取消则不启动进程；
- 失败保留退出码 3 与 stderr 内容；诊断输出被截断到上限。

公开全量 **642 files / 4423 tests** 通过。

**仍未做（如实）**：① 公共 SDK 的执行查询/取消与脱敏事件未接；② CLI 运行路径未消费同一事件；
③ 取消信号尚未从任务取消一路传到内部命令（当前 runner 支持 `AbortSignal`，但没有上游来源）。

**推送状态**：本检查点提交 `ahead=1` **未推送** —— `git push` 连续 5 次失败，错误为
`Connection reset by 20.205.243.166 port 22`；改用 `ssh.github.com:443` 同样被 reset。
按纪律记录原因、保留本地提交，下一阶段合并后重试。

### 05 部分交付（2026-11-09）

**分诊报告**：[EXEC01_05_CAPABILITY_TRIAGE_2026-11-09.md](../reports/EXEC01_05_CAPABILITY_TRIAGE_2026-11-09.md)
（21 个候选逐条：定义 / 注册 / 分配 / 实际处理器 / 权限 / 依赖装配 / 应用正反例 / 分诊结论）。

五类计数：已接入 0、需宿主注入 2、被替代 6、测试专用 1、未接入 12、证据不足 0。

**四处与旧报告不同的更正**（都已给 `file:line`）：

| 候选 | 旧结论 | 复核结论 |
|---|---|---|
| `OpenAiResponsesAdapter` | 被替代 | **未接入**（生产无 Responses 运行时） |
| `AzureOpenAiAdapter` | 被替代 | **未接入**（既定延后） |
| `HumanWorktreeObserver` | 证据不足 | **读端已装配、写端从未构造** ⇒ 该通道生产恒空（真实缺陷） |
| `ContinuationCoordinator` | 测试专用 | 有替代，但替代只 `releaseTaskBackToPending`、**不保存检查点**，且缺省关 |

**三节专项**：事实搜索（`search-sources` 生产恒不可达，全仓无真实搜索 Provider；证据记录可达 ⇒ 记录 ≠ 搜索）；
安装（审批链已接线，真正执行入口只有 `ToolPackageZipInstaller.install` 且**不经过**门禁）；文件操作（复制/移动/重命名/删除四项**全缺模型入口**，属缺任务范围而非缺底层能力）。

**AUDIT-REPAIR-01 应用级 allow/deny 矩阵**（`tests/core/integration/audit01-application-matrix.test.ts` 6/6）：
真实 `createApplicationRuntime` 下区分五种结果 —— 未暴露（主 Agent 投影）、未分配（子集拒绝）、
权限待询问（`permission-ask-pending`）、处理器拒绝（`goal-mode-not-active`）、成功落盘（**真实提案文件可读**，
不只看 mission done）；并有"未激活不落盘 / 激活才落盘"的同一断言对。

**本轮暴露的待裁决项**：目标模式激活时装配层把 `proposeGoal` **强行加进**允许列表
（`application-runtime.ts` `effectiveAllowedToolNames.add(...)`），因此**任务工具子集对它不生效**
（实测：分解只给 `readFile` 的任务仍能成功 proposeGoal）。是否应让子集对 `proposeGoal` 生效属产品决策，
未擅自改动。

公开全量 **643 files / 4429 tests** 通过。

**仍未做（如实）**：本检查点要求的"脚本化 Provider 经真实装配跑通 读取夹具→改代码→**调用 processExecution 跑测试**→
观察真实失败→修正→复跑→退出码→独立完成门禁"**无法完成** —— `processExecution` 的真实后端属 02，当前为 `null`。
该闭环**阻塞**，不是"已完成"。

## 02 B1 平台验证：Windows 首轮实测（2026-11-09）

**已真实验证（Job Object 半区，`native/sandbox-helper`，零第三方 crate）**：

| 验证项 | 结果 |
|---|---|
| 正常执行 | `exit-code 0`，输出与含空格参数均保真 |
| 内存上限 64 MB | 子进程分配失败，未突破限额 |
| 进程数上限 3 | 并发第 4 个子进程 `spawn UNKNOWN`（作业拒绝） |
| 超时 3 秒 | `exit 124`，**3.1 秒返回**，无残留进程 |

**过程中修掉两个真实缺陷**：参数未引用（含空格参数被拆开）；**超时不杀进程树**（早期只打印
`timed-out` 就退出，子进程继续跑满 60 秒，调用方一直等待）。

**未能验证（AppContainer 半区）**：`CreateAppContainerProfile` 在**非管理员**进程返回
`E_ACCESSDENIED (0x80070005)` ⇒ 运行期建档案不可行；文件/网络隔离**未验证**，不声称成立。

**需裁决**：路线 A（安装期提权预建档案，运行时派生 SID）或路线 B（受限令牌 + Job Object 作为
非提权降级档，网络不封、强度更弱）。详见
`docs/reports/EXEC01_02_B1_WINDOWS_SANDBOX_VERIFICATION_2026-11-09.md` §4。

**仍未验证**：Linux（bubblewrap）、macOS（App Sandbox）—— 本机无对应环境。
辅助程序尚未接入 `ProcessExecutionController` 的 `SandboxExecutionBackend` 端口。

## 04 公开 SDK 执行面（2026-11-09，`d840b386`）

**缺口**：控制器已有 `readStatus` / `readOutput` / `cancel`，但**没有任何公开入口**调用
⇒ 外部只能看任务状态，看不到受控执行输出，也无法取消。

**新增（`public-sdk.ts`）**：

| 方法 | 说明 |
|---|---|
| `queryProcessExecution` | 返回**状态视图**（状态/退出码/失败原因/环境/时间戳），**不含后端句柄** |
| `readProcessExecutionOutput` | 按**字节游标**读取，**返回前脱敏**（与运行历史同一凭据目录） |
| `cancelProcessExecution` | 取消并回传结果状态；取消后仍可查询 |

**装配**：`ApplicationRuntimeOptions.sandboxExecutionBackend`（缺省 `null` ⇒ 一律
`execution-backend-unsupported`，**不降级到宿主执行**）；运行时暴露
`processExecutionController` 与 `executionEnvironmentRegistry`。

**证据**（`tests/core/integration/exec01-04-sdk-execution-surface.test.ts` 3/3）：

- 输出含 `sk-…` ⇒ 返回 `[REDACTED]`，原文不出现，游标前进；
- 取消后 `queryProcessExecution` 为 `cancelled`，序列化结果不含 `handle-`；
- 未知执行 ⇒ 公开错误（不泄漏内部细节）。

公开全量 **4455 passed + 3 skipped**（第三次运行；前两次各 1 个**不同**的既有用例在满载下翻红，
隔离与三文件联合运行均通过，判定为负载抖动，未改断言）。

**仍未做（如实）**：CLI `run` 路径尚未消费同一套执行事件；执行事件的**对外脱敏事件流**未做。

## 04 执行状态事件（2026-11-09，`84504073`）

**缺口**：调用方可以轮询执行状态，但**收不到"状态变了"的事件**。

**新增**：公开事件 `execution-status`（只带状态视图：`executionId` / `status` / `exitCode` /
`failureReason`，**不含后端句柄、不含输出正文**）。

**发布规则**：
- 以"上次已发布状态"为基线，**只在真的变化时发** ⇒ 轮询不会重复投递；
- 取消路径直接发布；
- `failureReason` 先过凭据目录再出网（失败原因常把命令与密钥片段带出来）。

**证据**（`exec01-04-sdk-execution-surface` 4/4）：订阅后取消一次执行 ⇒ 收到
`execution-status` 且 `status=cancelled`；事件序列化结果**不含 `handle-`**、**不含注入的密钥原文**。

公开全量 **4456 passed + 3 skipped**。

**仍未做（如实）**：CLI `run` 路径尚未消费同一套执行事件；事件只在 SDK 观察/取消时发布，
执行器自身（工具调用路径）尚未把启动/结束推进事件总线。

## 03 输出敏感扫描门禁（2026-11-09）

**缺口**：脱敏只在 SDK 层做 ⇒ **工具路径与其它读取方拿到的仍是原文**（与运行历史此前
"先落盘再在展示层遮挡"是同一类次序错误）。

**修复**：在 `ProcessExecutionController.readOutput` 的**返回之前**统一扫描并替换，
并如实回报 `isSensitiveContentRedacted`（`false` = 未发现，不是"没扫描"；
不回传命中类型，避免二次泄漏）。

**证据**（`exec01-03-output-sensitive-scan` 4/4）：

- `sk-…` 与 `ghp_…` 均被替换为 `[REDACTED]`，标记为 `true`；
- 普通输出**逐字不变**且标记为 `false`（区分"没发现"与"没扫描"）；
- **游标与截断标记仍按原始字节偏移** ⇒ 脱敏不会让读取方错位。

公开全量 **4460 passed + 3 skipped**。

**仍未做（如实）**：取消/超时/权限撤销的**分类**仍共用同一终态口径；队列取消语义未做；
临时目录清理与备份删除未分离。

## 03 终止原因分类（2026-11-09）

**缺口**：`cancelled` 同时覆盖"调用方取消"与"权限撤销"，只靠 `failureReason` 自由文本无法区分
⇒ 下游无法据此决定"能不能重试"。

**修复**：执行记录新增 `terminationKind`：

| 取值 | 来源 |
|---|---|
| `caller-cancelled` | `cancel()` 缺省值 |
| `authorization-revoked` | **仅受信控制面**可传入（调用方不能把自己的取消标成撤销） |
| `timed-out` | 由后端状态推导 |
| `backend-failed` | 由后端状态推导 |
| `null` | 尚未终止，或**旧记录没有该字段**（不猜测） |

`cancelled` **不**在后端状态推导里自动归类 —— 取消与撤销必须由显式来源区分。

**证据**（`exec01-03-termination-kind` 5/5）：调用方取消 ⇒ `caller-cancelled`；
显式撤销 ⇒ `authorization-revoked` 且**不退化为** `caller-cancelled`；后端超时 ⇒ `timed-out`；
后端失败 ⇒ `backend-failed`；仍在运行 ⇒ `null`。

状态视图、SDK 返回与 `execution-status` 事件都带上该字段。

公开全量 **4465 passed + 3 skipped**（首次运行有 1 个既有用例 `public-sdk` 满载翻红，
隔离复跑 10/10 通过后重跑全量绿 —— 属负载抖动，未改断言）。

**仍未做（如实）**：权限撤销时**自动终止该主体的在跑执行**尚未接线（目前只提供分类入口）；
队列取消语义、临时目录清理与备份删除分离仍未做。

## 02 辅助程序后端接线（2026-11-09）

**缺口**：辅助程序能编能跑，但**没有任何生产代码与它对话** ⇒ 控制器依旧无可注入的后端。

**新增** `packages/core/src/execution/sandbox-helper-backend.ts`（`SandboxHelperBackend`）：

| 能力 | 实现 |
|---|---|
| 探测 | 跑辅助程序 `probe`，把输出翻译成能力画像（**只认明确成功标记**） |
| 启动 | 能力可用才 `run`；否则抛 `execution-backend-unsupported`（**不降级到宿主执行**） |
| 状态/输出 | 后台收集 stdout/stderr，按**字节游标**读取 |
| 取消 | 终止辅助程序（Windows 整树 `taskkill /T /F`） |

**关键纪律落在代码里**：探测缺任一成功标记（`appcontainer-created` + `appcontainer-deleted hresult=0`
+ `job-created`）即判**不可用** —— "看起来像成功"不算成功。

**证据**（`exec01-02-sandbox-helper-backend` 6/6）：完整成功 ⇒ 可用；缺标记 ⇒ 不可用；
AppContainer 不可建 ⇒ 不可用且原因带出 `0x80070005`；不可用时 `start` **拒绝且只发生一次 probe**；
可用时走 `run` 协议、输出可游标读取、退出码落为 `succeeded`；取消如实回报 `cancelled`。

公开全量 **653 files / 4475 passed + 3 skipped，exit 0**。

**仍未做（如实）**：本机实测该后端 `probeCapability()` 报**不可用**（AppContainer 档案建不了）
⇒ 受控执行在产品里仍是"拒绝执行"状态，直到安装期初始化落地。协议测试用注入进程，
**不声称隔离**（隔离证据见 `EXEC01_02_B1_REVISED_2026-11-09.md`）。

## 02 安装期一次性初始化（2026-11-09）

按裁决做成**唯一提权入口**，客户端整体不提权：

```powershell
sandbox-helper.exe init-sandbox --confirm-create-profile [--profile <name>]
```

| 约束（裁决原文） | 落点 |
|---|---|
| 明确用户确认 | 无 `--confirm-create-profile` ⇒ **退出码 2**，明确说明原因与"仅安装期一次" |
| 每用户档案 | 只对**当前用户**建（`CreateAppContainerProfile` 即 per-user per-app） |
| 运行期非管理员 | 建完立刻验证 `Derive...`（运行期只走这条，**派生失败即初始化白做**，退出码 4） |
| 不得整体提权 | 该子命令是唯一需要提权的入口；`run`/`probe` 不需要 |

**实测两条拒绝路径**（真实二进制）：

```
init-sandbox                         ⇒ exit 2「拒绝执行：创建沙箱档案需要显式确认」
init-sandbox --confirm-create-profile ⇒ exit 3「HRESULT=0x80070005」+ 指引
```

**证据**（`exec01-02-sandbox-init` 3/3，辅助程序未构建时**跳过**而非伪造通过）：
无确认 ⇒ 拒绝且不出现 `profile-created`；有确认但无权限 ⇒ 非 0 且不声称成功
（已提权环境则要求 `profile-created` + `derive-ok`）；`probe` 报不可用时退出码必须非 0。

**顺带修掉一处未处理拒绝**：任务轮询用 `promise.finally(...)` 且只 `void` 掉派生 Promise，
原 Promise 拒绝时会产生未处理拒绝（实测：mission 被取消后轮询报"任务不存在"，
整轮 4478 全绿却 exit 1）。改为显式 `catch` 后结算。

公开全量 **654 files / 4478 passed + 3 skipped，exit 0**。

**仍未验证（如实）**：**提权后建档案是否真的成功** —— 本会话无交互式提权，`init-sandbox` 的
成功分支只写了断言，未取得真实成功记录。

## 02 平台后端装配（2026-11-09）

**缺口**：辅助程序后端已存在，但**没有代码决定"要不要用它"** ⇒ 装配层仍无默认值。

**新增** `packages/core/src/execution/platform-sandbox-backend.ts`：

| 函数 | 语义 |
|---|---|
| `resolveSandboxHelperExecutablePath` | 显式覆盖 > 随包位置（`native/sandbox-helper/sandbox-helper.exe`）；不存在 ⇒ `null` |
| `createPlatformSandboxExecutionBackend` | 路径为 `null` ⇒ 返回 `null`（**不造一个"凑合能用"的后端**） |

非 Windows 返回 `null`：Linux 需要的是 bwrap 包装（另一实现），**不冒充**已有。

**证据**（`exec01-02-platform-backend` 3/3）：无辅助程序 ⇒ `null` 且不构造后端；
覆盖指向不存在的文件 ⇒ `null`；覆盖指向真实文件 ⇒ 解析成功并构造后端。

公开全量 **655 files / 4481 passed + 3 skipped，exit 0**。

**仍未做（如实）**：运行时/CLI **尚未调用**该工厂（装配仍是显式传 `sandboxExecutionBackend`）；
Linux 的 bwrap 包装实现未写。

## 02 运行时自动探测（2026-11-09）

**缺口**：装配层仍无默认值 —— 产品入口无法"选择使用随包沙箱"。

**新增选项**（`ApplicationRuntimeOptions`）：

| 选项 | 缺省 | 说明 |
|---|---|---|
| `isSandboxBackendAutoDetected` | **false** | 探测会启动一次子进程，不能让每个测试 runtime 都付代价；产品入口显式开启 |
| `sandboxApplicationRootPath` | `process.cwd()` | 定位随包辅助程序 |
| `sandboxHelperExecutablePathOverride` | — | 高级部署/测试用 |

**行为**：开启且组件存在 ⇒ 装配后端；找不到 ⇒ `null`；**两种情况 `start` 都拒绝**（不降级到宿主执行）。

**顺带修掉一处真实缺陷**：辅助程序**无法启动**（文件不是可执行、权限不足）时，
原先会把底层 `spawn EFTYPE` 原样抛给调用方 —— 上层既看不出原因、也读不出"该拒绝执行"。
现在归为**不可用**并带出真实原因。

**证据**（`exec01-02-runtime-autodetect` 3/3）：缺省不探测 ⇒ 拒绝原因为"未装配"；
开启但无组件 ⇒ 仍拒绝；开启且组件存在（空文件）⇒ 装配后端、**探测后拒绝**，
原因为"没有可用的隔离执行后端：辅助程序无法启动…"，且**未启动任何宿主进程**。

公开全量 **656 files / 4484 passed + 3 skipped，exit 0**。

**仍未做（如实）**：CLI 尚未开启该开关；Linux bwrap 包装实现未写。

## 02 CLI 入口开启探测（2026-11-09）

**缺口**：运行时只在被要求时探测，而**没有任何入口要求** ⇒ 产品里受控执行永远报"未装配"，
测试却全绿（典型"组件存在但产品不可达"）。

**改动**（`packages/tui/src/cli/bootstrap.ts`）：`isSandboxBackendAutoDetected: true` +
`resolveApplicationRootPath()`。

**过程中修掉一处真实缺陷**：应用根按**固定层数**推断（`..`,`..`）——源码运行时在
`packages/tui/src/cli`、构建产物在 `dist/cli`，两者到包根层数不同 ⇒ 源码下指错目录
⇒ 后端恒为 `null`，表现成"未装配"，**看起来像没接线**。改为**向上查找** `native/sandbox-helper`
目录（最多 6 层），两种布局都能定位。

**证据**（`exec01-02-cli-bootstrap-autodetect` 1/1）：引导后的运行时拒绝原因**不含"未装配"**，
而是"没有可用的隔离执行后端…" ⇒ 证明探测真的接上了（本机探测结果为不可用，符合预期）。

公开全量 **657 files / 4485 passed + 3 skipped，exit 0**。

**仍未做（如实）**：Linux bwrap 包装实现未写；提权后建档案的成功分支仍未验证。
