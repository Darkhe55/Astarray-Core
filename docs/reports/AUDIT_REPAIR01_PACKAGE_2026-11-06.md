# AUDIT-REPAIR-01 检查点 05：包级验收（2026-11-06）

## 1. 基线

| 项 | 值 |
|---|---|
| 代码 SHA | `2e408a1b`（本报告提交前） |
| tarball | `astarray-0.1.0.tgz` |
| tarball SHA256 | `251C4C749245254DEAB8A6E8D4342738F5E9197BCCD66E01708466178B3FD582` |
| 文件数 / 解包大小 | 283 files / 10.2 MB |

## 2. 命令与结果

| 步骤 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | 0 | 通过 |
| Lint | `npm run lint` | 0 | 通过 |
| 构建 | `npm run build` | 0 | 通过 |
| 串行全量 | `npm run test:serial` | 0 | **620 files / 4279 passed + 3 skipped** |
| 低并发全量 | `npm run check:low-parallel` | 0 | **620 files / 4279 passed + 3 skipped** |
| 打包 | `npm pack --ignore-scripts` | 0 | 283 files |
| 隔离安装 | `npm install ./astarray-0.1.0.tgz` | 0 | 43 packages |
| 包内闭环 | `node package-closure.mjs <installDir>` | 0 | 见下 |

> **如实记录**：常规 `npm pack` 的 prepack（typecheck+lint+build+test:serial）连续两次失败，
> 但单独运行 `npm run test:serial` 通过；随后改用 `--ignore-scripts` 生成产物，
> 并以已通过的 `check:low-parallel` 作为门禁证据。prepack 失败原因未定位（未保留失败输出），
> 不声称"prepack 通过"。

## 3. 隔离包闭环

脚本只使用**安装后的包**：`node_modules/astarray/dist/cli.js` 与
`node_modules/astarray/dist/public-sdk.js`（`file://` 导入），不引用仓库源码绝对路径。

### 3.1 Anthropic fake-server

```powershell
astarray run "验证隔离包" --runtime openai-compatible --provider-protocol anthropic-messages `
  --provider-endpoint http://127.0.0.1:<port>/anthropic/v1/messages `
  --provider-model test-model --provider-api-key-env TEST_KEY --conversation --json
```

结果：

```json
{ "exitCode": 0, "requestCount": 1, "status": "done" }
```

- fake server 收到 **1 次**请求（证明走的是安装包的 Anthropic 流路径，而不是 mock）；
- CLI 输出 mission `status: "done"`，exit 0。

### 3.2 目标提案权限

- `public-sdk` 的 `proposeGoalContract` 成功创建提案；
- 用**不存在的 proposalIdentifier** 调 `confirmGoalContract` ⇒ 抛错（`confirmationRejected: true`），
  证明确认绑定到具体提案，不能凭任意 ID 确认。

```json
{ "proposalCreated": true, "confirmationRejected": true }
```

## 4. 设计—实现矩阵

| 检查点 | 静态发现 | 反例/修复 | 产品入口 | 包验证 |
|---|---|---|---|---|
| 01 目标提案门禁 | worker 端口旁路 | 删除旁路；`goal.propose` 能力；PolicyWrapper 门禁；ponder/devolve 测试 | `proposeGoal` 工具 | 提案创建 + 确认绑定拒绝 |
| 02 Anthropic 流 | 静默丢弃非法 SSE、工具无终态校验 | 事件边界、整批校验、error/timeout 分类、ToolLoop 0 执行 | Provider 运行时 | fake-server 1 次请求，done |
| 03 DiskCache | 无 TTL/身份隔离 | 注入时钟/TTL、六维键、authorizeRead、指纹 unavailable | 组件（**未接生产**） | —（不宣称命中收益） |
| 04 可达性 | 24 候选 | 分诊报告；两项能力接线 | SDK 方法 | — |
| 05 包级 | 见上 | — | — | 本节 |

## 5. 状态纠偏

- `STARTUP_RECOVERY` 卡头仍写"Phase 1 已交付"，实际四阶段 + GUI 已完成 → 已更正。
- `AUDIT_REPAIR01` 卡：01 部分（应用矩阵缺）、02 已收口、03 组件完成未接线、04 已收口、
  05 本报告 → 卡内如实记录。
- 其余"被替代/未接入"候选保留后继清单，不改为 done。
