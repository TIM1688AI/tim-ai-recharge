# Tim AI 充值站

## 2026-09-08 进阶协议更新（优先于下方旧版说明）

进阶通道现在由 `advanced.js` 独立对接 `https://jzplus.org/api/verify-key`、`check-session`、`redeem`、`query-key`、`query-keys`、`stock`，不再使用 `/api/v1`。常规通道保持原协议。`ADVANCED_API_BASE_URL` 填供应商根域名，路径部分不会用于进阶端点拼接。

TIM / TIM5X / TIM20X 前缀仅在服务端转换成 JZ / JZ5X / JZ20X，后缀固定 11 位字母数字。年度卡暂按 16 位字母数字原样发送，产品名称以验证返回为准。批量最多 50 个，单卡结果查询也是 POST，不在 URL 中携带卡密。

### 简化提交保护（无需额外配置）

不再读取 `ADVANCED_LOCK_DIR` 或 `ADVANCED_LOCK_SECRET`，无需持久化磁盘和独立密钥。之前配置过的这两个变量可移除；程序不会读取或自动删除旧锁文件。

服务端在充值前再次检查资格，`can_redeem` 必须为 true、`is_team` 必须为 false。使用转换后卡密的 SHA-256 摘要作为内存标记，不在标记中保存明文卡密、Session 或邮箱。同一卡密请求执行中禁止重复发送；成功后冷却 60 秒，结果不确定或超时后冷却 5 分钟。冷却到期仅允许用户主动发起新的操作，不会自动充值，也不代表供应商已确认可以重试。内存表最多 10000 项，过期项在后续提交时清理。

本方案适用于单 Node 进程、单实例。服务重启会清空标记，多进程和多实例之间不共享标记；不提供持久化或跨实例幂等保证。供应商仍须保证同一卡密并发兑换的原子性。重启后或冷却到期后，仍应先查询不确定的结果，不要盲目重试。

充值超时为 120 秒，浏览器为 130 秒。部署代理超时也需核对；即使代理提前断开，服务端不因浏览器断开主动取消充值。超时只转查询，不自动重发。查询的 `used` 不代表成功，`result_status: pending` 优先；查询错误不能解释为卡密不存在。

进阶库存为本地凭证库存参考，不用于禁用充值；不再显示队列空闲。不调用供应商旧公告、换码或取消接口。Session 不写入浏览器存储，提交后清空输入及不必要应用引用；不能保证浏览器立即回收内存。部署平台、访问日志及错误监控也应禁用请求体采集。

验收运行 `npm test`；目前模拟测试不能代替供应商测试卡与真实部署环境验收。没有执行提交、推送或部署。

基于 `cdk-recharge-system` 公开 API 的零依赖 Node.js 充值站，包含：

- CDK 校验与充值任务提交
- 常规充值与进阶充值双通道选择，任务记录与队列状态彼此隔离
- 提交前查询 ChatGPT 当前订阅状态
- 已有会员风险提示与充值账号二次确认
- 卡密换码、唯一新码展示与一键复制
- 排队任务取消并恢复卡密可用状态
- 页面底部提供任务查询、订阅查询、换码和取消任务快捷入口
- 任务编号、处理中、人工处理、完成和失败状态跟踪
- 失败原因展示与原卡重新提交
- 最多 100 张卡密的充值记录查询
- 服务公告与 SSE 实时队列状态（失败时自动降级轮询）
- 带卡密链接自动填入充值栏

## 重要变化

常规充值继续保留 4–128 位的通用卡密校验，不修改卡密大小写。进阶充值对用户接受 `TIM-`、`TIM5X-`、`TIM20X-` 加 11 位字母或数字的格式，移除空白并统一为大写。Node 服务端将前缀分别映射为供应商的 `JZ-`、`JZ5X-`、`JZ20X-`，后缀不变，覆盖验证、提交和批量查询（含单任务轮询）。响应中的卡密及消息内完整卡密转换回 TIM 格式；非卡密形状的原始任务编号保留，方便售后核对。前端不包含供应商前缀映射。供应商 JZ 卡密需要先改为 TIM 格式再发给客户，这只是同一张卡的别名，不会生成新余额或新的兑换资格。

最新接口要求 Session JSON 同时包含 `accessToken`、`sessionToken` 和账号邮箱。前后端代理都会在提交前检查这三项，避免缺少可续期令牌的任务进入队列。

