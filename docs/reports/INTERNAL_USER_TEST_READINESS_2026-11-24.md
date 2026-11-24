# 内部用户测试就绪度与完整使用说明（2026-11-24）

> 口径：编码证据截止 `d55627ad`。全量门禁 **954 files（952 passed / 2 skipped），6061 tests（6054 passed / 7 skipped），EXIT=0**；
> `lint` 0；隐私检查通过。覆盖率最近复测（2026-11-24 收尾）为全局分支 **82.01%**（20200/24629），语句 89.06%，函数 89.29%，行 89.45%。
>
> 本文件回答三件事：**还缺多少编码**、**哪些功能可以正式使用**、**怎么用**。
> 不把"测试通过"写成"产品验收通过"；`implemented-unverified` 一律按"已实现、未人工验收"处理。

## 0. 一句话结论

- **可以做"受限内部用户测试"**：命令行（CLI）+ mock 运行时 + 只读/受控写入面已经可用，且有全量测试与隐私门禁支撑。
- **还不能做"完整内部用户测试"**：覆盖率门禁未达（82.01% < 85%，约差 **735 条分支**）、真沙箱后端缺失（B3/B5）、
  跨平台与远程投递无证据（B6/B7）、公开构建的 `gui` 明确 fail-closed、多张卡片仍缺人工验收（B8）。

## 1. 距离"完整内部用户测试"还差多少编码

| 缺口 | 具体内容 | 编码量估计 | 是否受外部条件阻塞 |
|---|---|---|---|
| **B9 覆盖率到 85%** | 约 **735 条**分支用例（`main-controller`、`commands.ts`、`public-sdk`、`application-runtime` 等） | **8–12 人日**（纯测试，不改产品代码） | 否 |
| **B3 / EXEC-01-03 真沙箱** | Rust helper + MSVC 工具链、AppContainer/提权验收；当前"探测未命中 ⇒ 拒绝" | **2–4 人日**编码 + 1 次提权验收 | **是**（本机无 Rust/MSVC、需提权） |
| **RESUME-02 收尾** | 恢复包真实内容读取/扫描接线、远程投递适配、观测计数、SDK 便捷方法 | **3–5 人日** | 远程部分依赖平台（B7） |
| **B8 人工验收** | E2E-01、GUI-01-R-04b、B6R-04b 等走查签收 | **0 编码**，1–2 天人工 | **是**（需真人/设备） |
| **B6 跨平台** | Linux/macOS 证据 | **0 编码** | **是**（需对应设备/CI） |
| **B7 REMOTE-01** | 平台投递、签名/回执适配 | **3–5 人日**（取决于平台 API） | **是**（平台租户/回执 API） |
| **GUI 体验项** | 公开仓库不含 UI 源码 | 不在本仓库范围 | **是**（私有仓库/产品决定） |

**汇总**：纯编码缺口约 **13–26 人日**；其中**不依赖外部条件、可独立完成**的约 **11–17 人日**
（B9 + RESUME-02 + B3 编码部分）。剩余为平台/设备/人工验收，不是继续写代码能闭合的。

## 2. 现在可以"正式使用"的功能（有可执行证据）

| 能力 | 入口 | 证据 |
|---|---|---|
| 运行任务（mock 端到端） | `run "<prompt>" --runtime mock` | 全量测试 + `verify:e2e01` fixture |
| 查询 / 恢复 / 取消任务 | `status`、`resume <id>`、`cancel <id>` | 本轮新增 6 条命令分支测试 |
| 恢复中心 | `recover list/show/resume/abandon` | 只恢复安全节点，需裁决项逐项 blocked |
| 环境诊断 | `doctor`、`doctor --provider <id>` | 只读检查（Node 版本/目录可写/反馈入口） |
| 运行历史 | `history list/show` | 只读、分页、不重放工具 |
| 任务台账 | `task-ledger status`（含 `--list-bindings`、`--deferred-insertions`） | 本轮新增 7 条只读分支测试 |
| 目标模式 | `goal-mode status/verdicts`、`propose/confirm --yes` | 本轮新增 10 条（只读 + 写入校验） |
| 断点续接（产品路径） | `continuation breakpoints`、`continuation resume` | 断点驱动 + 幂等键 + 版本复核 + 恢复门禁 |
| 权限组 / 会话 | `profile ...`、`session ...` | 本轮新增 13 条命令分支测试 |
| 用量 / 性能 / 观测 / 上下文指标 | `usage`、`perf`、`obs`、`context metrics` | 只读，本地数据，不上传 |
| MCP 桥（最小工具面） | `mcp serve` | stdio e2e 已通过 |
| Node SDK | `AstarrayApplicationFacade` | `verify:sdk-consumer` |
| 隐私 / 打包验证 | `verify:privacy`、`verify:entry-runtime-selection`、`verify:tarball-install` | 全部 exit 0 |

