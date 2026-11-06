---
kind: upgrade-guide
description: "0.2 候选新增所有者控制器，并要求原生配置与 Remote 服务。"
---

# 将 0.1 候选升级为原生控制

## 变更

0.1 bundle 只有 qq-onebot-transport；0.2 同时挂载 qq-onebot-control，并导出 ./control 与 ./client。新增 ConfigEditor、Typert 协议 peer；Web 客户端使用原生网关、语言、渲染器和插件管理。原通道字段名不变，不修改聊天或记忆持久格式。

## 迁移

1. 备份 profile 包清单和配置，再通过 DSH 插件管理将 dsh-qq-onebot 更新到 0.2 候选。dsh-im-kit 保持 0.2.0，声明的 DSH peer 保持 0.2.2-rc.1。
2. 保留 qq-onebot-transport 条目 ID；如果 profile 改过名称，将 qq-onebot-control.config.targetEntryId 指向该准确 ID。控制器不会任意选择同名模块条目。
3. 提供 DSH 凭据和 ConfigEditor 服务。标准 Web profile 提供 Remote 服务与原生页面；只使用通道且明确不提供这些服务的 profile 可以停用控制器条目。
4. 通过 dsh 重启 profile，打开“插件 → dsh-qq-onebot”，核对已保存设置中的目标账号。停用通道后配置页仍存在；连接、账号核验与在线证据分别显示。
5. 重连前检查草稿；版本过期时需刷新或放弃修改。重连不重试历史消息，隔离安装和 Web 验证见[本包说明](../../../../README.zh.md#verify-this-package)。
