# 任务卡 Backlog（2026-10-17，目标：逐渐推进完成所有任务卡）

## 0. 方法与**诚实的限制**

| 做法 | 结果 |
| --- | --- |
| 枚举 `docs/tasks/*.md` | **42 张卡**（`README.md` 与 `PRODUCT_INTEGRATION_ROLLOUT.md` 是索引/纲要，非卡） |
| 机器扫描 checkbox | 未勾选 **12 个**，集中在 2 张卡（`2026-09-16_INCREMENTAL_DESIGN` 6 个、`LESSON01` 6 个）|
| 读那 12 个 | **都是"检查点收口前的交付核对单"**（如"文件所有者已确认""所有状态保持 pending 直到真实完成"），**不是功能缺口** |
| 关键词扫"未完成/待办"（218 处） | 大量出现在**免责声明**里（"不代表已完成"）⇒ **不能据此判定状态** |

**⇒ 结论：42 张卡的真实状态无法靠机器判定，必须逐卡读"未完成/剩余"段落。**
本 backlog 因此分四层，Tier 3 是**逐轮消费的工作队列**。

---

## 1. Tier 1 —— 本会话已推进/闭合的卡（状态已变，卡内文字可能仍写"未做"）

| 卡 | 本会话的推进 | 依据 |
| --- | --- | --- |
| `T05D_HUMAN_AGENT_CONCURRENT_CHANGE_TASK_CARD` | G1 三层贯通（门面→装配→控制器→编排器）+ 五门禁评估器（合并默认永不通过） | 总表 §21.6、§25、§32 |
| `TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD` | G4 工具说明回执端到端跑通（首次完整用法 / 同 revision 仅提醒 / 未登记不注入） | 总表 §32 |
| `T07E_AGENT_WORKING_SET_READ_BUDGET_TASK_CARD` | G2 进度守卫 + 任务链预算持久化；G5 有界续跑 | 总表 §13、§16.6 |
| `GUI01_R_PRODUCT_WORKBENCH_TASK_CARD` / `GUI02_AUTHORIZATION_AND_HISTORY_VIEW_TASK_CARD` | G9 状态如实化 + G10 CLI 分发（`preset list` / `concurrent status` argv 级验收） | 总表 §5.7 |
| `E2E01_STANDALONE_WORKFLOW_ACCEPTANCE_TASK_CARD` | G10 argv 级 E2E（真实子进程跑 `dist/cli.js`） | 总表 §5.7 |
| `OBS01_PERFORMANCE_USAGE_AND_DIAGNOSTICS_TASK_CARDS` | 卡内已注明边界；本轮未新增 | 总表 §10.1 |
| `MERGE01_NODECTX01_TASK_CARDS` | 工具级 action 归并（MERGE-01-01/02）此前已闭合；本会话未改 | 总表 §5.x |

**⚠️ 注意**：这些卡**卡内文字未更新**（本会话只更新了总表与 `PLAN_STATUS`）。是否需要回填卡内状态，**需你确认**（改卡等于改权威文档，我不擅自动）。

## 2. Tier 2 —— 卡内已注明边界（无需处理，4 张）

`OBS01`、`T05D`、`T08C_T07C`、`TOOLKIT01`（见总表 §10.1）。

## 3. Tier 3 —— **逐轮消费的工作队列**（每轮只做 1 张、先读该卡"未完成/剩余"段）

| 顺序 | 卡 | 初判方向（**待读取确认**） |
| --- | --- | --- |
| ~~1~~ | ~~`GUI02_AUTHORIZATION_AND_HISTORY_VIEW_TASK_CARD`~~ | **第 1 轮结论（2026-10-17）：剩余项均非本地可证** —— ①GUI-02-01④ 退出码需 CLI 级真实 Provider 接线、**TTY 逐字输出需真实 TTY**（外部）；②GUI-02-03/04 的 UI/路由与"重启真实操作证据"需 GUI 人工体验（外部）。已有回归 `b6r10-permission-ask-wait`（8 条）只覆盖等待语义，**未**断言退出码/TTY。⇒ 移入 Tier 4 |
| 2 | `PROJECT01_ISOLATION_AND_CROSS_PROJECT_BORROWING_TASK_CARD` | 跨项目借用与 worktree 相关能力（与 G1 现状交叉） |
| 3 | `COMM01_ADDRESSABLE_UPPER_LAYER_AND_SINGLE_PARENT_TASK_CARD` | 可寻址上层与单父链；通信句柄转交 |
| 4 | `SESSION_SUMMARY_AND_STEERING_TASK_CARDS` | 会话摘要与驾驶 |
| 5 | `T09A_CONTEXT_NODE_CLOSURE_AND_RECALL_TASK_CARD` | 上下文节点闭合与召回 |
| 6 | `T12A_SESSION_RECOVERY_RECONCILIATION_TASK_CARD` | 会话恢复与对账（与 G5 续跑交叉） |
| 7 | `T12_SECURITY_HARDENING_TASK_CARD` | 安全加固 |
| 8 | `SMART01_INSTRUCTION_WINDOW_AND_MAIN_RESPONSIVENESS_TASK_CARD` | 指令窗口与主 Agent 响应性 |
| 9 | `CLIENT01_FOLDER_GRANTS_SECRETARY_AND_ONBOARDING_TASK_CARDS` | 文件夹授权与入职 |
| 10 | `BRIDGE01_EXTERNAL_TOOL_MVP_TASK_CARD` | MCP/外部工具 MVP |
| 11 | `HISTORY01_LOCAL_RUN_HISTORY_AND_RESUME_VIEW_TASK_CARD` | 本地历史与恢复视图 |
| 12 | `EXP01_WORKFLOW_DISCOVERY_AND_HISTORY_MAINTENANCE_TASK_CARDS` | 工作流发现与历史维护 |
| 13 | `T08D_CRAFTSMAN_TERTIARY_PRESET_TASK_CARD` | 工匠预设（休眠三级预设） |
| 14 | `T07D_R2_PROVIDER_PRODUCT_WIRING_TASK_CARD` / `T07D_R1` / `T07D` / `T07D00` | Provider 产品接线与审计 |
| 15 | `WB00_MICRO_EDIT_WORKBENCH_PROTOTYPE_TASK_CARD` | 工作台原型 |
| 16 | `RELOCATE01_COLD_START_PROJECT_RELINK_TASK_CARD` | 冷启动项目重连 |
| 17 | `BATCH6_REPAIR_TASK_CARDS` + `B6R*`（4 张） | 批量修复与验收 |
| 18 | `AR07_FINAL_ACCEPTANCE` | 终验 |
| 19 | `2026-09-16_INCREMENTAL_DESIGN` / `2026-10-01_RUNTIME_USABILITY_AND_RELIABILITY` | 增量设计 / 运行时可可用性 |
| 20 | `LESSON01_MODEL_ALIGNED_COMMUNICATION_MEMORY_TASK_CARD` | 沟通记忆 |
| 21 | `INT00_PRODUCT_PATH_AUDIT_TASK_CARD` | 产品路径审计（其产物是 Tier 分级依据，需再跑一次） |
| 22 | `T08C_T07C_AGENT_ROUTING_AND_MODEL_POLICY_TASK_CARDS` | 路由与模型策略 |
| 23 | `PRODUCT_INTEGRATION_ROLLOUT` / `README`（索引类） | 核对索引是否与现状一致 |

## 4. Tier 4 —— **只能由用户/平台提供**（遇到即停）

`SUM-01` 人工标注、macOS/Linux 平台证据、GUI/人工体验结论、真实 Provider 凭据与额度、任何产品文案授权。

---

## 5. 每张卡的处理流程（固定，不得简化）

1. **读**该卡"未完成/剩余/限制"段，写出 1–3 条可本地验证的缺口；
2. **反例先行**（真实装配入口，确认红）⇒ 存 `.tmp` 或入库（视红/绿）；
3. 实现/接线（一次改完 ⇒ `typecheck`）；
4. 反例转绿 + **拔线必失败**；
5. `npm run check` ⇒ `verify:mutation-kills` ⇒ `npm pack` + 两个 verify；
6. 更新本 backlog 该卡状态 + `PLAN_STATUS` + 单独提交推送。

**轮次预算**：单卡 ≤6 轮；超出停下说明卡点。

---

## 6. 逐卡判定记录（阶段 B 实况）

| 轮 | 卡 | 判定 | 依据 |
| --- | --- | --- | --- |
| 1 | `GUI02` | **移入 Tier 4** | 剩余项：退出码需 CLI 级真实 Provider（重）、**TTY 需真实 TTY**（外部）、UI/路由与"重启真实操作"（GUI 人工体验）。既有回归 `b6r10-permission-ask-wait` 只覆盖等待语义 8 条，未断言退出码/TTY |
| 2 | `PROJECT01` | **重，需专门窗口** | `PROJECT-01-03` 已 done（本地可证范围）；剩余＝**`PROJECT-01-04`：A/B/C 三项目 + 多同级个体**的可追溯/不串数据/压力验收 ⇒ 需多项目端到端编排 |
| 2 | （附带加固）| **已完成** | 发现新模块（G1 五门禁、G4 渲染器）**无变异体覆盖** ⇒ 补 2 条，`62/62` 全拦下（`0da8313`） |
| 3 | `src` TODO 扫描 | **无缺口** | 全仓 `src` 仅 4 处"故意未支持"的明确报错（`view` 参数无取值），非 TODO |

| 3 | `COMM01` | **需设计决定** | 剩余是「让执行者求助走唯一上级转达」，卡内明写需先确定「协作收件箱在现有邮箱体系中的形态」⇒ 属产品设计，非我能独断 |
| 4 | `SESSION_SUMMARY_AND_STEERING`（SUM-01/SUM-02） | **部分外部 + 大部未接线** | 卡内：SUM-01/SUM-02 状态 `re-verifying`（**验收未通过**）；**仍未完成**＝三类来源的**真实数据源接线**（会话事件流/报告存档/延后文件存储）。而 SUM-01 的人工标注属**外部证据**（你/平台）⇒ 我先记录，待你给标注口径 |
| 5 | `EVENT-01` | **无证据（pending）** | 卡内 L3：`EVENT-01 为 pending（未取得完成证据）`；需先确定它的验收口径 |

## 7. 已知工具缺陷（本轮发现，未修）

**变异 harness 把"变异后语法错误"误判为"变异存活"**：
- 现象：`find` 只截取了三元表达式**第一行** ⇒ 变异后语法错误 ⇒ vitest 无法收集用例 ⇒ 命名用例"没变红" ⇒ 判为 **存活** ✗；
- 正确行为：应判为 **脚本错误**（"变异体自身不合法"）；
- 修法（下次）：在 `parseJsonReport` 之后检查"是否有测试文件**收集失败**"⇒ 有则报脚本错误并指出该变异体；
- 我已踩过 2 次（`rationale` 半角引号嵌套、`find` 非完整表达式），**harness 自身也应校验**。

