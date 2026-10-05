# 瓣朵酒店代理人绩效系统

基于开源 Node.js 与 SQLite 的轻量网页应用。没有第三方 npm 运行依赖，方便本地运行和部署；前端以原生 HTML/CSS/JavaScript 实现。

## 当前功能

- 管理员与代理人登录、退出；SQLite 保存账号、订单、比例、结算与操作记录。
- 管理员可创建代理人账号；代理人只查看本人数据，提交订单后进入待审核状态。
- 管理员录入/修改订单，按接入自然月归属；取消/退款订单剔除，剩余有效订单自动按时间递补。
- 每月前 5 笔有效订单各计 50 元，第 6 笔起按房价金额乘代理人当月提点计算。
- 可设置某月所有代理人的统一比例，也可按某个代理人单独设置；每次修改记录操作者及修改前后值。
- 月度结算生成不可变的绩效快照；结算后不可修改该月比例或订单。
- 月度总览、订单明细、代理人账号、提点规则、结算确认、CSV 导出。

## 本地运行（Windows PowerShell）

安装 Node.js 22.5+，在此目录运行：

```powershell
./start.ps1
```

首次启动会在终端显示一次管理员账号和随机密码。请保存密码。然后访问 `http://127.0.0.1:3000`。SQLite 文件保存在 `data/banduo.sqlite`。

也可以启动前设置自己的管理员账号和密码：

```powershell
$env:ADMIN_USERNAME = 'owner'
$env:ADMIN_PASSWORD = 'replace-with-a-long-random-password'
./start.ps1
```

## 测试

```powershell
npm test
```

测试使用 Node 内置测试运行器和内存 SQLite，不会创建或修改正式数据库。

GitHub Actions 工作流位于 `.github/workflows/test.yml`，推送到 GitHub 或创建 Pull Request 后会运行前后端检查。

## Docker 部署

复制 `.env.example` 为 `.env`，设置足够强的 `ADMIN_PASSWORD`。`COOKIE_SECURE=true` 适用于通过 HTTPS 反向代理访问的部署；仅在本机 HTTP 测试时设成 `false`。再运行：

```sh
docker compose up -d --build
```

应用监听 3000 端口，SQLite 数据保存在 `banduo-data` 卷。公开上线仍需提供 HTTPS 域名、服务器与备份策略；不要将 `.env` 或数据库文件提交到 GitHub。

## 安全边界

密码使用 PBKDF2-SHA256 加盐散列；会话随机生成、服务端存储哈希并通过 HttpOnly/SameSite Cookie 发送；修改请求需要 CSRF 令牌并校验 Origin。系统仍是单体 MVP，正式公开运营前建议配置 HTTPS 反向代理、数据库备份、日志监控、管理员密码轮换与账户停用/密码重置流程。

