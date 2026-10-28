# ADR-0073 远程主体绑定、范围与双步骤投递（REMOTE-01-02）

- 状态：部分采纳（绑定存储 + 入站核验契约 + prepare/deliver 拆分；无平台适配器）
- 日期：2026-10-28
- 来源：[REMOTE-01](../tasks/REMOTE01_SCOPED_RUN_EVIDENCE_EXPORT.md) 检查点 02
- 相关：ADR-0072（快照）、ADR-0070（外发门禁）

## 1. 背景

卡内要求：首次远程绑定由**认证用户单独确认**账户/设备并返回**明确授权范围**；
**IM 来信不自动等于认证用户**（验签/时间戳/重放/账户绑定/设备可识别）；
设备请求在预授权范围内可直接得到记录，越范围发**独立短授权请求**、**不能自批**、
不能凭相同昵称扩权；拆 `prepareEvidenceExport` / `deliverEvidenceExport`，
秘书模型只提案、**可信本地控制面**渲染/发出；新能力只加窄范围允许项。

实测：仓库里只有默认关闭的秘书契约（纯类型），**没有**远程主体绑定、没有入站核验、
没有 prepare/deliver 拆分、没有范围模型。

## 2. 契约（冻结）

1. **绑定字段**（`RemoteIdentityBinding`）：`bindingIdentifier`、平台、账户、
   `deviceIdentifier | null`、**`authenticatedUserId`**（不是昵称/会话 id）、
   授权项目集合、授权记录类别（窄集合：run-summary / task-status / tool-activity /
   artifact-registration / review-conclusion）、`expiresAtIso`、`revokedAtIso`。
2. **入站核验**（`verifyRemoteInboundMessage`）按顺序拒绝：
   签名无效 → 重放（消息标识已处理）→ 时间戳偏移超限（缺省 300s）→ 账户未绑定 →
   绑定过期/撤销 → 设备不符。通过时给出 `authenticationLevel`：
   `account-and-device`（绑定含设备）或 `account-only`（平台无设备标识，只能承诺账户级）。
3. **范围判定**（`evaluateRemoteExportScope`）三态：
   `within-preauthorization` / `requires-independent-approval`（逐条列原因）/ `denied`（过期/撤销）。
   **不提供"自我批准"入口**；越范围只能走独立授权。
4. **双步骤**：
   - `prepareEvidenceExport`：绑定与范围校验 → 调证据提供方 → **可信控制面渲染**纯文本；
   - `deliverEvidenceExport`：只接受 `prepareEvidenceExport` 的产物，投递前**再次**校验绑定与范围，
     **不接受模型传入的文本**；投递端口必须幂等（outbox 属检查点 03）。
5. **窄范围**：不新增任意文件读取 / 桌面抓屏 / 通用 HTTP；导出内容只来自快照。

## 3. 生产调用链（源码位置）

```
IM/远程入口（未实现适配器）
└─ verifyRemoteInboundMessage                packages/core/src/orchestration/remote-evidence-export.ts
   └─ RemoteIdentityBindingStore.read        <state>/remote-identity/bindings.json
准备（本地控制面）
└─ RemoteEvidenceExportService.prepareEvidenceExport
   ├─ evaluateRemoteExportScope（项目/类别/目标账户/设备/期限/撤销）
   ├─ evidenceProvider → MainController.requestRunEvidence（ADR-0072）
   └─ renderEvidenceSnapshotAsPlainText（可信渲染）
投递（本地控制面）
└─ deliverEvidenceExport → 再次范围复核 → deliveryPort.send（幂等承诺）
```

## 4. 未完成（如实）

- **没有平台适配器**：`platformSignatureValid` 是调用方传入的**布尔声明** ——
  真正的 IM 验签（签名算法、密钥轮换、时间戳格式）**没有实现**；
  在适配器可信之前，本层无法独立证明"消息确实来自该平台"。
- **没有首次绑定流程**：没有"认证用户单独确认账户/设备"的 CLI/UI 与服务端校验；
  `RemoteIdentityBindingStore` 只有读写，**谁有权写绑定**尚未约束。
- **没有独立短授权通道**：越范围只返回"需要批准"，**没有**发起/收集/校验独立授权的实现。
- **没有接线**：运行时未构造本服务；投递端口没有实现（REMOTE-01-03 的 outbox 是前置）。
- **投递幂等只靠端口承诺**：本层不持久化去重（属 03）。
- **未验证**：没有跑过"签名无效/重放/时间戳偏移/设备不符/越范围/撤销后投递"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收；无真实 IM 平台接入。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