## 8. 策略调整（第 3 轮结论）

42 张卡里**多数剩余项是外部/重型**（GUI、TTY、多项目压力、真实凭据）。逐卡空转效率低。
**改为双轨**：
- **轨 A（卡）**：只挑卡内**可本地轻量验证**的项（每卡先判，判定理由入 §6）；
- **轨 B（代码）**：从「已知未接线/未验证」清单与**测试覆盖盲区**（如本轮发现的"新模块无变异体"）里找**便宜且明确**的缺口，按同一纪律闭合。

**轨 B 的候选来源（优先级）**：① 新代码的变异体覆盖；② 既有报告里"未接线/未验证/未复现"条目；③ `PLAN_STATUS` 中非 done 的行；④ 隔离包/门禁里被跳过的断言。

> **2026-10-17（第 4 轮）补记 —— 我尝试修它，但把 harness 改坏了，已回退**：
> 用 PowerShell 数组 `-join` 拼多行块时**丢了换行**，导致守卫被压成一行、并把
> `failedTestNames = collectFailedTestNames(report)` 那行吞进注释 ⇒ harness **半坏**（却仍打印 62/62）。
> **已 `git checkout 0da8313 -- scripts/verify-mutation-kills.mjs` 回退**，复验：`node --check` 0、`collectFailures` 0 处、变异 **62/62** ✓。
> **教训**：改这个文件必须用 **Node 脚本 + 显式 '\n'.join**（已验证可靠），**不要用 PowerShell 数组拼多行**。
> 守卫本身**仍未加**（下次按此方式重做，并用一个故意写坏的 `find` 验证"语法错⇒脚本错误"）。

> **2026-10-17（第 5 轮）—— 守卫已按正确方式重做并验证**：
> 用 **Node 脚本 + `'\n'.join`** 插入（不再用 PowerShell 数组），逐行确认结构正确、`node --check` 0、`eslint` 0 错。
> **反例验证（关键）**：临时加入一个 `find` 只截三元表达式第一行的探针变异体 ⇒ harness 正确报
> **「❌ 脚本错误：变异使测试文件无法收集（语法/转换错误）…首条信息：Transform failed with 1 error」**（而非"存活"）✓
> 随后移除探针 ⇒ 变异体数回到 **62**、`syntax-break-probe` 残留 **0**、**62/62** 全拦下 ✓

---

## 9. 第 7 轮：确定下一个**真正未开工**的卡 = `RELOCATE-01`

**为什么是它**：`PLAN_STATUS.md` L344 明标 **`RELOCATE-01  pending（2026-10-17 新增计划）`**；
卡内(L3)「状态：pending（方案已确认，未实施、未验收）」⇒ **方案已冻结、代码零实现**，是优先级的正确落点。

**卡内语义（§2–§4 已读，作为验收依据）**：

| 情况 | 规定行为 |
| --- | --- |
| 原路径可访问且身份一致 | 加载历史，进入**只读恢复对账**，不直接重跑 |
| 路径不存在/设备未挂载/无权限 | 显示具体原因，**待关联**；不自动新建空目录 |
| 原路径存在但**身份不同** | **阻止**套用旧历史与项目执行 |
| 多个候选**相同身份** | 用户选择（继续原项目 / 独立打开），**不自动猜测** |
| 标识缺失/登记损坏 | 进入旧格式关联流程，**不伪称验证成功** |

**不可退让的约束**：位置状态与任务状态**分离**；查看历史**不启动模型、不恢复任务、不执行历史命令**；
`projectIdentifier` 稳定、名称仅展示；ID/Git 信息**只是证据**，不构成新位置的自动授权；
同名目录/同远端**不能单独证明身份**；路径失联**不得**把任务标 done/failed，也不自动归档；
未知新位置**不能由模型代确认**（放权模式也不自动关联）；映射**不得**用字符串前缀判包含
（`old-project-extra` 不属于 `old-project`）。

### 9.1 检查点 01（身份与检测）的落地设计（下一轮开始，预算 ≤4 轮）

1. **纯判定模块**（无 I/O、可单测）：`packages/core/src/orchestration/project-relocation-classification.ts`
   - 输入：`{ registeredProjectIdentifier, registeredRootPath, currentRootPath, isRegisteredRootAccessible,
     observedProjectIdentifierAtCurrentRoot, candidateIdentifiers }`
   - 输出：`{ classification, isHistoryLoadable, isExecutionAllowed, requiredUserAction, reason }`
   - 分类枚举固定为卡内 5 行 + `unregistered`（无登记）
2. **反例优先**（先写、确认红）：①身份不同 ⇒ 阻止；②标识相同但目录复制 ⇒ 不自动授权；
   ③多候选同身份 ⇒ 需用户选择；④标识缺失 ⇒ 不伪称成功；⑤`old-project-extra` 不算包含关系。
3. **只读纪律**：模块不得读文件、不得启动模型、不得改任务状态（由纯函数保证）。
4. 记录：卡检查点 01 状态 + `PLAN_STATUS` + 本 backlog。

---

## 10. `RELOCATE-01` 阶段成果与基线（2026-10-18，第 8–26 轮）

| 项 | 值 |
| --- | --- |
| 检查点 | **01 / 02 / 03 本地可证部分 done**；03 的**只读控制面已接线（SDK 可达）**；04 pending（命令名/输出格式待用户确认） |
| 模块 | 8 个（分类器、登记 schema、确认状态机、备份/应用、副本身份、路径解析、恢复门禁、登记存储、只读控制器） |
| 反例 | **65 条** |
| 拔线验证 | 10 次（每次至少 1 条反例变红） |
| 变异体 | **69/69 全部拦下** |
| 全量基线 | `check` **469 文件 / 3420 用例** exit 0；`npm pack` **273 文件**；`verify-package` / `verify-sdk-consumer` exit 0 |

### 10.1 期间被**架构守卫**抓到并修复的真实违规（值得留档）

`tests/architecture/destructive-file-api-guard.test.ts`（T12-05）报：
`project-location-registration-store.ts: 不在白名单却使用破坏性 API writeFile,rename`

**正解不是加白名单特例**，而是复用已白名单的 `core/src/infra/atomic-json.ts`
（`writeAtomicJson` + `backupExistingFile`）⇒ 修复后守卫 2/2 通过（`763c6f2`）。

### 10.2 未完成（不得声称 complete）

| 项 | 阻塞 |
| --- | --- |
| 检查点 04 的 CLI/TUI 入口 | **命令名与输出字段属产品文案**，需用户确认（我给出 A/B/C 三选项） |
| tarball 双进程搬迁恢复证据 | 依赖上述 CLI 入口 |
| 真实设备/跨平台、GUI 确认卡交互 | 只能由用户/平台提供 |

---

## 11. **全部 42 张卡的状态台账**（2026-10-18，逐卡读第 3 行状态）

### 11.A 已完成（`done`）—— 11 张

`BRIDGE01`（仅缺 macOS/Linux）· `INT00` · `T05D` · `T07D` · `T07D_R1` · `T07D_R2` · `T07E` · `T08C/T07C` · `T08D` · `T09A_R1` · `T12` · `T12A_R1` · `T12A_SESSION`（后两者带**范围纠偏**：历史 done 只到模块级，产品接线见 INT00 报告）· `T09A`（2026-11-08 补记 01–04 完成）

### 11.B 进行中 / 复验中 —— 9 张

| 卡 | 状态原文要点 |
| --- | --- |
| `AR07_FINAL_ACCEPTANCE` | `in_progress` |
| `GUI01_R` | in_progress：01–03、04a done；**04b 仅剩真实人工体验 + Linux/macOS 证据** |
| `PROJECT01` | in_progress：**已修资源 I/O 接线**；跨项目规则与多项目压力未完成 |
| `OBS01` | `re-verifying`：已有存储/查询/部分采集，**逐组核对未完成** |
| `SMART01` | in_progress：02/03 done；04 SDK 入口已接线（2026-10-10） |
| `SESSION_SUMMARY` | `re-verifying`（SUM-01/02/GUIDE-01）；**真实数据源接线未完成**；SUM-01 标注属外部 |
| `TOOLKIT01` | **部分实施**（第 40 轮订正） |
| `COMM01` | 01 done；**02 进行中**（切片① 2026-10-18）；剩余需"协作收件箱"设计决定 |
| **`RELOCATE01`** | 原 `pending` ⇒ **本会话推进到 01–03 done、03 只读控制面已接线**；04 待 CLI 命名 |

### 11.C 未开始（`pending` / 待执行）—— 16 张

`2026-09-16_INCREMENTAL_DESIGN` · `2026-10-01_RUNTIME_USABILITY`（RELIABILITY-01 in_progress，R4 幂等/并发/备份待返修）· `B6R-04b` · `BATCH6_REPAIR` · `CLIENT01` · `E2E01` · `EXP01` · `GUI_MVP`（由 GUI-01-R 接管）· `GUI02` · `HISTORY01` · `LESSON01` · `WB00` · `B6R-11` · `B6R00` · `T07D00` · `PRODUCT_INTEGRATION_ROLLOUT`

### 11.D 被平台阻塞 —— 1 张

`B6R10_FINAL_ACCEPTANCE`：**未通过（保持）**，证据缺失＝**Linux Node 20/新版本矩阵、macOS Node 20/新版本矩阵** ⇒ 只能由外部提供。

### 11.E 汇总

| 类别 | 张数 |
| --- | --- |
| done | 11 |
| in_progress / re-verifying | 9（其中 1 张由本会话推进） |
| pending / 待执行 | 16 |
| 平台阻塞 | 1 |
| 索引类（README / PRODUCT_INTEGRATION_ROLLOUT） | 2 |
| **合计** | **42**（含重叠口径，见各卡原文） |

> **口径提醒**：`done` 不等于"产品可用" —— `T07D`/`T12A_SESSION` 都带"历史 done 仅模块级"的纠偏；
> 本会话推进的 `RELOCATE01` 也是"本地可证部分 done"，且 **04 未做**。

