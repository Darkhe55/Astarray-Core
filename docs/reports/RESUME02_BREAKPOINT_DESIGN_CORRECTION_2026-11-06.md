# RESUME-02 断点续接语义修正（2026-11-06，用户裁决）

> 本文件记录用户对 `RESUME02_EXPERIMENTAL_SMART_CONTINUATION.md` 的语义修正。
> 原卡文件当时有用户未提交修改，本文件不覆盖原卡；后续实现以本文件为准，待用户允许后再回写卡。

## 修正

1. **不是设置开关**：不存在“断点续接实验开关/默认关闭/认证用户开启”。
2. **断点驱动**：只有任务真实中断产生权威断点记录时，才在**发生中断的会话与该位置**显示状态卡。
3. **按钮常驻**：用户不点击，状态卡一直保留（刷新/重启重建不得丢失或重复追加）；点击才发起恢复。
4. **不点击不恢复**：不自动续跑、不因联网恢复、不因模型说“继续”恢复；普通“继续”仍是普通消息。
5. **终止形态（用户选 A）**：恢复成功/任务完成/取消后，卡片转为终态（“已恢复/已完成”），按钮消失，卡片留作历史，不从会话移除。

## 对现有卡的影响

- 公开 `RESUME-02` §01（`isCheckpointContinuationEnabled` 实验配置）**作废**；
  改为断点记录生命周期：`open → requested → resumed / cancelled / superseded`；
- 私有 `UI-RESUME-02` §01（设置→实验功能）**作废**；改为会话内断点卡生成/去重/常驻；
- 恢复仍保留：显式用户操作、对账、租约/fencing、幂等、版本校验、不把 resumed 当任务完成。

## 需要的公共数据面（后继实现）

- 按会话查询断点：`queryBreakpoints(conversationIdentifier)`，返回任务短名、原因、最后检查点、下一步、
  `breakpointIdentifier`、`expectedRevision`、状态；
- 显式续接：`requestContinuation({ breakpointIdentifier, expectedRevision, requestIdentifier })`，
  服务端幂等、状态复检、对账后进入既有恢复门禁；
- 断点与任务/会话稳定绑定，重启可重建；查看不触发恢复。
