# RELOCATE-01-04 的 tarball 双进程证据（2026-10-18）

> **结论**：**已取得**。用 `npm pack` 产出的 tarball 在**隔离目录真实安装**，
> 进程 A 经**已安装包的公开出口**写入位置登记与运行历史，**另一个独立进程 B**
> 用已安装包的 CLI 读回：搬迁分类 `identity-confirmed`、历史可加载、执行**未**授权，
> 且项目根**未被自动创建任何条目**；历史回溯能看到工具调用与失败原因。
>
> 这份证据**推翻了**本仓此前的记录「tarball 双进程搬迁证据未取得，理由是
> 本机 `npm install` 不生成 `node_modules`」（见 `TASKCARD_BACKLOG_2026-10-17.md` §13.2）——
> 该理由**经不起复核**：`scripts/verify-sdk-consumer.mjs` 一直在做同样的隔离安装且通过。
> 本轮实测：`npm install <tarball>` **41 包 / 5 秒**，`node_modules` 正常生成。

## 1. 可复跑命令

```powershell
cd astarray
npm pack                 # prepack 会先跑完整 check；产出 astarray-0.1.0.tgz
node scripts/verify-relocate-tarball-dual-process.mjs astarray-0.1.0.tgz
```

## 2. 脚本做了什么（`scripts/verify-relocate-tarball-dual-process.mjs`）

| 步骤 | 内容 | 判据 |
| --- | --- | --- |
| 安装 | 临时目录 `npm install <tarball> --ignore-scripts`（不碰仓库、不装额外东西） | 安装成功 |
| 进程 A | `import { RunHistoryStore, ProjectLocationRegistrationStore } from "astarray"` —— **只用公开出口**，写 `project-alpha` 位置登记（`confirmedBy:"user"`，revision 2）与一份运行历史（工具调用 + 失败调用 + 过程说明） | 写后读回 `valid` |
| 进程 B（搬迁） | 独立进程跑**已安装包的 CLI**：`project status --project project-alpha --root <root> --observed-identifier project-alpha --json` | `identity-confirmed` / `isHistoryLoadable:true` / `isExecutionAllowed:false` |
| 只读纪律 | 查询后检查项目根目录 | **条目数 = 0**（不得自动新建目录） |
| 进程 B（历史） | `history list --json` / `history show --mission mission-tarball --json` / 文本模式 | 列出该 mission；含 `tool-call` + `tool-failure`；失败原因 `permission-denied` 保留；`storedEventCount = 3` |
| 不重放 | 查看后统计 `run-history/*.json` | **仍为 1**（查看不产生新写入） |
| 安全渲染 | 文本模式 stdout | **不含** ANSI/控制序列 |

## 3. 本轮实测输出（逐字）

```
added 41 packages in 5s
tarball 双进程搬迁与历史回溯验证通过: {
  "processA": {"processIdentifier": 6004, "historyReadKind": "valid"},
  "projectStatus": {
    "classification": "identity-confirmed",
    "isHistoryLoadable": true,
    "isExecutionAllowed": false,
    "requiredUserAction": "只读恢复对账"
  },
  "projectRootEntryCountAfterQuery": 0,
  "historyListMissions": ["mission-tarball"],
  "historyShow": {
    "kinds": ["tool-call", "tool-failure"],
    "storedEventCount": 3,
    "notice": "过程说明按显示设置隐藏（仍保存在本地，不会被删除）"
  },
  "runHistoryFileCountAfterViews": 1,
  "tarballPath": "…/astarray-0.1.0.tgz"
}
```

- 平台：Windows 11，Node v24.18.0，npm（隔离目录）
- tarball：`astarray-0.1.0.tgz`，**269 文件**，sha256 `587d09b36bfcb8cc455d7ec6315e115717657c576e0a25af550b3ebfeffd3c19`
- 同批隔离包三门禁（同一 tarball）：`verify-package.mjs` **exit 0**、`verify-sdk-consumer.mjs` **exit 0**、
  本脚本 **exit 0**
- 退出码：**0**

## 4. 这次证据**没有**覆盖的部分（不得据此宣称完成）

| 项 | 为什么没覆盖 |
| --- | --- |
| TUI / GUI 的搬迁入口与确认卡 | UI 属私有/未跟踪目录；确认卡交互属人工体验 |
| 真实设备/跨平台（Linux、macOS） | 只在本机 Windows 上跑过 |
| 历史回溯的**人工体验**（用户能否找到旧指令/失败调用/恢复原因） | 卡内 §7.8 明写人工验收不能由自动测试冒充 |
| 运行历史的资源测量（大规模事件下的分页/内存） | 属 `HISTORY-01-04` 的测量项，本轮未做 |
| 进程 A 的历史写入用的是**数据层 API**（`RunHistoryStore`），不是"跑一次真实 mission" | "真实 mission 写历史"已由仓库内 `history01-run-history-e2e.test.ts` 覆盖；本轮证的是**已安装包可写可读同一份** |
