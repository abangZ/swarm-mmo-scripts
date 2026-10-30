# 游戏接入研究

研究日期：2026-10-30。入口：https://www.swarm-mmo.com/play

## 已确认依据

页面公开资源 `https://www.swarm-mmo.com/assets/index-BI64H8hP.js`：

- 前端为 React，地图在 canvas 中绘制，不能通过普通 DOM 元素定位全部星球。
- 实际浏览器只读检查确认：canvas 的 React Fiber 祖先组件 props 包含 `conn`、字符串 `myIdentity`、`onPlayerSelect`。
- `Planet` 字段包括 `planetId: u64`、`ownerId: option(identity)`、`positionX/positionY: i32`、`probeCount: u32`、`galaxyId: u64`。ID 全程保留 bigint。
- 原页面使用 `conn.db.planet.iter()` 和 `conn.db.planet.planetId.find(id)` 读取数据。
- 原页面的行星到行星发射调用为：

```ts
conn.reducers.launchSwarm({
  sourcePlanetId,
  targetPlanetId,
  probeCount,
});
```

- 原页面有基于 `position_x`、`position_y` 的矩形范围订阅。仅遍历当前缓存不能证明找到了全局最近目标。
- 连接暴露 `isActive`、`subscriptionBuilder().onApplied().onError().subscribe()`，订阅句柄提供 `unsubscribe()` 和 `isActive()`。
- SDK 的 reducer 调用返回 Promise，并在服务器返回错误时 reject。
- 原页面还会根据最后更新时间和科技加成推算探针数；首版明确使用同步库存，不复制这一整套计算。

## 验证边界

实际游戏页面和公开前端代码已读取，组件连接入口已在浏览器中确认；真实连接中读取到 470 颗缓存星球、1 颗己方行星。另用半径 16 的真实只读范围订阅验证查询可用，最近无主行星距离为 1，满足最近性证明，随后释放订阅。单元测试使用模拟连接验证行为，不调用真实服务器发射接口。不代表已完成 Tampermonkey 扩展安装测试或真实账号发射验收。

浏览器本次直接进入 `/play` 后，游戏自动显示访客账号和星系地图；未执行真实发射。首次实际使用需在自己的浏览器安装构建文件并检查目标及数量。

## 自动扩张接入验证（v0.2.0）

真实页面只读验证了地图组件 ref 上的 `quoteSend('planet', sourceId, 'planet', targetId)`、`listOwnedBodies()`、`conn.db.swarm` 和浏览器 Web Locks。示例报价为 11 探针、15000ms 航行时间、零损耗，自动扩张派兵公式对应 13 探针；当时增长后的己方兵力为 36。

真实服务器已接受并应用以下查询：己方行星 `owner_key` 查询、己方舰队 `owner_id` 查询、用 OR 合并多个坐标网格的行星查询。验证后均释放临时订阅，没有发射。

`quoteSend` 只在当前兵力足以满足原始报价时返回 `exact`；仍必须自行检查 `exact.probes + 2` 是否足够。`listOwnedBodies` 的 `probes` 使用与游戏显示一致的时间/科技增长计算，而不是直接读取原始行星行上的 `probeCount`。

测试使用模拟服务器验证 +2、目标统一分配、总库存、航行/排队时间、出队重新报价、在途去重、确认占领、停止与扫描取消、限速、跨标签页锁和超时恢复。实际账号连续自动发射及 Tampermonkey 安装仍未进行。


## 联合占领（v0.3.0）

[官方进攻说明](https://www.swarm-mmo.com/wiki/attacking)明确说明：多支舰队分别结算，玩家防守方的 Toughness 会在每次战斗后返还部分损失。因此不能把敌方星球的多次进攻简单当作一次总兵力比较。本功能只向当前无主行星发起联合任务。

公开前端的 `quoteSend` 对单个来源不足时仍返回 `travelMs` / `lossPct`，但不返回 `exact`；其中 `outOfRange` 也可表示当前兵力不够最小发射量，而不是航线绝对不可达。合兵读取航行信息，并自行逐来源验证损耗后能实际抵达至少一个探针；100% 损耗、未知数据等航线排除。

原生批量接口为 `conn.reducers.launchSwarmBulk({ kind: 0, targetId, launches: [{ sourceId, probeCount }] })`，游戏自身框选多来源发送使用此接口。实现不修改游戏缓存，不伪造己方库存去获取报价。无主目标没有 ownerId，按无科技、无生产的驻军计算，且不利用攻击者的正向攻击加成：实际抵达总量至少为驻军 +3。

相近来源限定彼此距离不超过 8、抵达时差不超过 15 秒；它们仍是分批抵达，并非把舰队合并成一个实体。真实用户竞争、游戏后端规则或前端接口变更仍需由实际游戏结果验证。未执行真实联合发射。
