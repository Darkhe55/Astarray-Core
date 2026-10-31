# GOAL-02 真实 mission 验收（第一次实跑，2026-10-31）

> 授权：用户明确允许真实模型/工具调用，并要求"专门创建一个 test 文件夹用于测试"。
> 本次只做**基础管线实跑**；目标模式（K1→K10）的实跑因缺少入口而**未完成**（见 §5）。

## 1. 环境与准备

| 项 | 值 |
|---|---|
| 工作区 | `C:\Users\MerchRev\Documents\astarray\test\workspace`（本次新建，独立于两个仓库） |
| 状态目录 | `C:\Users\MerchRev\Documents\astarray\test\state`（`ASTARRAY_DATA_DIR=…\test` ⇒ state=…\test\state） |
| Provider | `unisound`（`https://maas-api.unisound.com`），模型 `u2`，凭据引用 `prov-unisound-1` |
| 端点 | 必须给**完整路径** `https://maas-api.unisound.com/v1/chat/completions`（只给 `/v1` ⇒ 404 `path error: /v1`） |
| 权限 | 非交互运行需在 stdin 提供 `allow-once`（按**精确参数**授权；参数变化会再次询问） |

状态目录的凭据与设置从仓库 `.astarray` **复制**而来（只在本机测试目录，未入库）。

## 2. 实跑记录（成功）

命令（在 `test\workspace` 下）：

```
node ..\..\astarray\dist\cli.js run "创建文件 hello.md，内容为：第一行 # Hello，第二行空行，第三行 - 由真实 mission 创建。" \
  --mode assist --runtime openai-compatible \
  --provider-endpoint https://maas-api.unisound.com/v1/chat/completions \
  --provider-model u2 --provider-credential-reference prov-unisound-1 \
  --provider-request-timeout-seconds 120 --json --timeout-seconds 300
```

结果（节选，真实输出）：

```
astarray: 已按精确参数 allow-once 授权 createProjectFile（作用域授权: granted），并下发 unblock（任务 T-001）。
{
  "missionId": "mission-f9a43378",
  "mode": "assist",
  "status": "done",
  "permissionAsk": "allowed-once",
  "prompt": "创建文件 hello.md，内容为：第一行 # Hello，第二行空行，第三行 - 由真实 mission 创建。"
}
```

**产物**：`test/workspace/hello.md`（38 字节）：

```
# Hello

- 由真实 mission 创建。
```

**完成收据**：`test/state/completion-receipts/mission-f9a43378/T-001.json`

```json
{
  "schemaVersion": 1,
  "receipt": {
    "missionIdentifier": "mission-f9a43378",
    "taskIdentifier": "T-001",
    "hasVerifiedCompletionControlEvent": true,
    "toolCallCount": 1,
    "artifactPaths": ["hello.md"],
    "recordedAtIso": "2026-10-31T10:26:37.552Z"
  }
}
```

**任务链**：`test/state/missions/mission-f9a43378/task-chain.json`（另有 `.bak`）。

## 3. 本次证明了什么

- Provider 真实调用可用（OpenAI-compatible 协议、真实模型 `u2`）；
- 工具权限询问 → 精确参数授权 → `unblock` → 工具执行 的完整闭环可用；
- 工具确实写盘（`hello.md` 内容正确）；
- **完成收据**落盘，且 `hasVerifiedCompletionControlEvent: true`、`artifactPaths` 正确。

## 4. 失败/弯路（如实记录）

1. 首次用 `--provider-endpoint https://maas-api.unisound.com/v1` ⇒ **404 `path error: /v1`**；补全 `/chat/completions` 后正常。
2. 未提供 stdin 裁决 ⇒ mission 进入 `blocked`（`requires-human-resubmission`），**未擅自放行**。
3. 一次 provider 请求超时（默认 30s）导致 `This operation was aborted`；把 `--provider-request-timeout-seconds` 调到 120 后成功。

## 5. 目标模式（K1→K10）实跑：**被入口缺失阻断**

目标模式的内核 API 都在 `ApplicationRuntime`，但：

| 障碍 | 证据 |
|---|---|
| **公开 SDK 没有目标模式方法** | `public-sdk.ts` 中无 `proposeGoalContract`/`confirmGoalContract`/`bindMissionToGoal`/`deactivateGoal` 等（只在 `ApplicationRuntime`） |
| **CLI 没有目标模式写命令** | `cli.tsx` 的 `goal-mode` 只有 `status` / `verdicts`（只读） |
| **`submitTask` 不能"带着目标创建 mission"** | `submitTask` 参数只有 `sessionId/taskIdentifier/prompt/idempotencyKey/projectIdentifier/workspaceRootPath/targetAgentInstanceIdentifier` |
| **绑定只能事后做** | `bindMissionToGoal` 需要已存在的 `missionIdentifier`；而门禁在 **mission 启动时**评估 ⇒ 事后绑定对本次派发生效不了 |

结论：**"用户设立目标 → 整组 agent 围绕目标推进"这条链路，目前无法从公开入口真实跑通**；
本次只能验证基础管线（§2），不能宣称 GOAL-02 已端到端验收。

## 6. 下一步（需要产品决定）

1. **最小闭环**：`submitTask`（或新命令）接受 `goalIdentifier`，在创建 mission 时完成绑定 + 状态初始化；
2. **最小入口**：公开 SDK 暴露目标模式方法（UI 也要用）；CLI 加 `goal-mode propose/confirm/bind`（confirm 必须显式用户动作）；
3. **开关可注入**：`isGoalModeEnforcementEnabled` / `isGoalCompletionRequired` / `missionToolCallBudget` 目前只能构造期传入，需要暴露给宿主/CLI；
4. 以上就绪后，再做一次**目标驱动**的真实 mission 验收（本次的 `test/` 目录可直接复用）。

## 7. 验证状态

- 基础管线真实实跑：**已验证**（mission done + 产物 + 收据）；
- GOAL-02 端到端：**未验证**（入口缺失，见 §5）；
- 本次**无代码改动**（只新建 `test/` 测试目录与本文档）。