## 3. 明确"不可正式使用"或"仅实验"的功能

| 功能 | 现状 | 原因 |
|---|---|---|
| `gui` 子命令 | **fail-closed**，非 0 退出 | 公开构建不含 Web GUI（UI 源码不在本仓库） |
| 真沙箱受控执行 | 不可用 | B3/B5：无 Rust/MSVC 工具链与提权；未命中后端即拒绝 |
| 远程通道投递 | 未验收 | REMOTE-01：缺平台租户/签名/回执 |
| `continuation status/request` | **实验性**（默认关闭） | 用户裁决的产品路径是断点驱动（`breakpoints/resume`）；实验层已改名 `CheckpointContinuation*` 并标注非产品路径 |
| 覆盖率门禁 | 未达标（82.01%） | B9，见 §1 |
| 目标模式"强制"能力 | 实验能力 | 需显式 `--goal-enforce`，缺省只观察 |
| 依赖人工验收的卡片 | `implemented-unverified` | 缺真人走查（B8） |

## 4. 完整使用说明

以下命令均以**源码构建产物**为准（`node dist/cli.js`）。PowerShell 环境示例。

### 4.1 环境与构建

```powershell
node --version            # 需 >= 20
npm ci                    # 安装依赖（需网络与安装授权）
npm run check             # 隐私 + 类型 + lint + 构建 + 全量测试
node dist/cli.js --help   # 确认命令面
```

### 4.2 首次初始化与自检

```powershell
node dist/cli.js doctor --json          # Node 版本 / 状态目录可写 / 反馈入口存在
node dist/cli.js config init            # 初始化配置（如提示已存在则不覆盖）
node dist/cli.js config install-enabled false   # Assist 安装开关（默认关闭；开启不等于授权）
```

### 4.3 运行任务

假运行（离线、无模型，用于验证编排与产物）：

```powershell
node dist/cli.js run "验证本地任务流程" --mode assist --runtime mock --json
```

真实 Provider（需网络/模型/费用授权；**不要把密钥写进命令或提示词**）：

```powershell
# 1) 登记受保护凭据引用（凭据本身不落盘、不回显）
node dist/cli.js config provider credential-set --help
# 2) 登记 Provider
node dist/cli.js config provider register --help
# 3) 运行
node dist/cli.js run "一个明确的小任务" --mode assist --runtime openai-compatible `
  --provider-endpoint "<完整请求 URL>" --provider-model "<model-id>" `
  --provider-credential-reference "<reference-id>" --timeout-seconds 120
```

限制（务必阅读）：Provider 目录登记与运行解析**仍有接线限制**，不能认为只登记名称就会自动选中；
各 Provider/模型的支持范围以对应验收证据为准。

### 4.4 状态 / 恢复 / 取消

```powershell
node dist/cli.js status --json                 # 列出 mission（含损坏标记/租约）
node dist/cli.js status <mission-id> --json    # 单 mission 的 summary 与任务链
node dist/cli.js resume <mission-id>           # 续接（等终态）
node dist/cli.js cancel <mission-id>           # 取消（安全点收敛）
node dist/cli.js recover list                  # 磁盘恢复中心（只读）
node dist/cli.js recover show <mission-id>
node dist/cli.js recover resume <mission-id>   # 只恢复安全节点；需裁决项逐项 blocked
node dist/cli.js recover abandon <mission-id>  # 只关闭调度，保留可审计存档
```

### 4.5 诊断与历史

```powershell
node dist/cli.js doctor --json
node dist/cli.js doctor --provider <provider-id> --json
node dist/cli.js history list --json
node dist/cli.js history show <mission-id> --json
node dist/cli.js doctor errors --json          # 脱敏诊断摘要；非法 --since/--until/--page-size ⇒ exit 2
node dist/cli.js obs perf --json               # 性能样本（只读，本地）
node dist/cli.js usage overview --json         # 用量（本地账目估算，不冒充官方余额）
```

### 4.6 目标模式（实验能力，必须人工确认）

```powershell
node dist/cli.js goal-mode status --json
node dist/cli.js goal-mode status --goal <goal-id> --json
node dist/cli.js goal-mode verdicts --json
node dist/cli.js goal-mode propose --draft <draft.json> --source-request <ref> --json
node dist/cli.js goal-mode confirm <proposal-id> --goal <goal-id> --owner <user> --yes
```

纪律：`propose` 只生成提案、不落契约；`confirm` **必须显式 `--yes`**（模型/脚本不得代替用户确认）。