| 6 | `HISTORY01`（本地运行历史与恢复视图） | **可本地起步（01/02），03/04 部分外部** | 四个检查点：**01 审计并冻结事件覆盖矩阵/查询接口/只读权限**（纯判定，可本地做）；**02 最小持久化+分块+索引+resume 分段+崩溃尾部/磁盘满/坏日志/旧 schema/并发反例**（可本地做，规模中等）；03 SDK/CLI/TUI/**GUI** 视图（GUI 部分外部）；04 tarball + **人工体验**（外部）。⇒ 可按 01→02 顺序推进 |

---

## 12. 交接（第 31 轮）：下个会话可直接开工的清单

### 12.1 一分钟状态

```
check 469 文件 / 3420 用例   exit 0
变异 69/69                    exit 0
npm pack 273 文件             exit 0；两项 verify exit 0
开关全部缺省关                 HEAD == origin == main
```

### 12.2 三条**明确的下一步**（按价值排序）

| # | 动作 | 前置 | 轮次 |
| --- | --- | --- | --- |
| 1 | `RELOCATE-01-04`：CLI 入口（`describeProjectRelocation` 已有 SDK 出口，只需 argv 分发 + 输出字段） | **命令名待用户选 A/B/C** | 2 |
| 2 | `HISTORY-01-01/02`：审计 + 最小持久化（见 §6 第 6 条） | 无 | 4–6 |
| 3 | G4 真实登记内容 | **用户给 5 项或授权摘录** | 2 |

### 12.3 本会话的**关键教训**（下个会话别重犯）

1. **改 `src` 后必须跑 `verify:mutation-kills`**：源码改动会让旧变异体的 `find` 锚点失效，harness 报"脚本错误"（我第 23 轮就因此把 `main` 弄红过）；
2. **加变异体前先统计 `find` 在目标文件中的命中次数**（我用一个诊断脚本做到了，效果很好）；
3. **锚点"唯一"≠"正确"**：同一字段可能在多个分支以不同缩进出现，必须 `read` 看上下文（我在 `isRegistrationCorrupted` 上错了三次）；
4. **未跟踪的新文件不能靠 `git checkout` 回退**，用文本恢复；
5. **破坏性文件 API 必须用白名单模块**（`infra/atomic-json`），否则 T12-05 架构守卫会红；
6. **PowerShell 拼多行代码必丢换行**，一律用 Node + `'\n'.join`。

---

## 13. `RELOCATE-01-04` 进展（2026-10-18 第 32–33 轮）

### 13.1 已完成

| 项 | 证据 |
| --- | --- |
| **CLI 入口 `project status`**（命令名经用户确认＝选项 A） | `packages/tui/src/cli/project-relocation-command.ts` + 在 `cli.tsx` 注册 `project`/`status`（`85a9efb`） |
| **argv 级实测** | `node dist/cli.js project status --project project-alpha --root "D:/work/alpha" --json` ⇒ `unregistered`、5 字段齐全、exit 0、**未创建任何目录** |
| 执行器反例 3 条 | 无登记／有效登记+观测一致／**未提供观测 ⇒ identity-missing（fail-closed）** |
| **双进程证据** | 进程 A 用 `dist/public-sdk.js` 写登记 ⇒ **独立进程 B** 读出 `{kind:"valid", classification:"identity-confirmed", isHistoryLoadable:true, isExecutionAllowed:false}` ✓ |
| 全量门禁 | `check` **470 文件 / 3423 用例**、变异 **69/69**、包 **273 文件**（均 exit 0） |

### 13.2 未完成（如实）

| 项 | 状态 |
| --- | --- |
| **tarball** 双进程搬迁证据 | ⚠️ **未取得**。两条路都失败：①本机 `npm install` 不生成 `node_modules`；②**解包直跑**报 `ERR_MODULE_NOT_FOUND: zod`（tarball 不含依赖，必须真实安装）。⇒ 双进程证据用的是**仓库 `dist`**；隔离包方面只有 `verify-package`/`verify-sdk-consumer`（exit 0）。**不得声称已有 tarball 双进程证据** |
| TUI / GUI 入口 | 未做（GUI 属外部人工体验） |
| `--observed-identifier` 的来源 | 目前由调用方提供；项目内标识文件形态由项目自定义，CLI 不假设 |

### 13.3 `HISTORY-01-01` 审计结论（2026-10-18 第 35 轮，含证据）

| 检查 | 结果 |
| --- | --- |
| 现有历史读取器 | `packages/core/src/gui/mission-history-reader.ts`（336 行，GUI 只读视图用） |
| 是否含**工具调用/失败调用**字段 | **没有**（该文件内 `tool`／`failure` 零命中；无结构化 `readonly` 字段声明，返回松散对象） |
| 是否含**模型说明/过程说明** | 未发现 |
| 结论 | `HISTORY01` 的 §2「必须保存的历史」与 §7「必需测试」**确实未实现**，卡内 `pending` 状态**属实** ✓ |

⇒ **`HISTORY-01-02`（最小历史持久化）是真正的下一步工作**：需要新增结构化记录（工具调用、失败、恢复分界），
而不是"补一个视图"。**本轮未开工实现**（预算用于审计取证）。

### 13.4 `HISTORY-01-02` 接线的**取证结论**（2026-10-18 第 37 轮）

| 项 | 结果 |
| --- | --- |
| 是否有"工具成功"钩子 | ✅ 有：`packages/core/src/runtime/tool-loop.ts:99` `onToolSucceeded?: (toolName, outputText) => void`，在 **L522–524** 被调用 |
| 是否有"工具失败"钩子 | ❌ **没有**（只有 succeeded） |
| ⇒ 接线缺口 | 要满足卡内「失败调用也要记录」，需**先加一个失败钩子**（`onToolFailed`）再接到 `RunHistoryStore.appendEvent` |
| 预算判断 | 加钩子（2 行）+ 两处接线 + 反例 ≈ **2 轮**；本轮仅取证，**未改代码** |

**下一轮动作**：①加 `onToolFailed` 钩子（含失败原因）；②在 `RunHistoryStore` 侧提供 `recordToolCall/recordToolFailure` 便捷方法；③写"真实执行路径记录两条事件"的反例；④拔线 + 门禁。

### 13.5 `HISTORY-01-02` 接线最后一跳的**取证结论与方案**（2026-10-18 第 40 轮）

| 取证 | 结果 |
| --- | --- |
| `worker-agent.ts` 是否有 `missionIdentifier` | ❌ 无（该文件内零命中） |
| `worker-agent.ts` 是否有 `stateDirectory` | ❌ 无 |
| `mission-orchestrator.ts` 是否有 `missionId` | ✅ 有（如 L725/L773 传给 worker 选项） |
| `mission-orchestrator.ts` 是否有 `stateDirectory` | ❌ 无 |

⇒ **与 G4 完全同形**：需要一个"由装配层构造、经 `workerFactories` 透传的实例"，
而不是让 worker 自己找目录。

**方案（照抄 G4 已验证的路线）**：

1. `workerFactories` 加可选字段 `runHistoryStore?: RunHistoryStore | null`（编排器 options）；
2. 装配层用 `stateDirectory` 构造 `new RunHistoryStore({ baseDirectory })` ⇒ 传给控制器 ⇒ 进 `workerFactories`；
3. 编排器在构造 worker 选项时 **spread** 该字段；
4. `worker-agent` 选项加 `runHistoryStore?: RunHistoryStore`，在**构造 tool-loop 选项处**加：
   `onToolSucceeded: (toolName, outputText) => void store.recordToolCall({...})`、
   `onToolFailed: (toolName, failureReason) => void store.recordToolFailure({...})`
   （`missionIdentifier` 用 worker 选项里已有的 mission 标识；**若没有则需先补**——下一轮先查这一条）；
5. **端到端反例**：真实任务跑一次 ⇒ 断言 `stateDirectory/run-history/<mission>.json` 出现且含事件；
6. 拔线（不传 store ⇒ 反例红）+ `check` + 变异 + 隔离包。

**预算估计**：**3–4 轮**（G4 同类花了 5 轮，其中 3 轮用于找断点；本次有 G4 的现成锚点，风险低）。
**风险**：第 4 步的 `missionIdentifier` 来源**尚未取证** —— 这是下一轮第一件事。

### 13.6 `HISTORY-01-02` 接线现状（2026-10-18 第 43 轮）

| 层 | 状态 |
| --- | --- |
| `tool-loop` 失败钩子 `onToolFailed` | ✅（`130a980`） |
| worker 写入历史（成功+失败） | ✅（`1954b48`） |
| 编排器 / 控制器 透传 | ✅（`95e57a5`） |
| **装配层构造 `RunHistoryStore`（默认保存）** | ✅（`95e57a5` 后继提交） |
| **端到端「跑一次真实任务 ⇒ 历史文件出现」** | ❌ **未取得** |

**为什么没取得**：本机可跑的真实 mission 用例里，假 Provider **只返回完成标记、不调用工具**（G4 e2e 如此）
⇒ 没有工具事件 ⇒ 历史文件**本来就不该产生**（store 只在工具事件时写）。而会调用工具的用例
（`e2e01-*`）跑完也没有 `run-history` 目录（它们多走内存态/未触达装配层）。

**下一步（下一步的第一件事）**：写一个**会调用一次工具**的端到端用例（假 Provider 先发 tool_call 再发完成标记），
断言 `stateDirectory/run-history/<missionId>.json` 存在且含 `tool-call` 事件。**在此之前不得声称历史已生效。**
### 13.7 基线（2026-10-18 第 44 轮实测）

```
check    471 文件 / 3431 用例    exit 0
变异      69/69                   exit 0
隔离包    273 文件; verify-package / verify-sdk-consumer exit 0
```

`HISTORY-01-02` 的**代码与四层接线全部就绪**且全量门禁通过；
**唯一缺的是端到端证据**（"跑一次真实任务 ⇒ 历史文件出现"），
因为现有可用 mission 用例都不调用工具，而 store 只在工具事件时写。
**下一步唯一动作**：写一个假 Provider 先发 `tool_call` 再发完成标记的用例，断言
`stateDirectory/run-history/<missionId>.json` 出现且含 `tool-call` 事件。
### 13.8 端到端探针结果（第 45 轮）：**store 未到达 worker**

写了端到端用例（假 Provider 先发 `tool_call` 再发完成标记），**如期红**（`run-history` 文件 0 个）⇒ 接线未生效。

**探针（在 worker 的 `onToolSucceeded` 内打点）**：

```
[H-P] tool=factVerification store=false mission=mission-a9230ab7
```

| 结论 | 证据 |
| --- | --- |
| 钩子**确实被调用** | `tool=factVerification` ✓（工具真的执行了） |
| `runHistoryStore` **没到 worker** | `store=false` ✗ |
| 四处代码**位置都正确**（已逐个核对） | 装配层 `L1138` 在 `new MainController({` 内 ✓；控制器 `L1011` 在含 `toolDocumentationInjector` 的块内 ✓；编排器 `L917` 在 `buildWorkerAgent` 内（`onEarlyStopDetected` 之前）✓；worker 选项 ✓ |

**⇒ 代码位置全对但值没到** ⇒ 最可能是 **G4 当年踩过的同类**：worker 有多条构造路径 / 工具循环选项在多处构造，
我改的那处**不是**本次 mission 实际走的那处（`store` 从没进过那个对象）。

**下一步（唯一）**：在**每个** `new WorkerAgent(` 站点与**每个** `runToolLoop(` 调用点各打一个探针
（`workerFactories.runHistoryStore !== undefined`），找出实际路径后再接 —— **不要再盲改**。

**红测试**：`.tmp/history01-run-history-e2e.test.ts.draft`（**未入库**，如实标注为红）。
### 13.9 第 46 轮：worker 有**三个构造点**（关键定位）

`Select-String "new WorkerAgent\("` 结果：

| 站点 | 说明 |
| --- | --- |
| `mission-orchestrator.ts:845` | 一个构造点（**不是** `buildWorkerAgent`） |
| `mission-orchestrator.ts:873` | 即 `buildWorkerAgent` 内（我此前只改了这一处 ✓） |
| `mission-orchestrator.ts:1001` | 另一个构造点 |

另：`runToolLoop(` 调用点为 `main-controller.ts:897`（主 Agent 路径）、`worker-agent.ts:482`、`tool-loop.ts:332`。

⇒ **这解释了 `store=false`**：本次 mission 的 worker 由 **845 或 1001** 构造，而我只 patch 了 873。

**踩坑记录**：我尝试给三处都插 spread，但 845/1001 **不是对象字面量起点**（`new WorkerAgent(options)` 形式）
⇒ 插入导致 154 个语法错 ⇒ **立即回退**（`git checkout`），`typecheck` 回到 0。
**下一轮必须先 `read` 这两处各 10 行**，看清是"对象字面量"还是"变量传参"，再决定改哪里（若是变量，则应改**构造该变量的地方**）。
### 13.10 第 47 轮更正：`new WorkerAgent(` 的真实站点只有**一个**

| 之前判断 | 更正 |
| --- | --- |
| 三个构造点 845/873/1001 | **845 与 1001 都在文档注释里**（`new WorkerAgent({...})` 作为示例被写进注释）⇒ **真实构造点只有 L873（`buildWorkerAgent` 内）** |

⇒ 「多构造路径」的假设**不成立**；`store=false` 另有原因。

**已排除**：
- 装配层把 store 传给控制器 ✓（`application-runtime.ts:1138` 在 `new MainController({` 内）
- 控制器 spread ✓（`main-controller.ts:1011`，与 G4 的 injector 同块）
- 编排器 spread ✓（`mission-orchestrator.ts:917`，在 `buildWorkerAgent` 的对象内，`onEarlyStopDetected` 之前）
- worker 读取 ✓（`worker-agent.ts` 的 `this.options.runHistoryStore`）
- 钩子被调用 ✓（探针 `tool=factVerification`）

**⇒ 矛盾点收窄为**：`this.options.workerFactories.runHistoryStore` 在编排器里拿到的是 `undefined`
（否则 spread 会生效）。下一轮的唯一探针：在 `buildWorkerAgent` 首行打
`console.error("[O-1] wfReg=" + String(this.options.workerFactories.toolDocumentationInjector !== undefined) + " wfHist=" + String(this.options.workerFactories.runHistoryStore !== undefined))`
—— 若 `wfReg=true` 而 `wfHist=false`，说明**控制器那处 spread 没生效**（同一对象里一个有一个无 ⇒ 我看错了对象）。

**注意**：我在这一卡上已连续 4 轮未收口（42–47），按纪律**下一轮只做这一个探针**，不再尝试修改。
### 13.11 第 48 轮探针（决定性）：`workerFactories` 在这条路径里**是空的**

```
[O-1] wfReg=false wfHist=false
```

（插在 `buildWorkerAgent` 首行；`wfReg` = G4 的工具说明注入器，`wfHist` = 运行历史存储）

**含意（重要）**：

1. **不只是历史存储没到** —— **G4 的注入器也没到** ⇒ 这条 e2e 路径里
   `this.options.workerFactories` 是**空对象**；
2. 而 G4 的端到端用例**是通过的** ⇒ 说明 G4 的注入在它自己那条路径上生效，
   **与本用例的路径不同**（本用例由 `submitTask` 走主控制器的任务链，可能经
   `main-controller.ts:897` 的工具循环 + 另一条 worker 装配）。

**⇒ 结论：不要再往 `buildWorkerAgent` 上打补丁。** 必须先把"这条路径上
worker 的选项到底由谁组装"查清（`main-controller.ts:897` 附近 + 任务链下发处），
再在**那一处**接入 `runHistoryStore`。

**本卡状态（如实）**：`HISTORY-01-02` 数据层 ✅、钩子 ✅、`workerFactories` 透传 ✅，
但**实际 mission 路径不经过该透传** ⇒ 端到端未生效。**不得声称完成。**
**红用例**：`.tmp/history01-run-history-e2e.test.ts.draft`（未入库）。
### 13.12 第 49 轮取证 + **本卡收束（按纪律停手）**

| 取证 | 结论 |
| --- | --- |
| `main-controller.ts:897` 的 `runToolLoop` | 属**思索模式（ponder）**路径，**不是**本次 mission 路径 |
| 本次 mission 的工具调用 | 确实发生在 **`worker-agent`** 内（探针 `[H-P] tool=factVerification` 在 worker 里触发） |
| 该 worker 的构造点 | 唯一真实站点 `mission-orchestrator.ts:873`（`buildWorkerAgent`） |
| 但编排器探针显示 | `this.options.workerFactories` **两个字段都是 undefined** ⇒ 控制器传给编排器的 `workerFactories` 是**空对象** |

⇒ 剩下的唯一问题变成：**控制器在哪条分支构造编排器、为何 `workerFactories` 为空**。
这是**一处需要专门读控制器构造段**的收尾，不是"再改一行"。

**按纪律停手**：`HISTORY-01-02` 已用 **8 轮（42–49）**，超过 ≤6 轮预算。
**当前不声称完成**，并把已确定的结论留给下一会话：

- 数据层 ✅（8 条反例）
- `onToolFailed` 钩子 ✅
- worker 侧写入 ✅
- `workerFactories` 透传代码 ✅（但**实际为空** ⇒ 未生效）
- **端到端 ✗**（红用例在 `.tmp`）
- **下一步唯一动作**：读 `main-controller` 构造 `MissionOrchestrator` 的段落，
  查清 `workerFactories` 为何是空对象（是否只在 assist 分支传）。
### 13.13 第 50 轮收窄：编排器由**工厂**创建，`workerFactories` 可能在工厂里被默认成 `{}`

| 证据 | 内容 |
| --- | --- |
| 控制器里 `new MissionOrchestrator(` | **零命中** ⇒ 编排器不是直接 new 的 |
| 两处 `workerFactories` | `L981`（`contextLifecycleModeKey: "assist"`）与 `L1081`（`"devolve"`）**都存在**，我的 spread 也都在里面 |
| 但探针实测 | `wfReg=false wfHist=false`（连 G4 的 injector 也没到） |

⇒ **唯一合理结论**：实际运行的编排器**不是**用这两个对象构造的，而是经某个**工厂函数**创建，
工厂可能在 `workerFactories` 缺省时填 `{}`（或用了另一份参数）。

**下一会话第一步（一条命令即可）**：
`Select-String -Path packages/core/src/orchestration/*.ts -Pattern "MissionOrchestrator" | Select-String "new |create"` —— 找到工厂，
在工厂入口打 `[F-1] wf=String(workerFactories)` 探针，即可确定实际传入的是什么。
### 13.14 `HISTORY-01-02` **闭合**（2026-10-18 第 51–52 轮）

| 项 | 结果 |
| --- | --- |
| 根因 | 控制器有**两处** `workerFactories`（assist L981 / devolve L1081），第 42 轮只补了 assist ⇒ devolve 路径（测试走那条）漏了 `runHistoryStore` |
| 修复 | 两处都补 spread（计数=2）✓ `be573cd` |
| **端到端** | `history01-run-history-e2e.test.ts`：假 Provider 发 `tool_call` ⇒ 真实 mission ⇒ **`stateDirectory/run-history/*.json` 出现且含 `tool-call` + `factVerification`** ✓ **1/1 绿** |
| 单元 | `history01-run-history-store.test.ts` **8/8**（去重/分段/坏文件拒绝覆盖/钩子两路径） |
| 变异 | **69/69** ✓ |
| 隔离包 | **273 文件** ✓ |

**第 52 轮全量 `check`**：**471 通过 + 1 失败**
（`sensitive-content-production-wiring` 的 ADR-0018 用例）。
**该用例单独运行 2/2 通过** ⇒ 属仓库已记录的"间歇性全量门禁抖动"家族（见 `CROSS_CARD_RECONCILIATION` §4），
**不是本次改动引起**；**如实记录，不宣称全绿**。

**教训（写进纪律）**：`insertAfterLine` 这类"首个匹配"插入，**必须先数目标出现次数**；
本轮正是靠"两处 `workerFactories`"这个计数发现问题的。

---

## 14. 第 53 轮（2026-10-18，新会话接手）：HISTORY-01-03 公开侧交付 + 两处基线红灯

### 14.1 开工前的基线核对（如实）

| 检查 | 结果 |
| --- | --- |
| `git log/status` | HEAD = `b603ad6f` = `origin/main`；**工作树不干净**：10 个已修改文件 + 未跟踪的私有 UI（`packages/gui/`、`packages/tui/src/ui/`、`tests/gui/` 等）—— 均**非本轮产生**，按纪律**不动、不提交** |
| `npm run typecheck` / `lint` | exit 0 |
| `npm run build` | 在沙箱下 `spawn EPERM`（esbuild 需管道 stdio）；改用完整文件权限后 exit 0 |
| `npm run test` | **2 文件 / 5 用例失败** ⇒ 基线**不是绿的**，先修（见 §14.2）|

### 14.2 两处基线红灯的根因与处置

| 红灯 | 根因 | 处置 |
| --- | --- | --- |
| `agent-lifecycle-and-memory.test.ts`（记忆隔离）| 工作树里有一处**未提交**改动把观察的 `sourceAgentInstanceId` 记成 `runtimeAgentInstanceId` —— 等于「去除来源、冒充自身记忆」，与该文件注释及 §4 记忆隔离契约冲突；**恰好就是变异体 `memory-observation-source-replaced-by-owner` 的注入形态** | 恢复为 `input.sourceAgentInstanceId`（回到 HEAD 内容）；14/14 转绿 |
| `tests/gui/integration/gui02-04-package-entry.test.ts`（4 条）| 分层提交 `d3f01be6` 把 `tests/gui/**` 只写进 `coverage.exclude`，**没写进 `test.exclude`**；该文件的验收前提「GUI 必须有公开包入口」已被 `0cf91b24` **刻意移除** | 只排除**这一个已作废文件**（不整目录排除）：初版整目录排除后 `verify:mutation-kills` 立刻从 73/73 掉到 67/73 —— 6 条 `gui0203-*` 守卫全部"存活" ⇒ **收窄为单文件排除**，6 条恢复被拦下；**不改私有用例** |

### 14.3 HISTORY-01-03 公开侧（SDK + CLI）交付

| 项 | 内容 |
| --- | --- |
| 新模块 | `packages/core/src/orchestration/run-history-view.ts`：游标分页、种类过滤、三个显示开关、ANSI/OSC/控制字节移除（留可见占位）、详情截断标记、mission 列表（**只读当前页**）、`queryRunHistoryTimeline()` |
| 数据层收口 | `run-history-store.ts` 抽出**唯一**路径规则 `resolveRunHistoryFilePath()` 与 `validateRunHistoryDocument()`，视图层不再复制文件名规则 |
| 公开面 | `public-sdk.ts` 导出视图 API；`astarray history list` / `history show`（`--kind`、`--cursor`、`--page-size`、`--hide-run-history`、`--show-process-explanations`、`--hide-tool-calls`、`--json`） |
| 反例 | **31 条**（13 视图单测 + 12 进程内命令 + 6 条真实 `dist/cli.js` 子进程） |
| 拔线 | 3 次手工探针（显示设置/游标/脱敏）均变红，还原逐字节一致 |
| 永久变异 | 3 条（`run-history-view-ignores-display-settings` / `-ignores-cursor` / `-skips-display-sanitization`），单条复跑**均被拦下** |
| 全量门禁 | `npm run check` **exit 0：474 文件 / 3459 用例**；`test:coverage` exit 0（行 92.64% / 分支 85.20%）；变异 **73/73 被拦下**；`npm pack` **269 文件** + `verify-package` / `verify-sdk-consumer` 均 exit 0 |

> **覆盖率差点被我弄红（如实记）**：只写"真实子进程"用例时 `history-command.ts` 覆盖率是 **0%**
> （v8 不把 `dist` 子进程执行归属到 `src`）⇒ 全局分支跌到 **84.82% < 85%**，`test:coverage` exit 1。
> 补**进程内**调用命令函数的 12 条用例后回到 **85.20%**。⇒ **纪律**：新增 CLI 命令不能只靠子进程用例。
>
> **变异计数口径（如实）**：本轮 `verify:mutation-kills` 报 **73/73 被拦下** —— 其中**已提交 72 条**
> + **工作树里上一会话遗留、未提交**的 `run-history-drops-dedupe` 1 条（按暂存纪律**未提交**）。
> ⇒ **干净检出（HEAD）应报 72/72**；两者的差别只是那一条，且它同样被拦下。

### 14.4 已闭合的状态订正

- `RELOCATE-01-04`：命令名早已经用户确认（选项 A）且 CLI 已入库（`4e43ad48`），
  但 `PLAN_STATUS` 仍写「04 pending（命令名待确认）」⇒ 已就地订正，并补本轮复跑证据
  （`project status --json` exit 0、`unregistered`、**未创建目录**）。
  仍缺：**tarball 双进程证据**、TUI/GUI 入口。
- `HISTORY-01`：`PLAN_STATUS` 新增独立行（此前该卡无行），口径为
  「01/02 done；03 公开侧 done；04 未开始」，**不主张整卡通过**。

### 14.5 下一轮可直接开工的候选（按"本地可证"排序）

| # | 动作 | 前置 |
| --- | --- | --- |
| 1 | `HISTORY-01-03` 余项：TUI 面板（`packages/tui/src/ui/**` 属未跟踪私有目录，需先确认是否可提交）或 GUI 运行历史时间线视图 | 分层决策：UI 代码不入公开库 ⇒ **需用户确认落点** |
| 2 | `HISTORY-01-04`：tarball 恢复回溯（`npm pack` 后隔离安装 + 真实 CLI 读历史）—— **本地可做**，先验证 `npm install <tgz>` 能否真实生成 `node_modules` | 无（上一轮失败原因是本地 `npm install` 未生成 `node_modules`，需先诊断） |
| 3 | `RELOCATE-01-04` 的 tarball 双进程证据 | 同上 |
| 4 | backlog Tier 3 队列里其余卡（多数为外部/重型，逐张判） | 每张先读"未完成"段 |

> **未提交他人改动**：工作树原有的 10 个已修改文件（含 `IMPLEMENTATION_PLAN.md` 的
> `docs/tasks/accepted/` 链接修正、`HANDOFF_2026-09-28.md` 的路径回填等）与全部未跟踪私有 UI
> **均未暂存**；本轮提交只含 §14.2–14.4 的实际改动。

---

## 15. 第 54 轮（2026-10-18）：**tarball 双进程证据取得** —— 推翻 §13.2 的"未取得"理由

### 15.1 结论先行

| 项 | 结果 |
| --- | --- |
| `RELOCATE-01-04` 的 tarball 双进程证据 | **✅ 取得**（此前记为"未取得"） |
| `HISTORY-01-04` 的 tarball 回溯部分 | **✅ 取得**（资源测量与人工体验仍未做） |
| 上一轮理由「本机 `npm install` 不生成 `node_modules`」 | **❌ 被实测推翻**：`npm install <tarball>` **41 包 / 5 秒**，`node_modules` 正常 |

### 15.2 可复跑命令与判据

```powershell
npm pack
node scripts/verify-relocate-tarball-dual-process.mjs astarray-0.1.0.tgz   # exit 0
```

脚本做了 7 件事（全部是**真实进程**，不是内存桩）：
隔离安装 → 进程 A 只用已安装包公开出口写登记+运行历史 → **独立进程 B** 用已安装包 CLI
① 读搬迁状态（`identity-confirmed` / 可加载历史 / **禁止执行** / `只读恢复对账`）
② 确认**项目根条目数 0**（不自动建目录）
③ `history list` 列出该 mission
④ `history show` 含 `tool-call` + `tool-failure`（`permission-denied` 保留）且 `storedEventCount=3`
⑤ 查看后 `run-history/*.json` **仍为 1**（不重放）
⑥ 文本输出**无 ANSI/控制序列**

证据文件：`docs/reports/RELOCATE01_04_TARBALL_DUAL_PROCESS_EVIDENCE_2026-10-18.md`。

### 15.3 为此新增的公开出口（最小）

`public-sdk.ts` 增加 `RunHistoryStore` / `resolveRunHistoryFilePath` / `validateRunHistoryDocument`
与相关类型：宿主若自带写入方，必须与 `history` 读**同一份** schema 与路径规则，
否则会重演本仓反复出现的"宿主写 A 处、产品读 B 处"漂移。该出口**不授予**任何执行/授权能力。

### 15.4 仍未完成（如实）

| 项 | 阻塞 |
| --- | --- |
| `RELOCATE-01-04` 的 TUI/GUI 入口、确认卡人工体验 | UI 属未跟踪私有目录；人工体验只能由用户给 |
| `RELOCATE-01-04` 跨平台 | 本证据仅 Windows/Node v24.18.0 |
| `HISTORY-01-03` 的 TUI 面板、GUI 时间线、虚拟列表/搜索/锚点/滚动保持 | 同 UI 落点问题 |
| `HISTORY-01-04` 资源测量 + 人工体验 | 测量规模与体验结论需独立一片/用户执行 |

### 15.5 下一轮候选

| # | 动作 | 前置 |
| --- | --- | --- |
| 1 | `OBS-01 PERF-01-01` 的"开关前后测量"（`PLAN_STATUS` 唯一未覆盖项；`PERF` 采集本身也未接线） | 需先决定是否接线 `perfSampleSink`（改变生产行为） |
| 2 | `HISTORY-01-04` 资源测量（大量事件 + 超长输出的首次可读延迟/内存上界） | 可本地做，需定规模与设备记录口径 |
| 3 | TUI/GUI 历史视图（需你先定 UI 代码落点：公开库内 or `astarray-ui` 私有库） | **需用户一句话** |
| 4 | backlog Tier 3 其余卡逐张判（多数为外部/重型） | 每张先读"未完成"段 |

---

## 16. 100 轮推进日志（2026-10-18 起，逐轮追加）

**门禁节奏（为让 100 轮可持续，先写清、不隐瞒）**

| 每轮都跑 | 每 5 轮 / 触碰高危面时跑 |
| --- | --- |
| `typecheck` + `lint` + `build` + 定向反例 + **全量 `check`** | `test:coverage`、`verify:mutation-kills` **全量**、`npm pack` + `verify-package` / `verify-sdk-consumer` / 双进程脚本 |

- 单轮新增变异体**必跑单条 `--only` 验证被拦下**（不把全量变异留给下一轮冒充）。
- 全量门禁的数字**只在真跑过的那一轮写**，其余轮次写"未跑（按节奏）"。
- 每轮仍遵守：先红后绿、拔线必失败、只按显式路径暂存、不提交他人未提交文件、提交后推送。

| 轮 | 内容 | 证据 | 门禁 |
| --- | --- | --- | --- |
| R1 | `HISTORY-01-03` 余项：**关键词检索**（纯子串/大小写不敏感/不解释正则/只搜可见事件）+ **稳定证据锚点** `run-history:<mission>#<序号>`；CLI `--search` | `run-history-view.ts`、`history-command.ts`、`cli.tsx`；反例 +4（15+7+13=**35**）；新变异体 `run-history-view-ignores-search-query` | `check` **474/3463 exit 0**；`coverage` 分支 **85.22% exit 0**；单条变异被拦下 |
| R2 | `HISTORY-01-04` **资源测量**：新增 `scripts/measure-run-history-view.mjs`（父进程落夹具、子进程只测读，避免把夹具垃圾算进内存） | 1k/10k/50k（372 KB/3.7 MB/18.8 MB）⇒ 首页 **1.2/10.0/47.4 ms**、检索 **2.7/25.6/110.7 ms**、rss **+9.4/+153.8/+193.5 MB**；列表 203 mission 一页只读 **20** 文件（12 ms）。报告 `HISTORY01_04_RESOURCE_MEASUREMENT_2026-10-18.md` | 脚本 exit 0（测量，非门禁）；`check` 沿用 R1 结果并在本轮末复跑 |
| R3 | `CLIENT-01 / FOLDER-01-01`：文件夹授权的**纯判定层**（候选分类、短授权卡、批量逐项、逐段包含、真实路径不一致提示） | 新增 `folder-grant-request.ts` + `tests/core/unit/folder01-grant-request.test.ts`（**13 条**）；3 条变异体（模型代签／父目录放行／前缀包含）均被拦下；SDK 导出 | `check` **475/3476 exit 0**；`coverage` 分支 **85.22% exit 0** |
| R4 | `CLIENT-01 / FOLDER-01-02`：根登记事务与**执行前复检**（签发先评估、幂等重放、同 ID 异参冲突、陈旧 revision 拒绝、原子写+写前备份、撤销、八类 fail-closed 复检、重启持久化） | 新增 `folder-grant-store.ts` + `tests/core/unit/folder01-grant-store.test.ts`（**14 条**）；3 条变异体（忽略撤销／只读放行写／旧 revision 放行）均被拦下；SDK 导出 | `check` **476/3490 exit 0**；`coverage` 分支 **85.25% exit 0** |
| R5 | **全量门禁复验**（5 轮一次）：变异全量 + 隔离包三项 | — | 变异 **80 条：79 被拦下、1 条"存活"**（`gui0203-views-runtime-state-collapsed`）⇒ **单独复跑 2/2 被拦下**、且 18:17 那次全量也拦下过 ⇒ 判定为**全量并发下的 GUI 用例抖动**（记录在案，不当作真实缺口）；`npm pack` **269 文件** sha256 `50dc4d1c…`；`verify-package` / `verify-sdk-consumer` / tarball 双进程脚本 **均 exit 0** |
| R6 | `CLIENT-01 / SECRETARY-01-01`：实验性同级秘书**契约层**（默认关闭、认证用户、工作区边界、能力矩阵、可见列表默认空、任务转交不广播） | 新增 `secretary-agent-contract.ts` + `tests/core/unit/client01-secretary-contract.test.ts`（**9 条**）；3 条变异体（默认开启／源文件读取放行／目标不明当可派发）均被拦下；SDK 导出 | `check` **477/3499 exit 0**；`coverage` 分支 **85.28% exit 0** —— 第一次在覆盖率插桩下 `g5-early-stop-resume ①` 抖动，**单独复跑 2/2 通过**（如实记录，未改断言） |
| R7 | `CLIENT-01 / SECRETARY-01-02`：项目/汇总模式、**最小报告附件**（来源/项目/revision/时间/哈希）、新鲜度（过期如实给最后更新时间）、任务行键含项目（不串线）、派发幂等/冲突、回执只能前进、同级回派有界 | 新增 `secretary-relay-contract.ts` + `tests/core/unit/client01-secretary-relay.test.ts`（**9 条**）；4 条变异体（串线／重复派发／状态倒退／复制历史）均被拦下；SDK 导出 | `check` **478/3508 exit 0**（首跑 `completion-gate-counterexamples A0` 抖动 ⇒ 单跑 8/8、复跑全绿）；`coverage` **478 文件 / 3508 用例、分支 85.32% exit 0**（首跑 `anthropic-messages-runtime ⑰` 抖动 ⇒ 复跑全绿） |
| R8 | `CLIENT-01 / SECRETARY-01-03`：次日首次启动判定（IANA 时区/DST）、同日领取排他、历史收拢（收拢不删除、旧未决可见） | 新增 `secretary-first-start.ts` + `tests/core/unit/client01-secretary-first-start.test.ts`（**11 条**）；4 条变异体（忽略离线阈值／重复处理同日／领取不排他／收拢当删除）均被拦下；SDK 导出 | `check` **479/3519 exit 0**；`coverage` 分支 **85.33% exit 0** |
| R9 | `EXP-01 / FOLD-01-01`：等价折叠的**复用契约**（十项必填候选、明确前置条件、步骤偏序、不可折叠项冻结、副作用参数、版本化登记、回退守卫） | 新增 `workflow-fold-contract.ts` + `tests/core/unit/exp01-fold-contract.test.ts`（**9 条**）；4 条变异体（折入不可折叠项／跳过副作用参数校验／关掉逐步骤授权／复用旧许可）均被拦下；SDK 导出 | `check` **480/3528 exit 0**；`coverage` 分支 **85.39% exit 0** |
| R10 | **5 轮一次全量门禁**：变异全量（95 条）+ 隔离包三项 | — | 变异 **94/95**；唯一"存活"仍是 `gui0203-views-runtime-state-collapsed` ⇒ **单独复跑 2/2 被拦下**（与 R5 同一 GUI 用例的负载抖动；**该守卫与用例都在未跟踪私有 UI**，公开门禁不保证它）⇒ 如实记录、不当作缺口；`npm pack` **269 文件** sha256 `a30c0cf4…`；`verify-package` / `verify-sdk-consumer` / tarball 双进程 **均 exit 0** |
| R11 | `EXP-01 / EXPLORE-01-01`：问题指纹、计划必填、独立预算（**不透支**）、启动六类拒绝、停止六类条件 | 新增 `explore-plan-contract.ts` + `tests/core/unit/exp01-explore-plan.test.ts`（**9 条**）；4 条变异体（资源未知仍启动／允许透支／无进展不停／重复组合放行）均被拦下；SDK 导出 | `check` **481/3537 exit 0**；`coverage` 分支 **85.43% exit 0** |
| R12 | `EXP-01 / CURATE-01-01`：授权绑定 revision+参数指纹、未授权零自动整理、**本地确定性**重大变更矩阵、未知差异按重大、等待只暂停新方案 | 新增 `curation-plan-contract.ts` + `tests/core/unit/exp01-curation-plan.test.ts`（**9 条**）；4 条变异体（忽略范围扩大／未知差异降级／跳过指纹／连旧方案一起停）均被拦下；SDK 导出 | `check` **482/3546 exit 0**；`coverage` 分支 **85.49% exit 0** |
| R13 | `LESSON-01-01`：沟通经验记录契约（事件时配置快照、unknown 显式、事实/假设分离、个体归属写入、匹配与自动注入） | 新增 `lesson-record-contract.ts` + `tests/core/unit/lesson01-record-contract.test.ts`（**11 条**）；4 条变异体（主 Agent 可写／接受重建快照／事实假设混写／未知版本按精确匹配）均被拦下；SDK 导出 | `check` **483/3557 exit 0**；`coverage` 分支 **85.54% exit 0** |
| R14 | `WORKWINDOW-01-01`：工作/休息时段规则（白/黑名单、跨午夜、一次性例外优先、休息优先、项目不可覆盖全局休息）、IANA 时区与 DST、暂停原因分记、恢复六类阻塞、时钟跳变 | 新增 `work-window-contract.ts` + `tests/core/unit/workwindow01-contract.test.ts`（**12 条**）；4 条变异体（休息不再优先／例外不再优先／暂停原因被覆盖／忽略未知副作用）均被拦下；SDK 导出 | `check` **484/3569 exit 0**（首跑 `local-readonly-tools-production-wiring` 后置 EPERM rename 抖动 ⇒ 复跑全绿）；`coverage` 分支 **85.54% exit 0** |
| R15 | `CLIENT-01 / FOLDER-01-03`（**CLI 侧**，命令名＝用户确认的选项 A）： `astarray folder request / approve / revoke / check`，复用同一判定层/存储层 | 新增 `packages/tui/src/cli/folder-command.ts` + `cli.tsx` 注册； 反例 **10 条**（进程内）+ **4 条**（真实 `dist/cli.js` argv）； 4 条变异体（复检恒成功／approve 非人工确认／接受未知权限／不可登记仍报成功）均被拦下 | `check` **486/3583 exit 0**；`coverage` 分支 **85.54% exit 0** |
| R16 | **5 轮一次全量门禁**：变异全量（115 条）+ 隔离包三项 | — | 变异 **114/115**；唯一"存活"仍是 `gui0203-views-runtime-state-collapsed`（未跟踪私有 GUI 用例负载抖动） ⇒ **单独复跑 2/2 被拦下**；`npm pack` **269 文件** sha256 `95c207f6…`； `verify-package` / `verify-sdk-consumer` / tarball 双进程 **均 exit 0** |
| R17 | `DOCVIEW-01-01`：内容/结构/布局三模式能力矩阵与**损失提示**（枚举、扫描件不伪报、过滤视图不可写回、缓存隔离、样式详情按任务展开） | 新增 `document-view-contract.ts` + `tests/core/unit/docview01-contract.test.ts`（**8 条**）； 3 条变异体（允许写回／扫描件伪报支持／未知模式当有效）均被拦下；SDK 导出 | 低并发全量 `npx vitest run --maxWorkers=2` **487/3591 exit 0**（默认并发抖动用例见 R16 记录） |
| R18 | `CONFIGCHAT-01-01`：公开设置白名单/来源/作用域/风险矩阵与幂等——秘密不进对话、 文档注入与模型伪造用户拒绝、含糊范围先询问、旧 revision 拒绝、风险修改必须显式确认、 等待安全点不等于已生效 | 新增 `config-chat-contract.ts` + `tests/core/unit/configchat01-contract.test.ts`（**8 条**）； 4 条变异体（来源放行／旧 revision／跳过风险确认／秘密进对话）均被拦下；SDK 导出 | 低并发全量 `npx vitest run --maxWorkers=2` **488/3599 exit 0** |
| R19 | **门禁可复现性**：新增 `npm run check:low-parallel`（`vitest run --maxWorkers=2`）， 并在 `AGENTS.md` 常用命令里登记；用于默认并发下的负载抖动 | `package.json` + `AGENTS.md` | 该脚本实跑 **488/3599 exit 0**（339s）；默认并发抖动证据见 R16 |
| R21 | `EXP-01 / FOLD-01-02`：候选→组合包→独立验证→注册（作者不得自验、至少两种输入、须覆盖分支差异、 证据驱动、每步权限不得超出原批准集合、同版本幂等/异内容冲突） | 新增 `workflow-fold-package.ts` + `tests/core/unit/exp01-fold-package.test.ts`（**9 条**）； 3 条变异体（作者自验／权限扩大／单输入）均被拦下；SDK 导出 | 低并发全量 `check:low-parallel` **489/3608 exit 0**（首跑 `g2-progress-guard` 对照组抖动 ⇒ 复跑全绿） |
| R22 | `EXP-01 / EXPLORE-01-02`：有界试验执行（真实数据/生产远端禁止、隔离必填、试验键去重、 证据哈希、重启预算不刷新） | 新增 `explore-trial-contract.ts` + `tests/core/unit/exp01-explore-trial.test.ts`（**8 条**）； 3 条变异体（真实数据放行／重复重跑／重启刷新预算）均被拦下；SDK 导出 | 低并发全量 `npx vitest run --maxWorkers=2` **490/3616 exit 0** |
| R23 | `EXP-01 / CURATE-01-02`：周期增量执行（单实例锁、错过周期合并、按游标增量、休息不运行、 授权 revision 边界、摘要失败原文不变、个体隔离、重启续处理） | 新增 `curation-execution-contract.ts` + `tests/core/unit/exp01-curation-execution.test.ts`（**8 条**）； 3 条变异体（休息仍触发／错过周期补跑／失败声称覆盖完整）均被拦下；SDK 导出 | 低并发全量 `npx vitest run --maxWorkers=2` **491/3624 exit 0** |
| R24 | `CLIENT-01 / ONBOARD-01-01`：首次/适时提示（7 天冷却、**不再提示持久化**、跳过不重复、 忙碌类抑制、迁移不重复弹、推荐不构成授权、无遥测无画像） | 新增 `onboarding-hint-contract.ts` + `tests/core/unit/client01-onboarding-hint.test.ts`（**8 条**）； 3 条变异体（忽略拒绝／授权中弹／推荐即授权）均被拦下；SDK 导出 | 低并发全量 `npx vitest run --maxWorkers=2` **492/3632 exit 0** |
| R25 | **5 轮一次全量门禁**：变异全量（134 条）+ 隔离包三项 | — | 变异 **133/134**；唯一"存活"仍是 `gui0203-views-runtime-state-collapsed` （未跟踪私有 GUI 用例负载抖动，第 3 次出现）⇒ **单独复跑 2/2 被拦下**； `npm pack` **269 文件** sha256 `e4dbf35f…`； `verify-package` / `verify-sdk-consumer` / tarball 双进程 **均 exit 0** |
| R26 | `PROJECT-01-04`：**跨项目副本回执按个体过滤**（发现并修复"list --agent 串数据"） | `summarizeCopyReceipts` 增加 `filter`（来源/目标/接收个体）并解析 `receivingAgentInstanceId`； 摘要条目新增该字段（可追溯）；CLI 三个过滤参数同时传入。 反例 `cross-project-copy-receipt-filter.test.ts`（**3 条，修复前 3 红**）； 变异 `cross-project-copy-receipts-ignore-agent-filter` 被拦下 | 低并发全量 `npx vitest run --maxWorkers=2` **493/3635 exit 0** |
| R27 | `EXP-01 / FOLD-01-03`（判定层）：复用/停用/回退——已停用或未登记版本拒绝、参数 schema 必须一致、 未知副作用与在途实例阻塞回退、回归时停用新版本但**不自动重跑**、停用须记原因并留历史 | 新增 `workflow-fold-lifecycle.ts` + `tests/core/unit/exp01-fold-lifecycle.test.ts`（**7 条**）； 3 条变异体（未知副作用回退／自动重跑／复用停用版本）均被拦下；SDK 导出 | 低并发全量 `npx vitest run --maxWorkers=2` **494/3642 exit 0** |
| R28 | **契约层 SDK 的包级验收**：新增 `verify:contract-sdk`（隔离安装 tarball ⇒ 用已安装包观测 17 项 fail-closed 语义 ⇒ 纯函数判定）| 新增 `scripts/contract-sdk-scenario.mjs`、`scripts/verify-contract-sdk-package.mjs`、 `scripts/lib/contract-sdk-checks.mjs`(+`.test.mjs` 5 条，含"缺观测/空对象/单项退化"必须拒绝)； `npm run test:scripts` **44/44**；对 tarball sha256 `95858fc4…` 实跑 **17/17 判据通过、exit 0** （过程中判据真实抓到一个错误：观测脚本把 `mode` 写成 `working` 而非 `work-whitelist` ⇒ 白名单外被判 working； 修正后 `resting`）| `check` **exit 0**；`npm pack` 269 文件 |
| R29 | **公开库 UI 边界**（用户决策：只有 CLI 在公开库，TUI+GUI 统一私有库）：新增活规则守卫 + 接缝清点 | 新增 `tests/architecture/public-ui-boundary.test.ts`（3 条）：公开源码里的 UI 引用必须**精确等于钉住白名单** （新增即红）、白名单条目**迁走后必须删除**（否则红，防假通过）、私有 UI 文件不计入公开边界； 实测清点：公开库对 UI 的依赖**只剩 2 条** —— `commands.ts` 的 `gui serve`（静态可解析的动态导入，**待迁**） 与 `cli.tsx` 的 `./cli/tui.js`（可选动态导入，缺失即明确提示并非 0 退出）； **证据**：临时移走 `packages/gui` 后 `tsc --noEmit` **只有 1 条产品错误**（`commands.ts(3983)` 找不到 gui-server）， 移回后文件数不变（4/4）| `typecheck`/`lint` exit 0；该守卫 3/3 |
| R30 | **5 轮一次全量门禁**：变异全量（138 条）+ 隔离包**四项** verify（新增 `verify:contract-sdk`） | — | 变异 **137/138**；唯一"存活"仍是 `gui0203-views-runtime-state-collapsed`（未跟踪私有 GUI 抖动，第 4 次） ⇒ **单独复跑 1/1 拦下**；`npm pack` **269 文件** sha256 `95858fc4…`； `verify-package` / **`verify:contract-sdk` 17/17** / `verify-sdk-consumer` / tarball 双进程 **均 exit 0** |
| R31 | `RELOCATE-01-03` 接线片（**用户已按推荐批准**）：判定编排 `project-relocation-reconciler.ts` | 已完成跳过、解析失败 blocked、未决操作阻塞 blocked、**含写须人工确认**、只读可自动； 8 条反例 + 3 条变异体均被拦下；SDK 导出 | 全量（低并发）**exit 0**；**未做**：冷启动批量扫描真实历史库、`project reconcile` CLI、`status` 可选段 |
| R32 | **公开库 UI 收口**（分层决策执行完成）| **2026-10-19 R32 收口（用户已授权私有库改动）**：公开库**已不含任何 UI 源码**。①`gui serve` 真实实现（389 行，含门面覆盖/CSRF/SSE/安装与授权询问通道）迁到私有库`astarray-ui/packages/gui/src/cli/gui-serve-command.ts`（提交 `7a9c791`）；公开侧 `executeGuiServeCommand` 改为 **fail-closed 提示**（非 0 退出，绝不假装启动服务器）；②TUI 启动桥 `./cli/tui.js` 改为**非字面量**动态导入（公开构建缺该模块时明确提示 + 非 0），然后删除公开库内的 UI 本地副本：`packages/gui/`、`packages/tui/src/ui/`、`packages/tui/src/cli/tui.tsx`、`tests/gui/`、GUI 专用脚本（删除前逐文件比对：**41/41 与私有库副本字节相同**，私有库无未提交改动）；③依赖 UI 的 7 个公开测试迁到私有库（含 3 条 gui 诊断用例）；④`verify:mutation-kills` 的**9 条纯私有 UI 变异体**移出公开 harness（清单见 `docs/reports/MUTATIONS_MOVED_TO_PRIVATE_UI_2026-10-19.md`，私有库需重建同名守卫），另 3 条只删掉其中已失效的 `tests/gui` 用例路径；⑤公开库 UI 边界活规则白名单**清空为 0 条**（新增 UI 引用即红）。**门禁**：`typecheck`/`lint` 0；全量（低并发）**3396 用例 exit 0**；`npm run build` 成功。 |
| R33 | **RELOCATE 批量对账（脱敏样例）** | **2026-10-19 R33（用户批准：用脱敏样例验证 relocate）**：新增 `npm run verify:relocation-batch`。①**脱敏样例**：`scripts/lib/relocation-batch-sample.mjs` 构造 4 个虚构项目（alpha/beta/gamma/delta），路径全部形如 `/sample/projects/...`，不含本机用户名/盘符/凭据；覆盖正常改写、已在新根不改写、`..` 逃逸、种类未声明、跨设备、嵌套旧根歧义、已完成不重放、旧一次性许可、临时提升、未知非幂等副作用、含写项目。②**批量执行**：`scripts/verify-relocation-batch-sample.mjs` 用**已构建的公开 SDK**（`dist/public-sdk.js`）逐项目跑 `reconcileProjectRelocation`，把结果压成计数/稳定代码，再由可单测判定器判定（11 条判据，缺观测/项目缺失都算失败）。③**实测结果**：**11/11 判据通过、exit 0**；`npm run test:scripts` **51/51**。④**过程中发现并修掉一个真实缺陷**：批量对账第一次跑就**抛 TypeError**——一条观测残缺的未决操作（扁平结构、缺 `operation` 子对象）让 `decideRecoveryAfterRelocation` 读到 `undefined`。现已在 `reconcileProjectRelocation` 增加**输入校验**：观测残缺 ⇒ `blocked`（不抛错、不放行），反例第 ⑨ 条 + 变异体 `relocate-reconciler-malformed-observation-passes` 均落地（该变异体被拦下）。**边界（如实）**：这是**脱敏样例**证据，**不等于**真实历史库已验证；真实历史库批量解析仍未验证。 |
| R34 | `RELOCATE-01-03` **CLI 入口**：`astarray project reconcile` | **2026-10-19 R34：`astarray project reconcile` 已接通公开入口**（命令名按用户 2026-10-19 批准）。输入是**显式 JSON**（projectIdentifier / projectStatus / locationMappings / declaredStructuredResourceKinds /references / pendingOperations / hasWriteOrExternalSideEffects），不猜历史库、只读、不重放。退出码：**0** 可继续（只读自动恢复）；**1** blocked **或**含写需人工确认（非零更安全）；**2** 用法/输入错误。反例：**argv 级 5 条**（真实 `dist/cli.js`）+ **进程内 4 条**（直接导入 src，保证变异可见）；变异体 **2 条**（含写也 exit 0／改写计数恒 0），均被拦下。**未做**：`project status --json` 的 `relocation` 可选段；冷启动自动触发（目前是**用户显式执行**对账）。 |
| R35 | **5 轮一次全量门禁**：变异 135/135 + 隔离包**五项** verify + 锚点活规则 | **2026-10-19 R35（第 35 轮全量门禁）**：变异 **135/135 全部被拦下**（首次无"存活"；此前长期存在的私有 GUI 抖动用例已在 R32 随 UI 外迁移出公开 harness）。`npm pack` **263 文件** sha256 `604f7446…`（比 R30 的 269 少 6 个：R32 已把 GUI 代码移出公开库）；**五项 verify 全 exit 0**：`verify-package` / `verify:contract-sdk`(17/17) / `verify:relocation-batch`(11/11) /`verify-sdk-consumer` / tarball 双进程搬迁回溯。**本轮的真正发现（如实）**：`run-history-view-ignores-cursor` 的锚点**早已失效**（源码 `eligible`→`matched` 后未同步），⇒ 这条变异体长期**空转**（从未注入反事实），只有跑全量才报出来。已修锚点并**新增 `--check-anchors` 静态自检** +活规则 `tests/architecture/mutation-anchors-live.test.ts`（秒级：任一锚点命中次数≠1 即红，且要求检查条数 >100 防空转）。→ 交付后 `--check-anchors` 报 **135/135 条有效**。 |

> **R14 推送状态（如实）**：R13 提交 `c7c45e3a` 在本轮**再次连续 5 次**推送失败（128），`git ls-remote` 探针亦失败
> ⇒ 远端 SSH 通道持续不可达。按纪律继续累积，下一阶段合并 `c7c45e3a`、R14 提交重试（≤5 次）。
> **R14 门禁抖动**：首跑 `check` 的 484 文件/3569 用例**全部通过**，但 vitest 报 1 条**后置未处理错误**
> （`atomic-json` 的 Windows rename 竞争重试最终 `EPERM`，发生在测试完成后）⇒ 复跑全绿；如实记录，未改断言。

> **R5 记一条 harness 可靠性观察（如实）**：`gui0203-views-runtime-state-collapsed` 在**全量**运行里报"存活"、
> **单独**运行被拦下（且早前全量也曾拦下）。这与本仓已记录的"负载下门禁抖动"同族（GUI 用例会起本地服务）。
> **处置**：把"存活"条目**逐条单独复跑**作为判定前的必要步骤（本轮已做），不直接据此认定断言空洞；
> 未改 harness 语义（改判定会掩盖真实缺口）。

> **R9 记一条方法学教训（与 AGENTS 既有第 6 条同源，但更具体）**：用 `node -e` + PowerShell 双引号拼
> **含反引号**的中文长行时，反引号被 PowerShell 当转义符吃掉 —— 本轮把 `folder-grant-request.ts` 写成
> `older-grant-request.ts`（吞掉 `f`）、`evaluate()` 写成 `valuate()`。**已就地修复并全文正则复查**（`[^A-Za-z]older-grant` 等零命中）。
> **纪律**：凡含反引号/多行的文本，**一律写进 `.mjs` 文件再执行**（本轮 `PLAN_STATUS` 的 R6/R7 补救即用此法）。

> **R8 推送失败与恢复（如实）**：`8959beff` 曾连续 5 次 `Connection reset … port 22`（探针 `ls-remote` 有时成功），
> 按纪律记为跳过；**下一轮（R9）首次重试即成功**（`a0e56c32..8959beff`）。

### 16.1 未阻塞队列（2026-10-18 R4 分诊，按可本地验证程度排序）

| 顺序 | 项 | 为什么未阻塞 |
| --- | --- | --- |
| 1 | `CLIENT-01 FOLDER-01-03` | SDK 入口已有（判定层+存储层）；差 CLI/TUI/GUI 共用入口与包验收（UI 落点需用户定，但 **CLI 侧可先做**） |
| 2 | `CLIENT-01 SECRETARY-01-01` | 卡内是"实验开关/同级身份/目录边界/只读报告契约"，纯判定 + 开关，本地可做 |
| 3 | `EXP01` 的 `FOLD/EXPLORE/CURATE-01-01` | 三个 01 都是契约层（复用契约/问题指纹/授权矩阵），默认关，本地可做 |
| 4 | `LESSON01` | 沟通记忆的 schema/隔离/有效性状态，本地可做（无外部依赖） |
| 5 | `2026-10-01` 的 `DOCVIEW/CONFIGCHAT/WORKWINDOW-01-01` | 三个卡的第一检查点都是契约层；默认关，本地可做 |
| 6 | `PROJECT-01-04` 余项 | 多项目多同级个体经编排器的端到端压力（本地可做，较重） |
| 7 | `RELIABILITY-01-04` 返修项 | 幂等账目/并发/备份的返修与回归（本地可做） |
| 8 | `B6R-04b`（TUI 权限组控制面） | 需先定 UI 代码落点 ⇒ 与 §14.5 #3 同一决策 |

### 16.2 明确阻塞（不在本轮推进，等用户/平台）

| 项 | 阻塞原因 |
| --- | --- |
| `RELOCATE-01-03` 的路径解析/恢复门禁**产品接线** | 需要设计决定（在哪一层强制） |
| `OBS` 的 `PERF`/`DIAG` **生产采集接线** | 会改变生产行为（采样开销/事件语义），需用户决定 |
| `EVENT-01` | 验收口径未定（卡内为 pending，无完成证据口径） |
| `SUM-01` 人工标注、`TOOLKIT-01` 真实 token 额度 | 只能由用户/平台提供 |
| `GUI-01-R` / `GUI-02` / `WB-00` 人工体验 | 只能由用户执行 |
| `SMART-01` / `AR-07` / `B6R-10` / `BRIDGE-01` 的 macOS/Linux 证据 | 本环境无法产生（WSL 已有，macOS 无） |
> **R8 推送状态（如实）**：提交 `8959beff` 已在本地；`git push` **连续 5 次失败**（`Connection reset by 20.205.243.166 port 22`，
> 探针 `git ls-remote` 有时成功 ⇒ 已知的 SSH 写通道抖动）。按纪律记为本阶段**跳过**，
> 下一阶段把该提交与后续提交**合并重试**（≤5 次）。

> **R13 推送状态（如实）**：提交 `c7c45e3a` 已在本地；`git push` **5 次失败**、`git ls-remote` 探针同样失败（128）
> ⇒ 远端 SSH 通道不可达（与 R8 同类）。按纪律记为本阶段**跳过**；下一阶段合并 `c7c45e3a` 与后续提交重试（≤5 次）。

> **R16 门禁抖动（如实，重要）**：默认并发下 `npm run check` **连续 2 次失败、每次都是不同用例**
> （① `tests/gui/integration/gui-verification-decision.test.ts` 期望 done 实得 running；
> ② `tests/core/integration/g2-guard-positive-path.test.ts` 期望 done 实得 blocked），
> 两个文件**单独复跑 5/5 通过**；随后 `npx vitest run --maxWorkers=2` **486 文件 / 3583 用例全绿（exit 0）**，
> `npm pack` 的 prepack（默认并发 check）随后也通过。
> ⇒ 判定为**默认并发下的负载敏感抖动**，非本次改动缺陷；**未改任何断言/超时**。
> 建议（留给后续）：为这几个异步完成类用例补显式预算，或把门禁脚本改为低并发运行。

---

## 17. R20 暂停快照（2026-10-18，按用户指示在第 20 轮暂停）

### 17.1 代码与提交

| 项 | 值 |
| --- | --- |
| 本地 HEAD | 见 `git rev-parse HEAD`（R1–R20 共 20 轮提交） |
| 远端 | `origin/main` 可能落后（本快照前后推送多次遇到 `Connection reset … port 22`，按纪律累积重试） |
| 未推送提交 | 以 `git log --oneline origin/main..HEAD` 为准（不在此硬编码，避免过期） |

### 17.2 本轮窗口交付（R1–R19）

| 类别 | 内容 |
| --- | --- |
| 新判定层模块（11 个） | `run-history-view`、`folder-grant-request`、`folder-grant-store`、`folder-grant-command`(CLI)、`secretary-agent-contract`、`secretary-relay-contract`、`secretary-first-start`、`workflow-fold-contract`、`explore-plan-contract`、`curation-plan-contract`、`lesson-record-contract`、`work-window-contract`、`document-view-contract`、`config-chat-contract` |
| 新永久变异体 | **57 条**（R1–R18），全部逐条验证被拦下 |
| 新反例 | 约 **150 条**（各模块 8–14 条 + CLI 进程内/argv 两层） |
| 门禁 | 每次提交前跑定向反例 + 全量测试；R5/R10/R16 跑全量变异 + `npm pack` 三项 |

### 17.3 最近一次基线（R19 实测）

```
check:low-parallel   488 文件 / 3599 用例   exit 0   （339s，--maxWorkers=2）
mutation（R16）      114/115 被拦下         唯一"存活"= 未跟踪私有 GUI 用例负载抖动，单跑 2/2 拦下
npm pack（R16）      269 文件 sha256 95c207f6…；verify-package / verify-sdk-consumer / tarball 双进程 均 exit 0
```

> **默认并发抖动（已留证据）**：`npm run check` 在默认并发下连续两次失败于**不同**异步用例
> （`gui-verification-decision`、`g2-guard-positive-path`），两个文件单独复跑均通过；
> 已新增 `npm run check:low-parallel` 作为可复现门禁（R19），**未改任何断言/超时**。

### 17.4 未阻塞队列（下一轮可直接开工）

| 顺序 | 项 | 说明 |
| --- | --- | --- |
| 1 | `EXP-01 / FOLD-01-02` | 候选→组合包→独立验证→注册（契约已在 R9 落地，02 可基于它做） |
| 2 | `EXP-01 / EXPLORE-01-02` | 有界试验执行/隔离/重启预算不刷新（契约已在 R11） |
| 3 | `EXP-01 / CURATE-01-02` | 周期增量执行/个体隔离/计划锁（契约已在 R12） |
| 4 | `PROJECT-01-04` | 多项目多同级个体经编排器的端到端压力 |
| 5 | `RELIABILITY-01-04` | 幂等账目/并发/备份返修回归（需先复核现状） |
| 6 | `TOOLKIT-01` 剩余 | 真实 token 消耗等须真实额度项 ⇒ **外部** |

### 17.5 仍待用户决策（推进这些需要一句话）

| 项 | 需要什么 |
| --- | --- |
| TUI/GUI 入口（FOLDER-01-03 余项、SECRETARY-01-04、HISTORY-01-03 余项） | UI 代码落点：公开库内 or `astarray-ui` 私有库 |
| **UI 落点（已决策）** | **2026-10-19 用户决策（分层，正式）**：**只有 CLI 落在公开库（core+CLI）**；**TUI 与 GUI 统一放在私有库 `astarray-ui`**，公开库不含任何 UI 源码。权威副本以 `astarray-ui` 为准；公开库目录内残留的 UI 是**待删除的本地副本**（仅为当前 CLI 的 `gui serve` 类型依赖而存在）。 |
| `RELOCATE-01-03` 路径解析/恢复门禁**接线** | 在哪一层强制（设计决定） |
| `OBS` 的 `PERF`/`DIAG` **生产采集接线** | 是否接受采样开销/事件语义（改生产行为） |
| `EVENT-01` | 验收口径 |
| 人工体验 / macOS 证据 / 真实凭据 | 只能由用户或平台提供 |

### 17.6 施工纪律沉淀（本轮新增）

1. **含反引号/多行的文本一律写进 `.mjs` 再执行**（PowerShell 双引号会把反引号当转义符；本轮踩了 3 次）。
2. **追加表格行要"插入"而不是"替换上一行"**：本轮有 2 次把上一轮的行覆盖掉，均已修复；判定方法是插入后立刻 `Select-String '^\| R'` 数一遍。
3. **默认并发抖动用 `check:low-parallel`** 取可复现证据；不因此放宽断言。
4. **未跟踪私有 UI 的守卫不在公开门禁范围内**：出现"存活"先逐条单独复跑，再判定。
