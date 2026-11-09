---
description: "为 DSH profile 增加一个经过认证的 OneBot 11 账号和有范围的消息投递。"
kind: "package-bundle"
---
# dsh-qq-onebot

[English](README.md) | 中文

## 摘要

本预览版提供一个选定的 OneBot 11 账号和原生 Web 配置页，保留提及、引用、分享卡片和媒体引用，检查账号健康并区分回执；不确定时不重试。所有者页面区分草稿、已保存版本和实际连接证据。本包不增加模型、人设或自动回复；需要已有的 OneBot 服务。

## 目录

- [使用本包](#use-this-package)
- [验证本包](#verify-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

候选目标是 DSH 0.2.2-rc.1 与 Cordis 4.1，其公开 Host 要求 Node >=24.9.0；Node 22 测试仅作兼容性观测。这是 bundle 层，不是应用程序入口。profile 提供凭据与 ConfigEditor；原生 Web profile 还提供 Typert 注册表、网关、远程访问和插件管理。OneBot 11 端点需已存在；本包不启动或登录 QQ。

Bundle 插入默认停用的 qq-onebot-transport 和独立的 qq-onebot-control 条目。启用时必须指定准确账号及允许群。私聊需开启 allowPrivate；privateUsers 留空允许所有人，填写后限制为名单内用户。accessTokenEnv 是 DSH 凭据引用，不是密钥原文。每次新握手会重新解析该引用。

正向模式使用经过认证的通用 ws 连接（仅回环）或远程 wss；反向模式只监听回环并接受一条经过认证的通用连接。不支持分开的 API/Event 连接、HTTP 通道和 OneBot 12。

在已有的 DSH profile 中安装发行包，共用消息库会自动取得：

```sh
dsh plugin --profile MY_PROFILE add https://github.com/Soldsix/dsh-qq-onebot/releases/download/v0.4.0-development/dsh-qq-onebot-0.4.0-development.tgz
```

通过 dsh plugin --profile PROFILE add ARCHIVE 安装后，在原生 Web 应用打开“插件 → dsh-qq-onebot”，可编辑连接、访问与高级限制。保存使用 ConfigEditor 的校验与事务编辑，保留未改动的表达式，拒绝过期版本；启用失败由宿主编辑器回滚。重连只使用已保存配置，不重发消息。

控制器在通道停用或重载后继续存在；即使通用 Remote 策略放行，也只允许可信宿主所有者操作。它只检查凭据是否配置，不读取密钥值。状态面板分别显示条目激活、连接、账号核验及有效在线证据；保存成功不能证明 QQ 已在线。

宿主服务 ctx.im 发布已接纳消息，并提供可用性和发送操作。ctx.qqOnebot 提供仅宿主使用的来源查询、原始消息快照和限定目标的出站字节引用。独立消费者决定是否回复，并负责持久请求标识。

### 范围绑定的转发读取

Host 读者可调用 ctx.qqOnebot.readForward(scope, rootMessageId, resourceId, signal)，参数必须来自已接纳且仍保留的外层消息。只有外层消息或已读取子节点引入的资源才能请求，子节点返回的群号不能改变范围。结果为 resolved 或带稳定原因的 failed；转发昵称与账号标为 claimedSender，不代表真实认证，不触发新入站消息、指令或管理员授权。

读取保留节点顺序、普通引用 ID、内联节点及原始响应；仅含引用 ID 的节点保留 referenceMessageId，不进行全局 get_msg 查询。同一外层范围及资源的并行读取共享一次请求，取消一个等待者不影响其他人，最后一个等待者离开后停止请求。缓存结果为独立副本，断线取消旧代请求，旧响应不能覆盖新代结果，不自动重试。

maxForwardNodes、maxForwardResources、maxForwardDepth 和 maxForwardCalls 可在原生高级设置调整；总缓存还受 maxReferenceBytes 限制。超限拒绝完整响应，不静默截断、不留部分媒体授权。成功读取刷新外层引用的保留时间，缓存命中不续期。转发媒体通过原外层范围的 mediaSource 获取来源；这不代表已下载原件、识图或完成多轮网络展开。

解析覆盖 [OneBot 标准节点](https://github.com/botuniverse/onebot-11/blob/master/api/public.md#get_forward_msg-获取合并转发消息)与 [NapCat 返回节点](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/action/go-cqhttp/GetForwardMsg.ts)，存在矛盾的非空内容字段明确拒绝。原件下载、模型可见渲染与跨资源递归策略由独立消费者完成；见[读取升级指南](docs/upgrade-guide/v0.2.1/forward-reads/guide.zh.md)。

### 明确的合并转发输出

可信 Host 适配器可调用 sendForwardNodes(scope, nodes, signal)，使用[后端转发扩展](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/action/go-cqhttp/SendForwardMsg.ts)。发送前检查当前在线与禁言证据、节点/深度/字节容量及媒体的精确目标范围；支持的字节原样发送，仅引用节点要求同范围内未过期的已接纳消息，不支持的内容拒绝整条发送。投送时间由后端决定，发送者显示字段仍只是声明。

registerForwardDispatcher 为单独的出站 forward 段安装一个 Host 解析器；清理会取消并等待发送结束，之后才能替换。消费者负责完整内容保留、不透明引用解析和操作去重；未安装解析器返回 unavailable，普通段与 forward 混排仍拒绝。messageSnapshot 读取带原附件引用的独立规范化缓存，不重新解析、不全局查询 get_msg。见[投送升级指南](docs/upgrade-guide/v0.3.0-development/forward-dispatch/guide.zh.md)。

<a id="verify-this-package"></a>
## 验证本包

在本仓库运行 npm run check。集成测试前先构建并打包候选。每项测试用受支持的 dsh CLI 启动全新隔离 profile 和合成回环端点，不打开用户浏览器，也不连接 QQ。本包会自动安装固定版本的 dsh-im-kit 0.2.1 GitHub 公开归档，不需要预装共用库。集成测试默认下载该包作为安装证据，也可用 --im-kit-archive 明确提供测试输入；不读取相邻源码仓库或生产 profile。

```sh
npm pack --pack-destination artifacts
npm run test:dsh
npm run test:control
npm run test:web
npm run test:consumer -- --im-kit-archive PATH_TO_VERIFIED_LIBRARY_TGZ
```

Web 测试需安装 Playwright 对应的 Chromium headless shell；将 PLAYWRIGHT_BROWSERS_PATH 指向测试专用目录，先运行 node node_modules/playwright/cli.js install chromium --only-shell，再执行 test:web。测试使用全新浏览器资料，结果保存在 .test-artifacts；本源码仓库包含全部三种测试入口和探针。全新消费者 harness 对已校验 SHA256 的 im-kit 归档设置明确的 npm 根级 override，让传递依赖使用相同字节而不再次下载；仅改变私有测试根，不改公开包清单。

QA 依赖覆盖是经过测试的开发输入，不代表使用者的宿主已更新。插件自身的 overrides 不会传递到消费 profile，宿主预构建资源也可能内嵌其他版本。宿主依赖更新需另行应用和验证；npm audit 结果只覆盖记录的包依赖树。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[Bundle 补丁](cordis.patch.yml)分开通道与所有者控制；[入口](src/index.ts)负责消息服务；[控制器](src/control.ts)只编辑指定条目；[原生页面](src/client/page.tsx)刷新状态时保留草稿；[通道](src/transport.ts)核验身份、保留使用中引用并共享成员查询；[连接层](src/socket.ts)关联回执、限制资源并等待完整关闭。

</details>

<a id="model-experience"></a>
## 模型体验

间接影响。本包不定义模型工具、不改提示词，也不发模型请求。聊天、归档和媒体消费者需要通过自己的 DSH 会话事件记录模型可见材料；JSON/XML 分享内容是不可信数据，不是指令或授权。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- 回执只证明服务端受理；手机 QQ 显示和播放需另行授权验证。
- 入站去重与来源保留是有上限的内存缓存，不是持久归档，也不保证端到端恰好一次。
- 每个 profile 支持一个选定账号，第二提供方不能静默替换现有消息服务。
- 禁言判断使用可取得的成员时间戳和已观测通知；协议缺少证据时，不能证明所有预先存在的全群禁言状态。
- 文件输出仍不支持。完整合并转发组装、持久去重与原件下载需要明确的消费者适配器，仅传输投送接口不实现这些功能。
- 不包含协议客户端、凭据、私人人设、用户归档或图库。
- 原生 Web 验收使用隔离合成端点；真实 QQ、模型 API 和桌面客户端需要另行授权验证。

## 延伸阅读

- [配置字段](src/config.ts)
- [测试](test/)

## 开发备注

预览版；所声明的消息通道和原生控制功能，与 QQ 客户端实际送达分别验证。
