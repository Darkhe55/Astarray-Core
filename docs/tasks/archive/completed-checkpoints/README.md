# 已完成的历史检查点

归档日期：2026-10-22。本目录只收录已交付的独立检查点，不以父卡部分完成代替整卡验收。归档原文按字节保留，历史失败、局限与后继待办不删除；旧路径保留导航。

| 检查点 | 已完成范围 | 不包含 |
|---|---|---|
| [B6R-00](B6R00_BASELINE.md) | 历史基线采集、差距记录与返修状态纠偏 | 后续返修、当前覆盖率及跨平台验收 |
| [T07D-00](T07D00_PROVIDER_AUDIT.md) | 历史 Provider 产品路径审计、支持矩阵与声明纠偏 | 后续协议接线及全部 Provider 支持 |

核查依据：原文交付段、父卡检查点定义及 T07D 父卡历史完成说明；本轮 `provider-support-record.test.ts` 7/7 通过，仅为相关规则回归，不替代历史全量测试。

归档前后 SHA256 一致：

- B6R00_BASELINE.md：`D9DA33EFEC18AC8F12F1152C8B403F834469AA9AEA129F61884BDD03FBF5D9F9`
- T07D00_PROVIDER_AUDIT.md：`3433FE1616C8C945D59ACE543B8A8FAB33382BFACD2DA0FDBAAFC5AB5738EB4D`

## 本批未迁移

- B6R-11：虽标已完成，仍记载若干模块未达到原 95% 门槛、豁免说明与平台移交；不在本轮擅自批准这些例外。
- MERGE/NODECTX：本地范围完成，但卡中保留人工/平台限制，分仓后的 UI 范围也需单独核验。
- RELOCATE、HISTORY、COMM、CLIENT、EXP、LESSON、OBS、SMART、TOOLKIT、GUI/E2E 等：存在未闭合项、待决策或仅局部完成，原位保留。
- 现有 accepted 14 张卡：沿用已有位置，不将其限定范围收录自动升级为“全部要求彻底完成”。

本批只整理上述两份历史检查点，不删除日志、备份、代码、UI 副本或运行状态；不修改并行工作文件。原文件额外副本保存在 `.tmp/task-archive-backups/`。
