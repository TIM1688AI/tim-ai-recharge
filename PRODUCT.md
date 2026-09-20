# Tim 充值服务
<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
客户使用现有自助充值页；站长独自使用新增工作台，逐个账号充值、批量管理卡密并分析每日结果。

## Capabilities and Constraints
三个通道共用已有供应商适配器。工作台管理库存和对外发卡，入库及发卡执行 TIM 转换。原始卡密与别名必须去重。结果不明确时只查询，不自动重发。不持久化 Session 或访问令牌。工作台默认关闭，不改动客户页面设计。

## Operating Context
现有 Node HTTP 服务、Render 和 Cloudflare；新增 PostgreSQL。单管理员登录，无公开注册，不包含计费、多员工或批量账号充值。
