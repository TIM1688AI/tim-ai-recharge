# Tim AI 充值站

一个根据 jzai16888 合作方接口文档制作的零依赖 Node.js 充值站，包含：

- 单卡校验与充值
- 已有订阅覆盖二次确认
- 最多 100 张卡密批量查询
- 响应式布局与完整的错误提示
- 使用用户粘贴的 ChatGPT Session JSON 完成充值

卡密统一使用“产品前缀-16 位字母或数字”格式，例如 `Plus-AAAAAAAAAAAAAAAA` 或 `Pro5x-BBBBBBBBBBBBBBBB`。网站不再接受旧的纯 16 位卡密。

向客户发送带卡密的充值链接时，使用 `https://你的域名/?card=完整卡密`。页面读取有效卡密并自动填入充值栏后，会从地址栏移除 `card` 参数，减少卡密留在浏览记录或后续跳转中的风险。

## 本地预览

Windows 用户可直接双击 `打开网站.cmd`。

也可以在本目录运行：

```powershell
npm start
```

然后访问 `http://127.0.0.1:4173`。

## 品牌与接口配置

编辑 `app.js` 顶部的 `CONFIG`：

```js
const CONFIG = {
  brandName: "Tim AI",
  apiBase: "https://jzai16888.com/api/v1",
  proxyBase: "/api-proxy",
  requestTimeout: 25000,
};
```

`redeem` 固定通过同源代理提交，避免网络错误后自动换通道造成重复充值。卡密校验和批量查询优先直连上游，遇到浏览器网络或 CORS 错误时回退到同源代理。

## 部署上线

部署环境需要 Node.js 18 或更高版本，启动命令为：

```text
npm start
```

可用环境变量：

- `PORT`：平台分配的监听端口，默认 `4173`
- `HOST`：监听地址，默认 `0.0.0.0`
- `TRUST_PROXY=1`：仅当应用位于可信反向代理或 CDN 后方时启用，用于读取 `X-Forwarded-For` 并按真实客户端 IP 限流

正式环境必须使用 HTTPS。若通过 Nginx、Caddy、Cloudflare 或平台负载均衡器终止 TLS，应只允许外部流量经过该可信代理；启用 `TRUST_PROXY=1` 时不要将 Node 端口直接暴露到公网。

部署后运行：

```text
npm test
```

并使用正式域名分别验证单卡查询、批量查询和一张测试卡的完整充值流程。

## 安全说明

Session JSON 仅保存在当前页面内存中，刷新或关闭页面后清除，不写入 localStorage。提交充值时会作为 `accountSession` 发送到配置的 jzai16888 API。

本地服务仅代理 `verify-cardkey`、`redeem` 和 `cardkey/batch-status` 三个白名单接口。代理会校验 JSON 请求结构、限制请求体大小，并对每个客户端和整个服务执行 60 秒滑动窗口保护性限流。
