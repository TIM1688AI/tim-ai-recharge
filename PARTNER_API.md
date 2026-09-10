# Tim 合作方 API（邀请制第一版）

默认关闭。仅增加后端入口，不改变现有网页接口；未实现余额、计费、自动发卡、Webhook 或管理网页。上线前先确认供应商允许转供 API、并发额度和同一卡密原子兑换保障。

## 部署前提

防重复记录使用 Upstash Redis REST 持久化，不依赖 Render 本地文件或持久化磁盘。当前限流与并发计数仍位于单 Node 进程内；免费 Render 休眠唤醒后这些临时计数会重置，但持久化防重复记录不会丢失。生产主机应使用 TLS，若由 CDN/反向代理终止 TLS，必须限制直接访问源站。不要将合作方 Key 配置在网页 JavaScript 中。

环境变量：

| 变量 | 用途 |
| --- | --- |
| `PARTNER_API_ENABLED` | `1` 才启用，默认关闭 |
| `PARTNER_CONFIG_FILE` | 服务器外部 JSON 配置文件的绝对路径，建议使用 Render Secret File `/etc/secrets/partner-config.json` |
| `PARTNER_HASH_SECRET` | 至少 32 字符的高熵随机秘密，仅存在服务器秘密配置中；稳定保管，不能随意轮换 |
| `UPSTASH_REDIS_REST_URL` | Upstash 数据库的 HTTPS REST URL，只配置在服务端 |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST Token，只配置在服务端，不得写入仓库或日志 |

两种通道继续使用现有供应商环境变量。没有配置这些变量，不影响网页自助充值。请求正文、Authorization、Session、完整卡密不得被 CDN、主机日志和错误监控采集。

这是合作方入口独立的持久化保障，不是之前已取消的 `ADVANCED_LOCK_DIR/SECRET`；网页仍保留简易内存保护。Redis 不可用或写入结果不明确时，合作方充值接口会拒绝继续调用供应商。

## 邀请和开通

1. 管理员在受信任的终端执行 `node partner-tools.js key`，得到一次生成的 `api_key` 与 `key_hash`。只把原始 Key 私下交给合作方，配置中只保存哈希。工具不会替你保存或发送。
2. 为合作方设置 `channels` 通道权限和每分钟请求额度。合作方通过认证后可以验证、查询和提交自己持有的有效卡密，无需逐张预登记。
3. 在 Render Secret File 中更新完整 JSON 配置并重新部署。配置每次调用读取，`enabled:false` 会禁止该 Key 的后续调用；已经发出的充值不能撤回。

配置结构（全部为占位值，不可直接用于生产）：

```json
{
  "partners": [
    {
      "id": "partner_a",
      "enabled": true,
      "channels": ["regular", "advanced"],
      "key_hashes": ["替换为64位SHA256密钥哈希"],
      "requests_per_minute": 60
    }
  ]
}
```

支持多个 `key_hashes` 以便轮换密钥：先增加新哈希，合作方切换后删除旧哈希。合作方 Key 可轮换，但 `PARTNER_HASH_SECRET` 变化会使既有请求去重和卡密提交占用记录失效，不可当作解锁手段。

## 调用约定

Base URL：`https://你的站点/partner-api/v1`

请求头：`Authorization: Bearer <合作方APIKey>`，POST 还需 `Content-Type: application/json`。不接受 URL 查询参数、不开放跨域 CORS；要求后端调用。返回 `Cache-Control: no-store`。默认每合作方每分钟 60 次，可配置 1–120；全局每分钟 600 次、并发最多 20，另外按源连接 IP 每分钟 180 次（经过 CDN 时可能为共享出口限制）。限流是单进程内存计数，重启后重置。持有有效 Key 的合作方可以操作其持有的任意格式合规卡密，平台不会逐张预登记卡密归属。

除 `GET /stock` 外，每次指定 `channel: "regular" | "advanced"`。卡密使用 TIM / TIM5X / TIM20X 或 16 位年度码；常规卡密保留原格式。供应商 JZ 转换仅在服务器进行。

## 功能与通道

