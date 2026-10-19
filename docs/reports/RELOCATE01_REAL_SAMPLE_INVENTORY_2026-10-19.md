# RELOCATE 真实样例盘点（2026-10-19 R69）

> 用户 2026-10-19 授权：**用本仓库自己的 `.astarray` 作为 RELOCATE 批量解析的真实样例**。
> 本报告是**只读盘点**结果。**不做任何写入**，不修改 `.astarray` 内容。

## 1. 盘点范围与方法

```powershell
Get-ChildItem .astarray -Recurse -File | Measure-Object            # 783 个文件
Get-ChildItem .astarray -Directory                                 # 11 个目录
Get-ChildItem .astarray/project-location                           # 空（不存在）
```

## 2. 实际内容（实测）

| 目录 | 文件数 | 与 RELOCATE 批量解析相关？ |
|---|---|---|
| `missions/` | 506 | 记录只有 `schemaVersion/missionId/mode/prompt/createdAtIso/status` —— **没有**结构化资源引用 |
| `agent-memory/` | 196 | 个体记忆，**不是**路径引用 |
| `recovery-checkpoints/` | 63 | 检查点，非位置映射 |
| `usage/`、`providers/`、`settings/` 等 | 共 7 | 无关 |
| **`project-location/`** | **不存在** | **必需**：位置登记（`oldRootPath`/`newRootPath`/`fromLocationRevision`） |
| **`run-history/`** | **不存在** | **必需**：历史结构化引用（待解析的路径） |

抽查 40 个 mission JSON：仅 **2 个**含 `rootPath`/`resourcePath`/`projectIdentifier` 之类字段，
且这些字段不是 `StructuredResourceReference` 结构（缺 `resourceKind`/`ownerDevice`/`capturedLocationRevision`）。

## 3. 结论（如实）

**这份真实样例不足以支撑"真实历史库上的批量解析"证据**，原因是**缺数据**而非缺代码：

1. 没有 `project-location/` 位置登记 ⇒ 无法构造 `ProjectLocationMapping`；
2. 没有 `run-history/` 结构化引用 ⇒ 没有"待解析的历史路径"；
3. mission 记录里没有可用的结构化资源引用字段。

因此 RELOCATE-01-03 的"真实批量解析"**仍然未验证**。**脱敏样例证据（R33）仍是唯一证据**，
不得据本报告宣称"真实历史库已验证"。

## 4. 若要让这项变成可验证，样例至少需要

```text
<state>/
  project-location/<project>.json      # {"schemaVersion":1,"projectIdentifier":…,"deviceIdentifier":…,
                                       #  "rootPath":…,"previousRootPath":…,"locationRevision":N,
                                       #  "confirmedBy":"user","confirmedAtIso":…}
                                       # 或旧格式（无 schemaVersion），用于验证 legacy 分支
  run-history/<mission>.jsonl          # 每条含 {"kind":"…","payload":{…绝对路径…}}
```

可选：`missions/`（用于核对"完成后不重放"）。

## 5. 我可以用它做的（如果你需要）

- 用这份 `.astarray` 做**无关位置的**真实数据演练（如 `obs perf/diag` 查询、`history list`）——
  这些已有脱敏/实例化测试覆盖，价值有限；
- 若你日后再提供一份**含 project-location + run-history** 的目录（哪怕脱敏过），
  我可以按 R33 的方式跑真实批量解析并出证据。

## 6. 后续澄清（2026-10-19 R71，用户）

用户明确：`project-location/` 与 `run-history/` 的**实物当前无法提供** —— 因为**项目还不能完整运行**，
所以任何生成内容都**不可能来自真实操作的工作目录或历史**。

因此本项不是"等用户提供文件"，而是**产品能力阻塞**：只有当产品可端到端运行、
真实生成这两类数据后，才能做"真实历史库批量解析"验证。**在此之前脱敏样例是唯一证据。**
