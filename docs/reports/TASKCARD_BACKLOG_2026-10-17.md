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
