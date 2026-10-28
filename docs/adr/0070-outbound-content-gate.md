# ADR-0070 通用外发门禁与静态反例（SEC-02-04）

- 状态：部分采纳（纯判定 + 公共 SDK 入口；无生产调用方）
- 日期：2026-10-28
- 来源：[SEC-02](../tasks/SEC02_LOCAL_SCAN_COVERAGE.md) 检查点 04
- 相关：ADR-0067（四态扫描）、ADR-0069（入口 fail-closed）

## 1. 背景

卡内要求：外发门禁绑定**来源项目、内容 revision、目标账户/设备、授权范围、规则版本**；
检查**内容**与**最终导出元数据**；脱敏导致内容变化要**生成新 revision 并重走授权绑定**；
未认证 / 扫描未完成 / 来源无权 / 设备解绑**均阻断**；产出公共调用链清单与静态反例记录。

实测：仓库里**没有通用外发门禁**。现有的外发相关组件都是"专用场景"：
反馈进程（进程间 IPC，不出本机）、MCP 工具桥（到外部工具服务）、秘书契约（默认关闭，
且未实现投递链路，见 REMOTE-01 的静态审查）。没有任何一处能回答
"这份内容能不能发出去、发给谁、依据哪次授权"。

## 2. 契约（冻结）

1. **默认拒绝**：认证主体、来源项目、内容 revision、目标账户任一缺失 ⇒ 阻断（不补默认值）。
2. **扫描必须干净**：`scanResult === null` / `incomplete` / `error` / `sensitive` 全部阻断；
   `incomplete` 的原因（字节/时限）如实带出。
3. **规则版本绑定**：扫描结果的 `ruleSetVersion` 与授权绑定的版本不一致 ⇒
   `rule-version-mismatch`（规则变了，旧授权不再代表同一判定）。
4. **脱敏 ≠ 原内容**：`didRedactionChangeContent` 为真时，内容哈希必须变化，
   且授权绑定必须已是**新 revision + 新哈希**；否则 `reauthorization-required`
   并返回应批准的新 `{contentRevision, contentHash}`。
5. **导出元数据一致**：导出头里的 `contentHash` / `contentRevision` / 目标账户 / 目标设备
   必须与"实际内容 + 本次目标"完全一致（防止"检查 A 后导出 B"）。
6. **设备边界如实**：平台不提供设备标识时授权绑定为 `null`，此时只能承诺**账户级**授权；
   一旦授权绑定了设备而本次缺少或不符 ⇒ `device-unbound`。
7. **纯判定**：不联网、不发消息、不写盘；调用方在真正发送**之前**调用。

## 3. 公共调用链清单（谁应该调用它）

| 出口 | 现状 | 应做的检查 |
|---|---|---|
| REMOTE-01 `prepareEvidenceExport` / `deliverEvidenceExport` | **未实现**（仅设计） | 发送前调用本门禁；快照 revision/哈希与授权一致 |
| 报告/证据导出（本地文件、zip） | 未接 | 导出头写入 `contentHash`/`contentRevision`，写出前复核 |
| 插件 / MCP 外发结果 | 未接 | 外部工具调用前的出站载荷 |
| 反馈进程 | **不适用**（本机 IPC，不跨机） | — |
| 模型请求 | 未接（属 SEC-02-06 通道矩阵） | 提示词最终装配出口 |

> 本表只登记**设计上的调用点**；除"反馈进程"外**都不是已接线**。

## 4. 静态反例记录（设计期核对，**未运行**）

| # | 场景 | 预期阻断原因 |
|---|---|---|
| ① | 未认证用户请求外发 | `not-authenticated` |
| ② | 内容超过扫描预算（`incomplete`） | `scan-incomplete` |
| ③ | 扫描器解码失败（`error`） | `scan-incomplete` |
| ④ | 内容命中私钥规则 | `scan-not-clean` |
| ⑤ | 规则集升级后复用旧授权 | `rule-version-mismatch` |
| ⑥ | 脱敏改变了内容，却复用旧 revision 的授权 | `reauthorization-required` + 新 `{revision, hash}` |
| ⑦ | 导出头哈希与实际内容不符（检查 A 导出 B） | `content-hash-mismatch` |
| ⑧ | 授权绑定设备 A，本次发往设备 B（或未给设备） | `device-unbound` |
| ⑨ | 授权目标账户 ≠ 本次目标账户 | `target-mismatch` |
| ⑩ | 授权来源项目 ≠ 本次来源项目 | `target-mismatch` |

以上是**契约设计的反例清单**；本轮**没有**为它们编写或运行测试。

## 5. 未完成（如实）

- **没有生产调用方**：上述调用点全部未接线（REMOTE-01 本身还没实现）。
- **授权绑定没有持久化存储**：`OutboundAuthorizationBinding` 只是入参；没有"授权记录 → 可核对"
  的存储与查询（REMOTE-01-02 的范围）。
- **没有设备注册表**：设备绑定只能由调用方传入，无法验证设备真实存在/已解绑。
- **没有与秘书/投递链路联动**：秘书仍是默认关闭的纯契约。
- **未验证**：十个静态反例全部**没有跑过**；也没有做"扫描结果与内容一致性"的交叉校验
  （门禁信任传入的 `scanResult`，不重新扫描）。

## 6. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
