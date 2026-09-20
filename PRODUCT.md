# Tim 充值服务
<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
客户使用自助充值页。站长工作台已迁移到独立项目，不属于本仓库。

## Capabilities and Constraints
保留三个充值通道、TIM 品牌卡密以及既有合作方接口。不持久化 Session 或访问令牌，不连接独立工作台数据库，不共享库存和订单。

## Operating Context
现有 Node HTTP 服务、Render 和 Cloudflare。个人库存、管理员登录和统计由独立工作台负责。
