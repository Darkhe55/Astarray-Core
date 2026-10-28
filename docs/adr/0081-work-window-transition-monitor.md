# ADR-0081 工作时段变化检测器与关闭时停止（接线缺口第 ④ 项）

- 状态：部分采纳（检测器已接；恢复扇出由宿主决定）
- 日期：2026-10-28
- 来源：[STATUS_UPDATE_WIRING_GAPS_2026-10-28](../reports/STATUS_UPDATE_WIRING_GAPS_2026-10-28.md) 清单第 ④ 项
- 相关：ADR-0065（工作时段恢复入口）

## 1. 背景

ADR-0065 交付了 `handleWorkWindowResume`（同一入口、区分人工/休息暂停、最多一次），
但**没有任何东西在 rest → working 时调用它** —— 恢复入口存在，**触发点不存在**。
清理时还发现：`application-runtime` 的 `shutdown()` 已存在（先 `controller.shutdown()` 再停反馈进程），
所以本项不是"补 shutdown 调用方"，而是**让检测器有自己的生命周期并挂在既有 shutdown 上**。

## 2. 契约（冻结）

1. **默认关闭**：`isWorkWindowResumeMonitorEnabled !== true` ⇒ **不排定时器**（`start()` 返回
   `not-started` 并说明原因）。
2. **首次观测只建基线**：启动瞬间状态已是 `working` 也**不触发**恢复（避免开机误恢复）。
3. **只在 rest → working 触发一次**；working → resting 只记录；同状态重复观测为 `no-change`。
4. **单飞**：上一次观测未完成时本轮跳过（避免慢读堆积）。
5. **读取失败不杀循环**：`read-failed` 计数并保持上次状态，**不把失败当成状态变化**。
6. **最小间隔 60s**（缺省 300s）：小于下限**直接抛错**，不静默改成别的值。
7. **不在检测器里恢复任务**：只调用宿主的 `onRestToWorking`；是否调用
   `handleWorkWindowResume`、恢复哪些 mission，由宿主决定（不做"偷偷派发"）。
8. **关闭即停**：`shutdown()` 第一步 `stop()`（幂等；未启动返回 `not-running`）。

## 3. 生产调用链（源码位置）

```
application-runtime.ts（创建时）
└─ createWorkWindowTransitionMonitor({isEnabled, readCurrentState, onRestToWorking})
   ├─ readCurrentState = evaluateWorkWindowState({instantIso, rules: store.readRules()}).state
   └─ start()：仅 isEnabled 时 setInterval（每 300s，下限 60s）
宿主回调
└─ options.onWorkWindowRestToWorking(observedAtIso)（缺省不传 ⇒ 只记录，不恢复）
关闭
└─ shutdown() → workWindowTransitionMonitor.stop() → controller.shutdown() → supervisor.stop()
运行时句柄
└─ runtime.workWindowTransitionMonitor（getLastState / observeNow / getReadFailureCount）
```

## 4. 未完成（如实）

- **没有默认的恢复扇出**：`onWorkWindowRestToWorking` 缺省未提供 ⇒ 检测器只记录观察结果，
  **不会真的恢复任何 mission**。要真正恢复，需要宿主遍历"因休息被暂停"的 mission 并逐个
  调用 `handleWorkWindowResume` —— 这一步**没有做**（也没有 mission 清单来源）。
- **CLI/TUI 未接**：没有命令行把检测器默认开启、也没有查看 `getLastState()` 的入口。
- **真实时钟下的行为未验证**：单飞、跨天边界、时区规则、系统时钟跳变都只是代码路径。
- **未验证**：没有跑过"首次观测不触发""rest→working 触发一次""读失败不改变状态"
  "间隔 < 60s 抛错""shutdown 停止定时器"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