订阅查询现在只用于提交前提示，不再把已有会员作为前端硬性门槛。用户确认风险后仍可提交，最终订阅状态由处理服务实时复查，并通过任务的 `failure_reason` 返回结果。

当 `verify-cdk` 返回换码剩余次数时，页面会提供“换一张卡密”。旧码在换码成功后立即失效，新码只在当次响应中出现，页面会持续展示复制入口直到提交或离开当前流程。排队任务只有在接口返回 `cancellable: true` 时才显示取消入口，最终是否可取消仍由服务端原子判断。

向客户发送带卡密的充值链接时优先使用 URL Fragment：

```text
https://你的域名/#card=完整卡密
```

进阶充值发货链接请使用 `https://你的域名/#channel=advanced&card=TIM-完整后缀`，页面会选择进阶通道并填入卡密。没有通道参数的旧链接仍进入常规充值。进阶批量查询支持换行、逗号、分号及下一张 TIM 卡密前的空白分隔，并去除单张卡密内误粘贴的空白。

响应适配仅转换 `cdk_code`、`new_code` 卡密字段，以及 `error`、`message`、`failure_reason` 展示文案中的供应商前缀。邮箱、任务编号和其他字段保持原值。队列数量必须为非负安全整数（或数字字符串），空值及异常类型显示获取失败。

Fragment 不会随首个 HTTP 请求发送给 Cloudflare、Render 或源站，因此卡密不会出现在基础设施访问日志中。页面读取有效卡密并自动填入充值栏后，会把地址栏恢复为 `#recharge`。旧版 `?card=完整卡密` 链接仍兼容，但仅建议用于过渡。

批量查询对应的是“充值任务记录”。新 API 的 `/lookup/tasks` 只返回已经产生任务的 CDK，因此未返回的卡密显示为“暂无提交记录”，不会被错误标记为不存在。

## 本地预览

Windows 用户可直接双击 `打开网站.cmd`，也可以运行：

```powershell
npm start
```

然后访问 `http://127.0.0.1:4173`。

未配置接口时，服务默认连接：

```text
http://localhost:8080/api/v1
```

## 新 API 配置

所有供应商请求都通过同源 Node 代理发送，网页端不会直接连接供应商，也不会接触 API Key。常规充值保留原有的 API Key；进阶充值固定使用无 Key 的 `https://jzplus.org`。

必须在服务器环境变量中配置：

| 变量 | 必填 | 说明 |
|---|---:|---|
| `REGULAR_API_BASE_URL` | 建议配置 | 常规充值 API 地址；可填写域名根地址或完整 `/api/v1` 地址 |
| `REGULAR_STATION_API_KEY` | 建议配置 | 常规充值的对外 API Key |
| `CDK_API_BASE_URL` | 兼容旧配置 | 未配置 `REGULAR_API_BASE_URL` 时作为常规充值地址 |
| `STATION_API_KEY` | 兼容旧配置 | 未配置 `REGULAR_STATION_API_KEY` 时作为常规充值 Key |
| `ADVANCED_API_BASE_URL` | 否 | 进阶充值 API 地址，默认 `https://jzplus.org`，不设置 API Key |
| `NODE_ENV=production` | 生产必填 | 启用生产配置完整性检查 |
| `PORT` | 否 | 监听端口，默认 `4173` |
| `HOST` | 否 | 监听地址，默认 `0.0.0.0` |
| `TRUST_PROXY=1` | 反向代理部署时 | 信任可信代理传入的客户端 IP |

PowerShell 本地联调示例：

```powershell
$env:REGULAR_API_BASE_URL="https://apiai.jzplus.org"
$env:REGULAR_STATION_API_KEY="你的API密钥"
$env:ADVANCED_API_BASE_URL="https://jzplus.org"
npm start
```

常规充值当前供应商 Base URL 为 `https://apiai.jzplus.org`；进阶充值默认 Base URL 为 `https://jzplus.org`，无需 API Key。服务端会把仅含域名的配置自动规范化为对应的 `/api/v1/`，也接受已经包含 `/api/v1` 的写法。

不要把 `STATION_API_KEY` 写入 `app.js`、提交到 GitHub，或配置成浏览器可见的前端变量。

