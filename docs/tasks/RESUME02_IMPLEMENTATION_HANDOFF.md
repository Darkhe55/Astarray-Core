# RESUME-02 实现交接（2026-11-24 首版）

> 本文件对应 [RESUME02_EXPERIMENTAL_SMART_CONTINUATION](RESUME02_EXPERIMENTAL_SMART_CONTINUATION.md) 检查点 01–05。
> **范围**：本地判定层、回执持久化、领取/fencing、有界恢复包（纯装配）、CLI 只读状态与显式请求写入。
> **不包含**：worker 派发、SDK 方法、远程通道、恢复包的真实内容读取/扫描接线、观测计数器、人工验收。

## 1. 真实调用链（逐入口）

### 1.1 `astarray continuation status [--json]`

```
packages/tui/src/cli.tsx（命令注册）
└─ executeContinuationStatusCommand            packages/tui/src/cli/continuation-command.ts
   ├─ readCheckpointContinuationSetting        （读 <state>/continuation/config.json；缺失/损坏 ⇒ 关闭）
   ├─ ResumeIntentReceiptStore.count           （有效回执数，按 nowIso 过期）
   └─ ContinuationController.listClaims        （活动领取；只读）
```

输出字段：`isEnabled / settingReason / activeReceiptCount / activeClaims[] / note`。
`note` 固定提示"领取不等于已恢复/已派发"。

### 1.2 `astarray continuation request --mission --task --expected-revision [--request-id]`

```
executeContinuationRequestCommand              packages/tui/src/cli/continuation-command.ts
├─ readCheckpointContinuationSetting           配置关闭 ⇒ 直接 disabled（不读链、不写回执）
├─ 主体解析：ASTARRAY_AUTHENTICATED_USER_ID    缺失 ⇒ exit 2（不信任请求正文）
├─ TaskStore.readTaskChain(mission)            packages/core/src/infra/task-store.ts
│  └─ 状态映射 running→running / done→completed / pending→planned / 其余→started-unknown
├─ evaluateContinuationRequest                  packages/core/src/orchestration/continuation-request.ts
│  └─ 非 resumable ⇒ 直接返回状态（needs-* / reconciling / nothing-to-resume）
├─ ResumeIntentReceiptStore.issue              packages/core/src/orchestration/continuation-receipt-store.ts
│  └─ 5 分钟有效；同 requestIdentifier 幂等
└─ ContinuationController.requestContinuation   packages/core/src/orchestration/continuation-controller.ts
   ├─ 复核回执（主体/目标/版本/期限）
   ├─ 读 `continuation/claims.json`；同请求幂等 ⇒ already-claimed
   ├─ 同任务同版本的另一请求 ⇒ claim-conflict-active
   └─ 领取：单调 fencingToken、2 分钟租约；写回文档
```

**未接线**：领取成功后**不调用** `resumeRecoveredMission`，不装配上下文，不写派发回执。
调用链止于"可派发"状态，输出里明确标注。

### 1.3 纯装配层（无 I/O）

```
assembleContinuationPack                       packages/core/src/orchestration/continuation-context-pack.ts
├─ 窗口预算 = 模型窗口 − 系统/工具说明 − 输出预留 − 安全余量
├─ available = min(窗口预算, 全局预算 4096)
├─ 未知窗口 ⇒ blocked: model-window-unknown
├─ 安全约束先计入；超预算 ⇒ blocked（绝不静默截断）
├─ 无关/已关闭节点移出，记 leftOnDiskTaskIdentifiers
├─ 当前前置节点优先
└─ 装不下任何节点 ⇒ blocked: minimal-pack-exceeds-budget
```

## 2. 配置默认值

| 配置 | 默认 | 语义 |
|---|---|---|
| `isCheckpointContinuationEnabled` | **false** | 仅显式 `true` 开启；缺失/损坏/非布尔 ⇒ 关闭 |
| 回执有效期 | **5 分钟** | 过期即拒绝；不延长 |
| 领取租约 | **2 分钟** | 到期后旧 token 不再"当前"，但**不证明旧工具已停止** |
| 全局上下文预算 | **4096 token** | 与窗口预算取更严；用户设置优先 |
| 模型意图辅助 | **不存在** | 首版不实现 `isModelIntentAssistanceEnabled`，不解析自然语言 |

