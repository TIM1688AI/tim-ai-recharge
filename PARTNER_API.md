# Tim 合作方 API（邀请制第一版）

默认关闭。仅增加后端入口，不改变现有网页接口；未实现余额、计费、自动发卡、Webhook 或管理网页。上线前先确认供应商允许转供 API、并发额度和同一卡密原子兑换保障。

## 部署前提

只支持单 Node 进程、单实例，使用本地持久化磁盘。当前使用零依赖文件记录而非数据库；不支持多实例/多主机或网络文件系统一致性保证。生产主机应使用 TLS，若由 CDN/反向代理终止 TLS，必须限制直接访问源站。不要将合作方 Key 配置在网页 JavaScript 中。

环境变量：

| 变量 | 用途 |
| --- | --- |
| `PARTNER_API_ENABLED` | `1` 才启用，默认关闭 |
| `PARTNER_CONFIG_FILE` | 服务器外部 JSON 配置文件的绝对路径，建议放在仓库和静态目录之外 |
| `PARTNER_DATA_DIR` | 持久化请求记录目录的绝对路径，建议放在仓库之外，限制为服务账号可写 |
| `PARTNER_HASH_SECRET` | 至少 32 字符的高熵随机秘密，仅存在服务器秘密配置中；稳定保管，不能随意轮换 |

两种通道继续使用现有供应商环境变量。没有配置这些变量，不影响网页自助充值。请求正文、Authorization、Session、完整卡密不得被 CDN、主机日志和错误监控采集。

这是合作方入口独立的持久化保障，不是之前已取消的 `ADVANCED_LOCK_DIR/SECRET`；网页仍保留简易内存保护。

## 邀请和开通

1. 管理员在受信任的终端执行 `node partner-tools.js key`，得到一次生成的 `api_key` 与 `key_hash`。只把原始 Key 私下交给合作方，配置中只保存哈希。工具不会替你保存或发送。
2. 为合作方设置 `channels` 通道权限和每分钟请求额度。合作方通过认证后可以验证、查询和提交自己持有的有效卡密，无需逐张预登记。
3. 修改配置通过同目录临时文件原子替换，避免请求读到半份 JSON。配置每次调用读取，`enabled:false` 立即禁止该 Key 的后续调用；已经发出的充值不能撤回。

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

除库存外，每次指定 `channel: "regular" | "advanced"`。卡密使用 TIM / TIM5X / TIM20X 或 16 位年度码；常规卡密保留原格式。供应商 JZ 转换仅在服务器进行。

### POST /cards/verify

```json
{"channel":"advanced","card":"TIM-ABCDEFGHIJK"}
```

返回 `{"ok":true,"valid":true,"product":"ChatGPT Plus"}`。`valid:false` 表示本次验证未通过，不能据此推断具体无效原因。

### POST /accounts/check

```json
{"channel":"advanced","card":"TIM-ABCDEFGHIJK","session":"完整Session JSON字符串"}
```

返回 `ok`、`email`、`plan`、`can_redeem`。必须显示账号、充值产品和已有会员可能替换订阅的风险，再取得客户确认。常规仅允许 Free，进阶须供应商明确允许且非 Team。不要将 Session 会话过期时间作为会员有效期。

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

### POST /recharges/query

```json
{"channel":"advanced","card":"TIM-ABCDEFGHIJK"}
```

返回 `{"ok":true,"results":[{"card":"TIM-ABCDEFGHIJK","status":"success","product":"ChatGPT Plus"}]}`。这是读取供应商当前结果的入口。未知/缺失任务保守显示 `unconfirmed`，不直接推断不存在。进阶供应商明确 not_found 才输出 `not_found`。

### POST /recharges/batch-query

```json
{"channel":"advanced","cards":["TIM-ABCDEFGHIJK","TIM5X-ABCDEFGHIJK"]}
```

最多 50 个，规范化后去重，保留顺序。任一卡密格式错误则整批拒绝，不查询其他卡密。逐项检查 `status`，可能包含 `unused / success / processing / failed / not_found / unconfirmed`。

### GET /stock

当前仅提供进阶库存等级，调用方必须拥有 advanced 通道权限。返回 `stock.plus / plus_year / pro5x / pro20x`，值为 `none / low / medium / high / unavailable`；不暴露数量，不保证或预留库存。

## 错误与重复请求

| HTTP | code | 处理 |
| --- | --- | --- |
| 401 | invalid_api_key | 检查密钥或停用状态 |
| 403 | channel_not_allowed | 联系管理员检查通道权限 |
| 400 | invalid_card / invalid_session / confirmation_required / invalid_card_count | 修正输入 |
| 409 | request_id_conflict | 同一请求号的参数变化，不允许直接重试充值 |
| 409 | card_submission_exists | 该卡已通过合作方入口发起过操作，请先查询 |
| 429 | rate_limited / busy | 按 Retry-After 等待；充值结果不明确时优先查询 |
| 503 | configuration_required / service_unavailable | 停止充值重试并查询已有请求，联系管理员 |

请求意图在供应商调用之前写入、fsync。相同请求号重复调用返回 `replayed:true` 和已存结果，崩溃/无结果记录返回待确认；不会重新发送充值。更换请求号也不能绕过持久化卡密占用记录。

保存的结果是原始提交回执，不会自动随查询更新。要了解最新状态请调用查询接口。失败、资格拒绝、超时均不自动解除卡密占用，管理员必须与供应商核实后受控处理，不要整目录清空。此设计牺牲部分自动重试便利性，以减少不确定情况下的重复操作。

记录仅包含请求摘要、创建时间、原请求号及脱敏状态/产品；无完整卡密、Session、API Key 或账号邮箱。记录应备份、限制磁盘容量并监控；存储失败时拒绝继续提交。第一版无自动过期和后台清理任务。

## 边界与上线验收

- 不承诺整个供应商系统的 exactly-once；其他网站/供应商入口不受本站保护。
- 合作方 API 与消费者自助网页均采用持卡使用模式。API Key 用于识别合作方、限制通道和调用额度，不代表某张卡密只属于某个合作方；如需独占批次或代理商账务隔离，必须另行增加卡密归属或订单系统。
- 配置文件、数据目录不能存到公开仓库；目前静态文件白名单不提供它们或服务器脚本下载。不要新增宽泛静态目录服务。
- 先用 `npm test` 模拟鉴权、归属、并发、重启后重放、冲突、超时和停用，再用供应商授权的测试卡验收。真实 API Key/Session 不进入测试文件。
- 上线前核对磁盘持久性、单实例、供应商转供许可、TLS、日志脱敏及代理超时。默认不自动开启或部署。
