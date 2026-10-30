# 架构与开发约定

当前为 v0.5.0，使用 React 19、TypeScript、esbuild 和 pnpm。发布物是一个包含 React、React DOM、业务代码和样式的独立 IIFE 油猴脚本，运行于游戏页面上下文。

## 职责划分

| 目录 / 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 检查路径和重复挂载，启动面板；处理前进/后退缓存恢复 |
| `src/app/mount.tsx` | 创建 Shadow DOM / React root，隔离输入事件，统一卸载 |
| `src/app/App.tsx` | 订阅应用状态，装配各面板，处理展开/收起的焦点 |
| `src/app/controller.ts` | 持有唯一扩张引擎、设置折叠、限量日志和状态快照 |
| `src/app/settings.ts` | 旧设置迁移、表单与毫秒单位转换、校验和持久化 |
| `src/ui/` | 自动扩张、运行状态、日志、参数及异常恢复组件；只通过 props 接收数据与事件 |
| `src/game/session.ts` | 游戏连接与地图控制器发现；唯一使用游戏 React Fiber 的位置 |
| `src/game/subscriptions.ts` | 订阅确认、超时和失败清理 |
| `src/game/expansion-world.ts` | `ExpansionWorld` 的游戏实现、报价 +2、库存及舰队数据、批量发射 |
| `src/features/expansion/` | 独立引擎、规划器、合兵算法、配置及世界数据接口 |
| `src/runtime/operations.ts` | 跨实例共用的 Web Lock、限速和结果未知保护 |
| `src/shared/` | 不依赖界面或连接的共用函数 |

`app` 负责装配 UI、引擎与游戏适配器。引擎只接受 `ExpansionWorld` 工厂，不直接实例化游戏连接；测试可注入模拟世界。算法不导入 React 或访问 DOM。游戏内部接口变化时优先修改 `game` 层；增加新的自动模式时在 `features` 中实现逻辑，再由控制器和 UI 接入。

UI 中对设置和游戏数据类型的引用是 TypeScript 类型依赖；获取连接、订阅或调用 reducer 的副作用不能写进组件。无需引入全局状态库或路由框架。

## 状态与生命周期

- 每次 `mountPanel()` 创建一个 `AppController`，它持有一个 `ExpansionEngine`；React 通过 `useSyncExternalStore` 订阅稳定的、按更新替换的快照。
- 展开/收起和 Tab 切换只改变展示状态，不重建引擎。默认 Tab 为自动扩张；进攻 Tab 仅占位。挂载、切换 Tab 和展开面板不自动搜索或派兵。
- `mountPanel()` 返回幂等清理函数，`pagehide` 也会调用它：停止引擎、使未发射任务失效、卸载 React、移除监听和宿主节点。未完成的扫描由引擎收尾并释放订阅；已发送请求无法撤回。
- 浏览器从前进/后退缓存恢复页面时，入口收到 `pageshow` 的 `persisted` 标记后重新挂载面板。新控制器保持未启动状态，未知结果标记继续保留；重复恢复事件不会重复挂载。
- 组件渲染出现未捕获错误时停止控制器，避免不可见的界面继续派兵。
- 设置沿用 `swarm-helper-expansion-settings`。界面用秒，算法用毫秒；旧配置缺少 `maxSources` 时补 3，不支持的扫描间隔回落到 10 秒。其他无效配置整体使用默认值。
- 操作锁、限速记录与未知结果标记沿用原键。渲染和卸载不清除结果未知标记，用户核对后才能解锁；成功的延迟确认仍可清除自身标记。

## 运行可见性

- 引擎向 `ExpansionState` 发布结构化 `activity`（扫描、等待、排队、发送、确认、暂停、停止、异常等），界面不通过解析提示文本判断状态。
- 引擎同时提供扫描时间、下次扫描时间和己方/候选数量。候选为各来源最近 n 个未锁定目标的并集，包含当前兵力不足的来源附近目标；可执行计划仍使用原库存、航线、距离和时间约束。
- 控制器记录状态变化为带时间的日志，合并连续相同状态，最多保留 100 条，仅存在内存。发射确认与占领确认分别记录；重复定时轮询不会刷日志。
- `RunStatus` 的一秒计时器只更新显示的扫描倒计时，不触发扫描或派兵。停止/卸载时清理计时器。
- 启动成功进入执行流程时收起设置，允许在运行中只读展开。缩小面板始终展示当前状态与最新日志；进攻 Tab 内也提供正在运行的扩张状态和停止入口。

## 样式与打包

样式维护在 `src/ui/panel.css`，esbuild 使用 `text` loader 将 CSS 作为字符串导入，React 在 Shadow DOM 内渲染 `<style>`。无需单独加载 CSS 文件，也不会污染游戏样式。

`pnpm build` 先进行源码类型检查，再将生产版 React 和业务代码一起压缩；依赖的许可证注释内嵌保留。`pnpm dev` 使用 React 开发版和非压缩代码，监听保存后重新打包。两者均生成相同路径，原有本地加载器继续有效，更新后需要刷新游戏页面。

`dist/swarm-mmo-local.user.js` 的 `@require` 使用当前工程绝对路径；分享脚本时使用 `dist/swarm-mmo.user.js`。不要提交本机加载器或手动编辑生成物。

## 测试与扩展

```sh
pnpm typecheck
pnpm test
pnpm build
```

测试入口自动发现 `tests/*.test.ts` / `tests/*.test.tsx`，编译到临时目录，由 Node test runner 在独立文件进程中执行，结束后清理产物。

- `game.test.ts`：连接、报价与 reducer 参数。
- `planner.test.ts`：分配优化、合兵损耗、距离、库存和截止时间。
- `operations.test.ts` / `expansion.test.ts`：互斥、限速、未知结果、执行重校验、停止和在途追踪。
- `ui.test.tsx`：JSDOM + React `act`，验证 Tab 键盘导航、设置自动折叠、状态/日志与缩小同步、重复启动及卸载清理。
- `controller.test.ts` / `page-lifecycle.test.ts`：自动扩张卸载时取消排队、停止/重启的互斥，以及实际入口打包后的缓存恢复挂载。
- `tests/helpers/`：DOM 环境和游戏 fixtures。UI 测试结束必须卸载 React，不能只删除宿主节点。

界面测试使用模拟游戏数据，不代表真实账号已完成发射，也不验证浏览器布局。涉及真实游戏接口的变化，应另做只读兼容检查，明确记录验证边界。
