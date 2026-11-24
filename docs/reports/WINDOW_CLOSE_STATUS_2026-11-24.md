# 窗口收尾盘点（2026-11-24）

> 口径：本窗口（第 82–116 轮）在用户既有裁决下推进；**不把"测试通过"写成"产品验收通过"**。
> 全量门禁基线：`935 files（933 passed / 2 skipped），5956 tests（5949 passed / 7 skipped）`，
> `lint` 0，隐私检查 `privacy-ok`；覆盖率门禁按预期未达标（见 B9）。

## 1. 已完成（有可执行证据）

| 卡片 / 分项 | 状态 | 证据锚点 |
|---|---|---|
| RELEASE-01-01 MCP 授权到释放 | **主体完成** | `mcp-egress-authorization.ts` / `-store.ts`；12+7+4 条反例；真实 stdio 单进程 e2e（`mcp-egress-authorization-stdio-e2e`）；双客户端夹具（`mcp-egress-multi-client`）+ 双子进程夹具（`mcp-egress-dual-subprocess`） |
| RELEASE-01-02 Provider 默认阻断 | **完成** | `DEFAULT_PROVIDER_EGRESS_SCAN_MODE="block"`；`resolveProviderEgressScanMode` 冲突回落；两协议零请求计数 8 条（`provider-egress-default-block-count`）；ADR-0080 修订节 |
| RELEASE-01-04 公开包复核 | **完成** | `verify:entry-runtime-selection` 18/18、`verify:tarball-isolation-install` exit 0（tarball sha256 `70b6ebf6…`） |
| F1 重投语义 | **关闭** | `execution-attempt-redelivery`（4 条） |
| F2 ALIGN-02 端到端 | **关闭** | `align02-planning-end-to-end`（规划→依赖派发→done） |
| F3 并发抖动 | **关闭** | `file-lock-transient-errors`（4 条）；此后多轮全量门禁无抖动 |
| B10 `entrypoint` 死守卫 | **部分收口** | 死代码删除（局部常量捕获）；剩余故障注入类分支记"维持现状+理由" |
| RESUME-02 检查点 01–03 | **implemented-unverified** | `continuation-request`（12 条）/ `continuation-receipt-store`（7 条）/ `continuation-controller`（7 条） |
| RESUME-02 检查点 04 | **implemented-unverified** | `continuation-context-pack`（8 条，纯装配；真实内容读取/扫描未接） |
| RESUME-02 检查点 05（CLI） | **部分** | `continuation status`（3 条）+ `continuation request`（6 条）；SDK/远程通道未做 |
| B9 覆盖率 | **增量** | 80.98% → **81.33%**；约 +60 条纯测用例；距 85% 约 940 条分支 |

## 2. 明确阻塞（本机无法闭合）

| 项 | 阻塞条件 | 需要谁 |
|---|---|---|
| RELEASE-01-03（B3） | 无 Rust/MSVC 工具链；AppContainer 需提权；`verify:exec01-03-preconditions` 本机 `readyForAcceptance=false` | 用户授权安装工具链 + 提权 |
| B5–B8 | 沙箱后端、Linux/macOS 证据、REMOTE-01 平台投递、人工验收 | 平台/设备/人工 |
| REMOTE-01 | 平台测试租户、签名向量、回执 API | 平台方 |

## 3. 待用户裁决

1. **B9 阈值**：继续专题投入（估 8–12 人日、600–700 条用例）到 85%，还是接受 81.33% 并调整阈值？
2. **B10 剩余分支**：为 4–5 条故障路径做故障注入重构，还是维持"防御代码未覆盖"的现状？
3. **RESUME-02 下一步**：是否继续做 dispatch 接线（接 `resumeRecoveredMission`）与 SDK 方法？该步会触及真实恢复门禁。

## 4. 本窗口未推进、仍是卡片原状态的项

`HISTORY-01`（TUI 视图）、`SMART-01`（窗口/响应期限）、`EXP-01`（工作流发现）、`LESSON-01`、
`CLIENT-01`、`TOOLKIT-01`、`GUI-01-R`（04b 人工体验）、`OBS-01`（默认开启决策）等：
均沿用卡片既有状态；本窗口**没有**声称它们完成。

## 5. 复查入口

```bash
npm test
npm run lint
node scripts/check-public-privacy.mjs
node scripts/verify-entry-runtime-selection.mjs
node scripts/verify-tarball-isolation-install.mjs
node scripts/verify-exec01-03-preconditions.mjs   # --strict 未就绪 exit 2
```

## 6. 窗口最终门禁（第 120 轮，2026-11-24）

- `npm test`：**937 files（935 passed / 2 skipped），5973 tests（5966 passed / 7 skipped），EXIT=0**；
- `npm run lint`：0；隐私检查：`privacy-ok`；
- 覆盖率（2026-11-24 复测）：全局分支 **81.33%**（阈值 85% 未达，按 B9 处理）；
- 本窗口测试净增：5790 → 5966（+176 条），新增 24 个测试文件（含 e2e/夹具）。

### 本轮后仍需你裁决（不变）

1. **B9**：专题投入至 85%（8–12 人日）或接受 81.33% 并调整阈值；
2. **B10**：剩余故障路径是否做故障注入重构；
3. **RESUME-02**：是否继续做 dispatch 接线（接 `resumeRecoveredMission`）与 SDK 方法。

### 需要外部条件（非代码可解）

- RELEASE-01-03（B3）：Rust/MSVC 工具链 + 一次提权；
- B5–B8 / REMOTE-01：平台租户、Linux/macOS 设备、人工验收。
