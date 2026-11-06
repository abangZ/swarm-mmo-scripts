# Swarm MMO 助手

用于 [Swarm MMO](https://www.swarm-mmo.com/play) 的油猴脚本，帮助你自动扩张、集结进攻和查看在途舰队。

## 主要功能

- **自动扩张**：占领无主行星、恒星与陨石，支持固定区域、协同派兵和后方补给。无主行星驻军为 4 时，零航损派 5 个探针。附近无主行星只差一两个探针、等兵后仍能更早占领时，来源会留兵等候。争夺无主恒星时优先选择所需普通探针较少的目标。兵力足够时，最多可由三个不同中转星同时募集，各自在补给到账后出击。
- **安稳发育**：专注占领陨石，可按设置升级稳定后方。
- **进攻模式**：选择战区和敌人，自动直攻或集结兵力，排除自己与盟友。
- **在途查询**：打开行星菜单后，点击雷达按钮查看自己、盟友与敌方的在途舰队。

自动扩张与进攻可同时运行、分别停止；面板提供运行状态和日志。

## 安装

1. 在浏览器中安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点击[安装 Swarm MMO 助手](https://raw.githubusercontent.com/abangZ/swarm-mmo-scripts/main/dist/swarm-mmo.user.js)，在 Tampermonkey 中确认安装。若浏览器只显示代码，可将完整内容粘贴到 Tampermonkey 新建脚本中并保存。
3. 打开或刷新游戏页面，左下角出现「Swarm MMO 助手」即安装成功。

后续可通过 Tampermonkey 检查更新。

## 使用

1. 选择「自动扩张」或「进攻模式」，设置运行区域与留守兵力。领地较多时建议按固定区域运行。
2. 进攻前点击「加载区域与敌人」，确认战区内同时包含己方来源与目标，再选择敌人。
3. 检查设置后手动启动；运行中可收起面板，查看状态和最新日志，需要结束时点击对应模式的停止或「全部停止」。

收起面板不会停止任务，刷新页面后需重新手动启动。已启动的自动扩张支持断线恢复。安稳发育只约束扩张模式，如需和平挂机，请同时停止进攻模式。

## 反馈与开发

遇到问题请在 [Issues](https://github.com/abangZ/swarm-mmo-scripts/issues) 中附上脚本版本、相关设置和日志。

作者：[abangZ](https://github.com/abangZ)。构建与本地开发方式见[开发文档](docs/architecture.md)。

## 开源协议

Copyright (C) 2026 abangZ。本项目采用 [GNU GPL v3.0](LICENSE)（`GPL-3.0-only`）。分发本项目或修改版时，须按 GPL 提供对应源码并保留许可声明；仅私人修改自用不要求公开源码。软件不提供担保，完整条款以 LICENSE 为准。

打包的第三方依赖保留各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