## 3. 已复用组件（不重复造）

- `TaskStore.readTaskChain`：本地权威任务链读取（含跨进程锁）。
- `recovery-checkpoint-schemas.ts`：planned/started/confirmed-success/confirmed-failure/result-unknown 分类沿用（本层未新增分类器）。
- `resumeRecoveredMission`（SDK）：**未调用**；其显式确认、对账、重新授权门禁必须在 dispatch 接线时复用，不得绕过。
- `instruction-stop-recovery.ts`：早停/待澄清/关闭回执分类不重复实现。
- 诊断漏斗 `logToStderr`（CLI 输出纪律）。

## 4. 已知剩余问题（按优先级）

1. **dispatch 未接线**：领取后需调用 `resumeRecoveredMission`（含对账与重新授权），并写派发回执；
   否则"已领取"只停留在状态文件里。
2. **恢复包真实装配**：内容读取、SEC-02 敏感内容扫描、权限检查必须在注入前完成；当前只接受注入的节点数据。
3. **SDK 方法缺失**：`requestContinuation/queryContinuation/cancelContinuation` 未进公共 SDK。
4. **远程通道**：`/resume <任务编号>` 适配未做（要求明确命令、非文本匹配）。
5. **观测**：恢复重复执行次数、过期拒绝、对账阻塞、恢复时延、恢复包大小未记录。
6. **并发**：同一任务跨进程并发领取只靠文件写入串行（无跨进程锁），高并发下可能双写。

## 5. 待验证条件（无实测不填成功）

- 多目标/无目标/待回答/待授权/人工暂停/取消/休息期：仅判定层单测覆盖，**无真实任务宿主演练**。
- 网络断在执行前/后/回执前、旧执行者仍活着、重启、版本变化、权限撤销：**未实测**。
- 上下文满/换模型/敏感缓存：装配层单测覆盖边界，**未接真实内容与扫描**。
- 人工验收：**无**（与卡内"implemented-unverified"口径一致）。

## 6. 验证证据（2026-11-24）

| 测试文件 | 条数 | 覆盖 |
|---|---|---|
| `tests/core/unit/resume02-continuation-request.test.ts` | 12 | 配置默认关闭、状态推导、回执复核 |
| `tests/core/unit/resume02-receipt-store.test.ts` | 7 | 去重、跨实例、过期、损坏、多请求 |
| `tests/core/unit/resume02-continuation-controller.test.ts` | 7 | 领取、fencing、冲突合并、坏文件 |
| `tests/core/unit/resume02-context-pack.test.ts` | 8 | 预算、未知窗口、约束不截断、前置优先 |
| `tests/tui/unit/resume02-continuation-status-command.test.ts` | 3 | 只读状态、配置损坏 |
| `tests/tui/unit/resume02-continuation-request-command.test.ts` | 6 | 写路径、未认证、运行中、领取 |

全量门禁（2026-11-24）：`npm test` 与 `npm run lint` 通过；隐私检查 `privacy-ok`。

## 7. 构建产物验证（2026-11-24，第 115 轮）

在构建后的 `dist/cli.js` 上实测：

| 命令 | 结果 |
|---|---|
| `continuation --help` | 列出 `status` / `request` 两个子命令（exit 0） |
| `continuation status --json` | 输出 `status=continuation-status`、`isEnabled=false`、`settingReason=config-missing`、`activeClaims=[]`、`note` 含"不等于已恢复" |
| `sandbox self-check --json` | 输出验收记录：`backendKind=null`、`isExecutionAllowed=false`、下一步"无隔离后端" |
| `scripts/check-public-privacy.mjs` | `privacy-ok` |

说明：以上均为**只读/显式请求**入口；`request` 成功也只到"已领取"，dispatch 仍未接线（见 §4）。