### 4.7 断点续接（产品路径）

```powershell
node dist/cli.js continuation breakpoints --conversation <conversation-id> --json
node dist/cli.js continuation resume --breakpoint <bp-id> --mission <mission-id> `
  --revision <n> --request <幂等键> --json
```

- 只接受**严格命令形态**，普通"继续"不会触发；
- 幂等键重放复用结果，版本过期要求重新点击；
- `resumed` 只表示"恢复已派发"，**不代表任务完成**。

### 4.8 权限组与会话（认证设置控制面）

```powershell
node dist/cli.js profile list --json
node dist/cli.js profile create --display-name "我的组" --source assist
node dist/cli.js profile switch --reference custom:<id>
node dist/cli.js profile show --reference assist --json
node dist/cli.js session elevation-list --session <id> --json
node dist/cli.js session elevate --session <id> --capability readFile --decision allow
node dist/cli.js session revoke-elevation --session <id> --elevation <id>
node dist/cli.js session shutdown --session <id> --json
```

### 4.9 任务台账（只读优先）

```powershell
node dist/cli.js task-ledger status --json
node dist/cli.js task-ledger status --list-bindings --json
node dist/cli.js task-ledger status --deferred-insertions --json
node dist/cli.js task-ledger status --mission <id> --task <task-id> --json   # 单任务派发预检
```

写回与绑定必须显式给 `--sequence/--owner`（或已有索引），否则 `index-missing`（exit 2），**不猜映射**。

### 4.10 MCP 桥（最小工具面）

```powershell
node dist/cli.js mcp serve      # stdio；stdout 仅 MCP 消息
```

### 4.11 Node SDK

```js
import { AstarrayApplicationFacade } from "astarray";

const app = await AstarrayApplicationFacade.create({
  stateDirectory: ".astarray",
  mode: "assist",
  runtime: "mock",
  useFeedbackProcess: false,
  authenticatedUserId: "user-1",
});
try {
  const missionId = await app.submitTask({ sessionId: "s-1", prompt: "验证任务" });
  console.log(await app.queryMission(missionId));
} finally {
  await app.shutdown();
}
```

### 4.12 门禁与验证脚本（内部测试必跑）

```powershell
npm test
npm run lint
node scripts/check-public-privacy.mjs
node scripts/verify-entry-runtime-selection.mjs
node scripts/verify-tarball-isolation-install.mjs
node scripts/verify-exec01-03-preconditions.mjs   # --strict 未就绪 exit 2
```

## 5. 内部用户测试走查脚本（约 30 分钟）

| # | 命令 | 期望 |
|---|---|---|
| 1 | `npm run check` | EXIT=0；隐私 `privacy-ok` |
| 2 | `doctor --json` | 四项检查全部 true（或如实给出 false） |
| 3 | `run "验证本地任务流程" --mode assist --runtime mock --json` | 返回 missionId，终态 done |
| 4 | `status <mission-id> --json` | summary.status=done，任务链可见 |
| 5 | `resume <mission-id>` | `already-complete`（不重跑） |
| 6 | `history show <mission-id> --json` | 分页事件可见，无正文泄漏 |
| 7 | `recover list` | 该 mission 可见，标记可信检查点 |
| 8 | `goal-mode status --json` | 只读汇总，不创建契约 |
| 9 | `continuation breakpoints --conversation <id>` | 空会话明确"没有断点记录" |
| 10 | `profile list --json` / `profile switch` | 三个内置组可见，切换后 `*` 标记 |
| 11 | `task-ledger status --list-bindings --json` | 空索引 `no-bindings` |
| 12 | `gui` | **非 0 退出**，明确提示不含 Web GUI |
| 13 | `verify:exec01-03-preconditions --strict` | 本机 `blocked`（如实，不是缺陷） |

**通过标准**：1–12 全部符合期望，且无隐私输出、无伪造成功。
**不通过标准**：出现"命令成功但状态未变""resume 后声称完成""未授权仍读取"等任一情况。

## 6. 建议的下一步（按收益排序）

1. **B9 覆盖率**：继续按大文件分批补测（`main-controller` / `commands.ts` / `public-sdk`），8–12 人日可到 85%；
2. **RESUME-02 收尾**：恢复包真实内容/扫描 + 远程投递适配 + 观测，3–5 人日；
3. **B3/B5 真沙箱**：需先获得 Rust/MSVC 安装与一次提权授权，2–4 人日；
4. **B8 人工验收**：按 §5 走查，1–2 天；
5. **B6/B7**：设备/平台侧条件，不是编码问题。

> 本文不构成发布承诺。任何"完成/可用"的升级都必须以对应卡片状态与验收证据为准。