| 路径 | 常规 | 进阶 | 说明 |
| --- | --- | --- | --- |
| `POST /service/status` | 支持 | 支持 | 检查通道是否可用 |
| `POST /announcements/current` | 支持 | 返回无公告 | 获取当前公告 |
| `POST /queue/status` | 队列数量 | 库存等级 | 统一状态入口 |
| `POST /cards/verify` | 支持 | 支持 | 验证卡密与产品 |
| `POST /subscriptions/check` | 支持 | 支持 | 独立查询订阅资格 |
| `POST /recharges` | 支持 | 支持 | 提交充值 |
| `POST /tasks/query` | 支持 | 支持 | 查询单个任务 |
| `POST /tasks/batch-query` | 最多 100 张 | 最多 50 张 | 批量查询任务 |
| `POST /cards/refresh` | 支持 | 不支持 | 更换卡密 |
| `POST /tasks/cancel` | 支持 | 不支持 | 取消排队任务 |

网页使用的实时队列 SSE 不对合作方开放。合作方应调用 `/queue/status` 展示概览，并使用 `/tasks/query` 轮询具体任务。

### POST /service/status

```json
{"channel":"advanced"}
```

返回 `{"ok":true,"available":true,"channel":"advanced"}`。只有 `available:true` 才显示通道可用。

### POST /announcements/current

```json
{"channel":"regular"}
```

返回 `ok / enabled / title / message`。`enabled` 不等于 `true` 时隐藏公告。

### POST /queue/status

常规返回 `{"ok":true,"kind":"queue","pending_count":2,"updated_at":"ISO时间"}`。进阶返回 `{"ok":true,"kind":"stock","stock":{"plus":"high","plus_year":"none","pro5x":"medium","pro20x":"low"}}`。库存等级为 `none / low / medium / high / unavailable`，不代表预留。

### POST /cards/verify

```json
{"channel":"advanced","card":"TIM-ABCDEFGHIJK"}
```

返回 `{"ok":true,"valid":true,"product":"ChatGPT Plus"}`。`valid:false` 表示本次验证未通过，不能据此推断具体无效原因。

### POST /subscriptions/check

```json
{"channel":"advanced","session":"完整Session JSON字符串"}
```

返回 `ok`、`email`、`plan`、`has_active_subscription`、`is_team`、`expires_at`、`can_redeem`。必须显示账号、当前套餐和已有会员可能替换订阅的风险，再取得客户确认。常规仅允许 Free，进阶须供应商明确允许且非 Team。`expires_at` 仅在上游返回准确值时存在，不能用 Session 会话过期时间替代。兼容路径 `POST /accounts/check` 仍可用。

### POST /recharges

```json
{"channel":"advanced","card":"TIM-ABCDEFGHIJK","session":"完整Session JSON字符串","request_id":"order_20260909_001","confirmed":true}
```

`confirmed:true` 是合作方声明客户已确认账号和替换风险，不是系统替代客户确认。`request_id` 必须是 8–80 位字母、数字、下划线或连字符，按合作方隔离。同一请求号必须保持通道、卡密、Session 内容一致；JSON 空格/属性顺序差异可兼容，重新获取的 Session 通常不同，会返回冲突。

返回示例：

```json
{"ok":true,"request_id":"order_20260909_001","status":"unconfirmed","product":null}
```

状态为 `success / processing / failed / rejected / unconfirmed`。`ok:true` 仅表示 API 正常返回，不代表充值成功。处理中/未确认一般返回 HTTP 202，其他结果为 200。客户端超时设置建议大于 150 秒，但仍需考虑代理限制。

### POST /tasks/query

```json
{"channel":"advanced","card":"TIM-ABCDEFGHIJK"}
```

返回 `{"ok":true,"results":[{"card":"TIM-ABCDEFGHIJK","status":"success","product":"ChatGPT Plus"}]}`。这是读取供应商当前结果的入口。未知/缺失任务保守显示 `unconfirmed`，不直接推断不存在。进阶供应商明确 not_found 才输出 `not_found`。兼容路径 `POST /recharges/query` 仍可用。

### POST /tasks/batch-query

```json
{"channel":"advanced","cards":["TIM-ABCDEFGHIJK","TIM5X-ABCDEFGHIJK"]}
```

