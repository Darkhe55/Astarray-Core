# REMOTE-01 平台阻塞登记（2026-10-28）

> 结论：**REMOTE-01 的投递面是平台阻塞，不是代码缺陷。**
> 契约（快照 / 绑定 / 双步骤 / outbox / unknown 语义）已就绪；
> **两个仓库里都不存在任何 IM / Webhook / 邮件发送实现**，所以"投递"当前**无法实现**，
> 也不应标成"已实现待验证"。

## 1. 检索证据（本轮实际执行）

| 检索 | 范围 | 结果 |
|---|---|---|
| `webhook\|feishu\|dingtalk\|slack\|telegram\|wecom\|nodemailer\|\bsmtp\b` | `astarray/packages/**/*.ts` | **0 命中** |
| 同模式 + `RemoteEvidenceExportService\|RemoteDeliveryTransportPort` | `astarray-ui/**/*.{ts,tsx}` | **0 命中** |
| `fetch\(` / `http.request` / `undici` | `astarray/packages/core/src/**/*.ts` | **0 命中**（core 的网络出口只有注入的 `fetchImpl`/transport 端口） |
| `fetch\(` / `axios` / `http.request` | `astarray-ui/**/*.{ts,tsx}` | 46 命中，**全部指向 UI 自己的本地 GUI server**（`/state`、`/settings`、`/commands/*`）或 GUI 集成测试 |

## 2. 现有契约（已就绪，可直接接）

| 能力 | 位置 | 状态 |
|---|---|---|
| 运行记录快照 | `orchestration/remote-evidence-snapshot.ts` | 纯构造 + 哈希 |
| 主体绑定 / 入站核验 / 范围 | `orchestration/remote-evidence-export.ts` | 契约 + 本地校验 |
| 双步骤 | `prepareEvidenceExport` / `deliverEvidenceExport` | 已拆；投递走端口 |
| 幂等 outbox / unknown | `orchestration/remote-delivery-outbox.ts` | 先读回执、无回执即 unknown |
| 传输端口 | `RemoteDeliveryTransportPort`（`send` + `readReceipt`） | **只有接口，无实现** |

## 3. 缺什么（平台侧，不是本仓库能补）

1. **一个可用的 IM/投递平台应用**（企业微信 / 飞书 / Slack / Telegram / SMTP 任一），
   且具备：发送 API、**回执查询 API**（没有回执就只能一直 `unknown`）、
   消息签名或来源校验机制。
2. **平台是否提供设备标识**：不提供 ⇒ 只能承诺 `account-only` 授权（契约已支持），
   不能假装"设备绑定"。
3. **回调/回执通道**：若平台只支持 webhook 回调，需要**公网可达**的回调地址
   （本地开发通常需要隧道），否则回执只能靠轮询查询接口。
4. **凭据与权限**：bot token / app secret / webhook URL / 可选 IP 白名单；
   **不得**把真实凭据写进仓库或聊天（只经本地凭据库/环境变量注入）。

## 4. 解除条件（可验收，逐条）

- [ ] 选定平台并提供**测试租户**（不与真实用户混用）；
- [ ] 用平台文档中的**签名算法**能验证一条示例请求（有测试向量）；
- [ ] 能查询**单条消息的回执**（成功/失败/未知三态可分）；
- [ ] 端到端演练各一次：`prepare → deliver → sent`、`deliver → 无回执 ⇒ unknown`、
      `撤销绑定后 deliver ⇒ refused`；
- [ ] 凭据只经本地注入；仓库内**零真实凭据**（隐私自检通过）；
- [ ] 明确平台**限流/重试**语义（否则 outbox 的重试策略无法定论）。

## 5. 现在能做什么 / 不能做什么

- **能**：本地生成快照、校验绑定与范围、渲染纯文本、入队 operation、按回执判定
  `sent`/`unknown`、拒绝自动换目标；全部可被测试替身驱动。
- **不能**：真的把消息发到任何 IM；**不能**声称"已投递"；**不能**在无平台回执的情况下
  把 `unknown` 说成成功。

## 6. 影响的其他卡

- SEC-02-04 的外发门禁（`outbound-content-gate`）同样**没有生产调用方**，原因与本卡一致：
  没有投递链路可挂。
- 因此"外发门禁接线"应排在平台接入**之后**，而不是先做一个永远不被调用的钩子。

## 7. 验证状态

**静态检索**（本轮实际执行，命令见 §1）＋**契约代码已通过 `typecheck`/`eslint`/`build`**。
**没有任何真实发送**；本文件不构成"已投递/已验收"。