生产环境启用 `NODE_ENV=production` 或运行在 Render 时，如果缺少常规充值的 `REGULAR_API_BASE_URL`（或旧变量 `CDK_API_BASE_URL`）和 API Key，服务会拒绝启动；两条通道的 Base URL 也必须使用 HTTPS。本地开发仍可使用 `http://localhost`。不要为了进阶充值设置 `ALLOW_EMPTY_STATION_API_KEY=1`；该开关只与常规充值的旧兼容配置有关。

## 代理白名单

本地服务仅放行以下公开接口，并按通道分开转发：

- `/api-proxy/regular/*`：全部原有公开接口，包括换码与取消任务。
- `/api-proxy/advanced/*`：状态、公告、卡密验证、任务提交、订阅查询、队列和记录查询；不开放供应商未提供的 SSE 队列接口。
- 进阶充值不暴露换码或取消任务路由，因为该供应商文档未提供对应接口。

管理端和其他内部接口不会被代理。代理还会校验请求结构、限制请求体大小、限制上游响应体积，并执行客户端和全局限流。兼容旧地址与新通道地址共用同一组限流桶，不能通过切换 URL 重复消耗供应商接口。

网站的单任务进度查询也通过 `POST /lookup/tasks` 完成，避免把卡密放进查询 URL。常规充值优先使用 SSE 实时队列，并在不可用时降级为轮询；进阶充值按文档固定使用 15 秒队列轮询。进阶任务查询从 10 秒开始，未出现新状态时逐步放缓到 30 秒，避免持续产生无效请求。

## 部署上线

部署环境需要 Node.js 18 或更高版本，启动命令为：

```text
npm start
```

如果网站使用 Cloudflare CDN 代理到 Node 主机，应：

1. 在 Node 托管平台配置常规充值的 `REGULAR_API_BASE_URL`、`REGULAR_STATION_API_KEY`，并按需配置 `ADVANCED_API_BASE_URL`；进阶充值无需 Key。
2. 仅允许公网通过 Cloudflare 或可信反向代理访问应用。
3. 设置 `TRUST_PROXY=1`，使限流优先使用 Cloudflare 的客户端 IP；没有 Cloudflare 标记时仅使用最靠近应用的转发地址，避免直接信任可伪造的首个 `X-Forwarded-For`。
4. 使用 HTTPS，不直接暴露 Node 端口。
5. 在 Cloudflare 开启 Always Use HTTPS、HSTS 和基础限流/WAF 规则。
6. 确认 Render 原始域名不作为公开访问入口；如果无法关闭，应避免依赖可伪造的转发头作为唯一安全边界。

Node 内置限流用于最后一道保护，只在当前进程内生效，重启后会清空，多实例之间也不会共享。生产环境必须同时在 Cloudflare 对验证卡密、创建任务、订阅查询与充值记录查询设置集中限流。

仓库包含 `render.yaml`，可用于 Render Blueprint 或作为现有服务配置基准。常规充值的 Base URL 和 Key 必须在 Render Dashboard 手动填写；进阶充值默认使用 `https://jzplus.org`。健康检查路径为 `/healthz`。

如果当前部署是纯 Cloudflare Pages 静态托管，`server.js` 不会运行，需要先把 `/api-proxy/*` 迁移为 Cloudflare Worker 或 Pages Functions，不能把 API Key 放回前端。

上线前运行：

```powershell
npm test
```

并使用供应商提供的测试卡完成以下验收：

1. 有效、无效、已用和处理中的卡密。
2. 完整、缺少 `sessionToken`、已有会员和过期 Session 账号。
3. 换码成功、次数用尽、换码冷却和旧码提示。
4. 排队取消成功、任务已开始无法取消和取消后的重新提交。
5. 任务提交、自动刷新、完成、失败和重新提交。
6. SSE 实时队列、轮询降级、批量记录缺失、接口限流和上游不可用。

## 安全说明

Session JSON 只保存在当前页面内存中，任务提交后立即清空，不写入 `localStorage` 或 `sessionStorage`。提交时它会通过同源 HTTPS 代理发送给充值后端。

Node 静态服务采用文件白名单，只公开 `index.html`、`app.js` 和 `styles.css`。`server.js`、`.git`、测试文件、README、环境文件和部署配置不会通过网站访问。

供应商后端是否保存 Session、如何加密以及保留多久，不由本项目决定。生产上线前应与供应商确认数据留存、日志脱敏和删除策略，再决定页面上的隐私承诺文案。