常规最多 100 个，进阶最多 50 个；规范化后去重并保留顺序。任一卡密格式错误则整批拒绝，不查询其他卡密。逐项检查 `status`，可能包含 `unused / success / processing / failed / not_found / unconfirmed`。兼容路径 `POST /recharges/batch-query` 仍可用。

### POST /cards/refresh

仅常规通道。请求：

```json
{"channel":"regular","card":"原常规卡密","request_id":"refresh_20260910_001","confirmed":true}
```

成功返回 `status:"success"` 与 `new_card`。旧卡会立即失效，新卡只应向对应客户展示一次。相同 `request_id` 重试会安全重放原结果；新卡在 Redis 中加密保存，响应和日志不得泄露。

### POST /tasks/cancel

仅常规通道，并且只应在卡密验证返回 `pending:true` 与 `cancellable:true` 时使用。请求：

```json
{"channel":"regular","card":"原常规卡密","request_id":"cancel_20260910_001","confirmed":true}
```

只有响应中的 `cancelled:true` 才能显示成功。成功后重新验证卡密。相同 `request_id` 重试会安全重放原结果。

### GET /stock

当前仅提供进阶库存等级，调用方必须拥有 advanced 通道权限。返回 `stock.plus / plus_year / pro5x / pro20x`，值为 `none / low / medium / high / unavailable`；不暴露数量，不保证或预留库存。

这是兼容快捷接口。新接入优先使用 `POST /queue/status`，便于统一处理两个通道。

## 错误与重复请求

| HTTP | code | 处理 |
| --- | --- | --- |
| 401 | invalid_api_key | 检查密钥或停用状态 |
| 403 | channel_not_allowed | 联系管理员检查通道权限 |
| 403 | operation_not_supported | 当前通道不支持该操作，隐藏对应入口 |
| 400 | invalid_card / invalid_session / confirmation_required / invalid_card_count | 修正输入 |
| 409 | request_id_conflict | 同一请求号的参数变化，不允许直接重试充值 |
| 409 | card_submission_exists | 该卡已通过合作方入口发起过操作，请先查询 |
| 429 | rate_limited / busy | 按 Retry-After 等待；充值结果不明确时优先查询 |
| 503 | configuration_required / service_unavailable | 停止充值重试并查询已有请求，联系管理员 |
| 503 | storage_unavailable | 防重复存储不可用；不得重新提交充值，稍后先查询 |

请求意图在供应商调用之前通过 Redis `SET ... NX` 原子写入。相同请求号重复调用返回 `replayed:true` 和已存结果，崩溃/无结果记录返回待确认；不会重新发送充值。更换请求号也不能绕过持久化卡密占用记录。

保存的结果是原始提交回执，不会自动随查询更新。要了解最新状态请调用查询接口。失败、资格拒绝、超时均不自动解除卡密占用，管理员必须与供应商核实后受控处理，不要直接删除对应 Redis 键。此设计牺牲部分自动重试便利性，以减少不确定情况下的重复操作。

记录仅包含合作方 ID、请求摘要、创建时间、原请求号及脱敏状态/产品；无完整卡密、Session、API Key 或账号邮箱。应监控 Upstash 命令额度、容量与错误率；存储失败时拒绝继续提交。第一版不为防重复记录设置自动过期时间。

## 边界与上线验收

- 不承诺整个供应商系统的 exactly-once；其他网站/供应商入口不受本站保护。
- 合作方 API 与消费者自助网页均采用持卡使用模式。API Key 用于识别合作方、限制通道和调用额度，不代表某张卡密只属于某个合作方；如需独占批次或代理商账务隔离，必须另行增加卡密归属或订单系统。
- 配置文件与 Upstash 凭据不能存到公开仓库；目前静态文件白名单不提供配置或服务器脚本下载。不要新增宽泛静态目录服务。
- 先用 `npm test` 模拟鉴权、归属、并发、重启后重放、冲突、超时和停用，再用供应商授权的测试卡验收。真实 API Key/Session 不进入测试文件。
- 上线前核对 Upstash 原子写入及重启后记录保留、供应商转供许可、TLS、日志脱敏及代理超时。默认不自动开启或部署。
