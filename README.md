# Tim AI 充值站

基于 `cdk-recharge-system` 公开 API 的零依赖 Node.js 充值站，包含：

- CDK 校验与充值任务提交
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

新 API 没有规定固定卡密格式。网站只进行 4–128 位的基础长度检查，不再修改卡密大小写，最终有效性由 `verify-cdk` 接口判断。

最新接口要求 Session JSON 同时包含 `accessToken`、`sessionToken` 和账号邮箱。前后端代理都会在提交前检查这三项，避免缺少可续期令牌的任务进入队列。

订阅查询现在只用于提交前提示，不再把已有会员作为前端硬性门槛。用户确认风险后仍可提交，最终订阅状态由处理服务实时复查，并通过任务的 `failure_reason` 返回结果。

当 `verify-cdk` 返回换码剩余次数时，页面会提供“换一张卡密”。旧码在换码成功后立即失效，新码只在当次响应中出现，页面会持续展示复制入口直到提交或离开当前流程。排队任务只有在接口返回 `cancellable: true` 时才显示取消入口，最终是否可取消仍由服务端原子判断。

向客户发送带卡密的充值链接时优先使用 URL Fragment：

```text
https://你的域名/#card=完整卡密
```

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

所有供应商请求都通过同源 Node 代理发送，网页端不会接触 API Key。

必须在服务器环境变量中配置：

| 变量 | 必填 | 说明 |
|---|---:|---|
| `CDK_API_BASE_URL` | 生产必填 | 供应商 API 地址；可填写域名根地址或完整 `/api/v1` 地址 |
| `STATION_API_KEY` | 视供应商配置 | 对外 API Key；强制鉴权开启时必填 |
| `NODE_ENV=production` | 生产必填 | 启用生产配置完整性检查 |
| `PORT` | 否 | 监听端口，默认 `4173` |
| `HOST` | 否 | 监听地址，默认 `0.0.0.0` |
| `TRUST_PROXY=1` | 反向代理部署时 | 信任可信代理传入的客户端 IP |

PowerShell 本地联调示例：

```powershell
$env:CDK_API_BASE_URL="https://apiai.jzplus.org"
$env:STATION_API_KEY="你的API密钥"
npm start
```

当前供应商 Base URL 为 `https://apiai.jzplus.org`。服务端会把仅含域名的配置自动规范化为 `https://apiai.jzplus.org/api/v1/`，也接受已经包含 `/api/v1` 的写法。

不要把 `STATION_API_KEY` 写入 `app.js`、提交到 GitHub，或配置成浏览器可见的前端变量。

生产环境启用 `NODE_ENV=production` 或运行在 Render 时，如果缺少 `CDK_API_BASE_URL`、`STATION_API_KEY`，服务会拒绝启动。供应商明确关闭 API Key 鉴权时，才可设置 `ALLOW_EMPTY_STATION_API_KEY=1`。

## 代理白名单

本地服务只放行以下公开接口：

- `GET /api/v1`
- `GET /api/v1/announcement`
- `POST /api/v1/recharge/verify-cdk`
- `POST /api/v1/recharge/create-task`
- `POST /api/v1/recharge/refresh-cdk`
- `POST /api/v1/recharge/cancel-task`
- `POST /api/v1/recharge/check-subscription`
- `GET /api/v1/recharge/queue-status`
- `GET /api/v1/recharge/queue-events`
- `POST /api/v1/lookup/tasks`

管理端和其他内部接口不会被代理。代理还会校验请求结构、限制请求体大小，并执行客户端和全局限流。

网站的单任务进度查询也通过 `POST /lookup/tasks` 完成，避免把卡密放进查询 URL。SSE 实时队列连接还设有单 IP 和全局并发上限，超过上限时浏览器会自动降级为轮询。

## 部署上线

部署环境需要 Node.js 18 或更高版本，启动命令为：

```text
npm start
```

如果网站使用 Cloudflare CDN 代理到 Node 主机，应：

1. 在 Node 托管平台配置 `CDK_API_BASE_URL` 和 `STATION_API_KEY`。
2. 仅允许公网通过 Cloudflare 或可信反向代理访问应用。
3. 设置 `TRUST_PROXY=1`，使限流使用真实客户端 IP。
4. 使用 HTTPS，不直接暴露 Node 端口。
5. 在 Cloudflare 开启 Always Use HTTPS、HSTS 和基础限流/WAF 规则。
6. 确认 Render 原始域名不作为公开访问入口；如果无法关闭，应避免依赖可伪造的转发头作为唯一安全边界。

仓库包含 `render.yaml`，可用于 Render Blueprint 或作为现有服务配置基准。`CDK_API_BASE_URL` 和 `STATION_API_KEY` 使用 `sync: false`，实际值仍需在 Render Dashboard 手动填写。健康检查路径为 `/healthz`。

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
