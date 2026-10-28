# ADR-0047 主 Agent 报告索引：终态写入、来源认证与按需读取

- 状态：已采纳（生产接线）
- 日期：2026-10-28
- 来源：[ALIGN-01](../tasks/ALIGN01_IDENTITY_AND_MAIN_AGENT.md) 检查点 06
- 相关：ADR-0022（汇报只入档）、ADR-0044（身份分层）、ADR-0045（提案边界）

## 1. 背景

ALIGN-01-06 要求：下级报告进入主 Agent 的**只读报告索引**并带来源；到用户后续相关交流
**再**读取，**不自动**把全部报告塞进主上下文；必要提醒由本地通知层发送，不改记忆归属。

实测基线（本轮核对）：

- `MainAgentReportArchiveIngestor`（写索引/校验哈希）与 `MainAgentReportReader`（按 token 预算选择）
  都已存在，装配也已接好来源认证端口；
- 但 `ingestTertiaryTerminalReport` **零调用方**，`TertiaryTerminalReport` **零生产者**
  ⇒ 索引永远是空的，"只读读取"也就无物可读；
- 来源认证要求报告主体已在 `RegisteredAgentDirectory` 登记，而正常产品流程里
  **次级主体从未登记**（只有 CLI 的两个合成场景手写了硬编码 id）；
- `devolve` 模式没有下级，若照搬写入就会把主 Agent 自己的调度记成"下级汇报"。

## 2. 契约（冻结）

1. **只有 assist（有下级）在终态写报告**：`done` / `cancelled` / `blocked` 映射为
   `completed` / `terminated` / `blocked`。`devolve` **不写**（没有下级，不能伪造来源）。
2. **来源必须先登记**：assist 启动调度器时用与调度器**同一**标识登记
   `agentRole: "secondary"`、绑定 `missionId`、`boundTaskBundleId: null`；
   报告写入经过 `sourceAuthenticationPort` 校验，未登记/错 mission 直接拒绝。
3. **不编造证据**：`executedChecks` 在任务组终态没有可核对命令与退出码时**如实留空**；
   摘要只写可核对的计数（任务数/已完成/未完成），不写"质量通过"之类的结论。
4. **幂等且可追溯**：`reportId = mission-report-<missionId>-<reportKind>-<摘要短哈希>`；
   同一内容重复收口不重复写；状态变化（如 blocked → done）生成**新**报告，
   两个终态事件都保留。内容哈希由 ingestor 重新计算并校验。
5. **只入索引、不注入**：写入路径不调用 `streamOutput`、不改上下文、不唤醒模型；
   读取只有两个**显式**入口：
   - `MainController.listReportIndex(missionId)`：索引元数据（含来源个体、哈希、时间）；
   - `MainController.selectRelevantReports({ missionId, maxReports, tokenBudgetTokens })`：
     按 token 预算选择正文，供用户后续问到该任务时**手动**取用。
6. **索引失败不回滚终态**：mission 状态以摘要为准，索引写入异常被吞掉并保持终态不变。

## 3. 生产调用链（源码位置）

```
assist 启动
└─ MainController.launchAssistMission → resolveSecondaryAgentInstanceIdentifier   （登记次级来源）
mission 终态
├─ AssistScheduler.onReportToMain("任务完成状态: …")                              packages/core/src/orchestration/assist-scheduler.ts
│  └─ MainController.onReportToMain → updateMissionStatus → ingestMissionTerminalReport
│     └─ MainAgentReportArchiveIngestor.ingestReport                              packages/core/src/orchestration/main-agent-report-archive.ts
│        ├─ sourceAuthenticationPort → RegisteredAgentDirectory.verifyReportSource
│        └─ 写 <state>/main-agent-reports/<missionId>/<reportId>.json
└─ onMissionGateBlocked → updateMissionStatus("blocked") → 同一写入（kind=blocked）
用户后续交流（显式，非自动）
└─ MainController.selectRelevantReports → MainAgentReportReader.selectReports（token 预算）
```

## 4. 未完成（如实）

- **三级（tertiary）级报告生产者**：现在只有 mission 级终态报告；三级任务包的
  完成/终止/阻塞汇报仍要在 ALIGN-03（反馈进程生产路径）里接。
- **提醒层**：终态没有向用户推"报告已归档"的本地通知（卡内允许，但不是必须）；
  现有 `[需要用户]` 升级通道保持不变。
- **保留策略**：`main-agent-reports/**` 没有自动清理/配额。
- **token 预算估算**仍沿用既有"JSON 长度 / 4"的粗估，不是真实 tokenizer。
- **UI 展示**：CLI/TUI/GUI 未渲染索引（属界面仓库范围）。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
**没有**用真实 mission 跑过一次"终态 → 索引文件 → 读回"的端到端验证。
