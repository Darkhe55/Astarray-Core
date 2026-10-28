# 拆分归档与剩余事项

2026-10-25，用户授权拆分归档。完成检查点独立归档，父卡保留原始契约、历史与未闭合工作，不因部分归档改成整体 done。旧状态与新报告冲突时先对账，不自动抹掉任一记录。

| 父卡 | 本次归档 | 仍在原卡跟踪 |
|---|---|---|
| [HISTORY-01](HISTORY01_LOCAL_RUN_HISTORY_AND_RESUME_VIEW_TASK_CARD.md) | [01 审计、02 最小持久化](archive/completed-checkpoints/HISTORY01_01_02_COMPLETED.md) | 03 各入口交付与旧缺口对账；04 人工体验；资源测量边界及分段存储决定。已交付 GUI/包级证据继续有效，不重新标成未实现 |
| [COMM-01](COMM01_ADDRESSABLE_UPPER_LAYER_AND_SINGLE_PARENT_TASK_CARD.md) | [01 审计](archive/completed-checkpoints/COMM01_01_COMPLETED.md) | 02/03 最新交付证据回填与整卡核验；扩展收件箱/转达语义的范围决定。汇总已称完成的部分须与卡内旧状态对齐，不重新宣称代码不存在 |

本批不拆分或迁移尚有范围争议的其他卡，不删除日志、备份和运行状态，不修改代码。父卡仍是未归档工作的唯一执行入口，本表仅导航，不另建竞争任务状态。

修改前完整副本位于 `.tmp/split-archive-backups/`。迁出的三条检查点记录在归档中逐字保留；原表改为链接，原有其他历史段落不删。
