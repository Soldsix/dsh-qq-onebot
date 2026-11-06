---
description: "为 DSH profile 增加一个经过认证的 OneBot 11 账号和有范围的消息投递。"
kind: "package-bundle"
---
# dsh-qq-onebot

[English](README.md) | 中文

## 摘要

本开发候选包提供一个选定的 OneBot 11 账号，保留真实提及、引用、分享卡片和媒体引用，检查账号健康，并对发送回执分类；结果不确定时不重试。它不增加模型、人设或自动回复。隔离 DSH 安装已通过，图形设置与状态页面仍未完成，尚未公开发布。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

候选目标是 DSH 0.2.2-rc.1、Cordis 4.1、Node 22.19 或 24。这是 bundle 层，不是应用程序入口。标准 profile 需提供 DSH 凭据服务，OneBot 11 协议端需已存在；本包不启动或登录 QQ。

插入的条目为 qq-onebot-transport，默认停用。启用时必须指定准确账号及允许群；私聊需开启 allowPrivate，privateUsers 可进一步限制。accessTokenEnv 是 DSH 凭据引用，不是密钥原文。每次新握手会重新解析这个引用。

正向模式使用经过认证的通用 ws 连接（仅回环）或远程 wss；反向模式只监听回环并接受一条经过认证的通用连接。不支持分开的 API/Event 连接、HTTP 通道和 OneBot 12。

隔离安装使用 profile 的 cordis.patch.yml 配置并重载条目。本候选尚未实现自动生成的实时设置表单和图形状态面板；不能只因导出了 schema 就认为设置页面可用。

宿主服务 ctx.im 发布已接纳消息，并提供可用性和发送操作。ctx.qqOnebot 提供仅宿主使用的来源查询、原始消息快照和限定目标的出站字节引用。独立消费者决定是否回复，并负责持久请求标识。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[Bundle 补丁](cordis.patch.yml)插入默认停用条目；[入口](src/index.ts)负责服务注册与清理；[通道](src/transport.ts)区分 QQ 身份核验与连接状态，保留处理中媒体引用，共享成员查询，并提供脱敏诊断；[连接层](src/socket.ts)关联 RPC 回执、限制资源并等待完整关闭。

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
- 文件和合并转发输出需后续独立能力适配；本包明确拒绝，不伪装成文字或图片。
- 不包含协议客户端、凭据、私人人设、用户归档或图库。
- 本候选尚未完成真实 QQ、模型 API、UI 和 Linux 验收。

## 延伸阅读

- [配置字段](src/config.ts)
- [测试](test/)

## 开发备注

开发候选；生产实例未改动。
