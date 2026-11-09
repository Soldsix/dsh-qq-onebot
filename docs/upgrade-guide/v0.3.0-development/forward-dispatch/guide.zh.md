---
kind: upgrade-guide
description: "通过有界 Host 解析器及明确的后端转发发送接口组合持久转发输出。"
---
# 升级合并转发投送

## 变更

OneBotTransport 新增 sendForwardNodes(scope, nodes, signal)、registerForwardDispatcher(dispatcher) 和 messageSnapshot(scope, id)。仅有一个 forward 消息段的出站请求交给已安装的 Host 解析器；未安装时返回 failed/unavailable。forward 与普通消息段混排仍明确拒绝。配置字段、持久记录、凭据和会话格式均不变。

节点发送使用后端 send_group_forward_msg 或 send_private_forward_msg 扩展，保留节点顺序、支持的媒体原始字节和发送者显示声明，投送时间由后端决定。显示身份不授予权限；引用节点要求同一目标范围内未过期的缓存消息。文件、未展开转发资源和不支持的消息段会拒绝整条发送。提交后的超时保持 uncertain，不自动重试。

## 迁移

1. 升级本包。既有 profile、原生设置和普通消息无需安装转发消费者即可继续使用；无需迁移归档或重放历史消息。
2. 提交单独的 forward 段前安装明确的持久输出解析器，只允许可信 Host 插件注册并保存清理函数。调用 sendForwardNodes 前解析完整节点、按精确目标注册原件，调用真正结束后释放临时媒体。
3. 操作去重和不确定发送的核对由持久投送消费者负责。直接调用 sendForwardNodes 每次调用尝试一次，不保证恰好一次投送。
4. 缓存引用内容使用 messageSnapshot，返回带原附件引用的独立副本，不进行全局 get_msg 查询，也不重新发布入站消息。模型可见内容仍由消费者写入会话事件。
