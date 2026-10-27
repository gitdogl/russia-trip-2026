# 旅行清单发布接口

网页的“保存并发布”通过GitHub App提交固定文件 published-checklists.json。仓库、分支和所有者ID由Worker配置固定，浏览器不能指定其他文件。

## 部署

Worker配置在 wrangler.toml。GitHub App仅安装到旅行仓库，权限为Contents读写；OAuth回调为Worker地址的 /auth/callback。

在Cloudflare中设置以下Secrets：

- GITHUB_CLIENT_ID
- GITHUB_CLIENT_SECRET
- GITHUB_PRIVATE_KEY：PKCS8格式PEM私钥
- SESSION_SECRET：32字节随机值的base64url编码

密钥文件保存在仓库之外，不得提交。修改后使用Wrangler部署，本项目Worker为标准ES模块，可用 --no-bundle。publisher-config.json 中的 initialSha 对应内置清单首次发布时的文件SHA，不能随普通发布随意更新。

register-app.mjs 是本机一次性登记助手。它只监听127.0.0.1，接收GitHub App登记结果并将密钥写入指定的仓库外目录；日常发布不依赖该助手。

## 发布白名单

所有者 GITHUB_OWNER_ID 始终保留发布权限。额外名单在 wrangler.toml 的 GITHUB_PUBLISHER_IDS 中配置，初始为空，多个GitHub数字用户ID用英文逗号分隔。这里填写用户ID，不填写用户名或仓库ID。

可通过 GitHub公开用户接口 https://api.github.com/users/用户名 查看返回的 id。核对 login 确为目标账号，再将数字 id 填入名单。使用稳定ID可避免用户名变更或被他人复用后影响授权。

修改配置并重新部署Worker后生效。登录回调与每次发布都会核对当前名单；移除后，用户之前取得的8小时会话也会被拒绝。空名单不开放给所有人，仍只允许所有者。浏览器传来的身份不能替代服务端校验。

名单中的用户在博客用自己的GitHub账号登录即可，无需仓库协作者、Cloudflare或应用管理权限。GitHub App仍只写固定清单文件；版本冲突检查继续生效。

## 请求与版本

- GET /health：服务配置状态。
- GET /auth/start：GitHub OAuth登录入口，使用state、浏览器Cookie和PKCE。
- GET /auth/callback：校验GitHub账号并返回8小时发布会话。
- GET /snapshot：返回当前文件SHA与清单内容。
- POST /publish：提交 expectedSha 和 snapshot，需Bearer发布会话，且账号为仓库所有者或当前白名单用户。

清单格式沿用网页JSON备份。后端重新校验九类数据、金额、分类关联与大小限制。与当前云端内容一致时直接成功；内容不同且SHA过期时返回409，不执行覆盖。

接口只向博客来源开放CORS，安装令牌仅在Worker内使用。会话和GitHub令牌不写日志，Worker请求观测默认关闭。

## 验证

运行 node --test publisher/tests/worker.test.mjs，检查权限、OAuth校验、数据校验、冲突与重复提交。测试使用临时密钥及模拟GitHub响应，不读取真实凭据。

网页使用隔离浏览器验证本机旧数据迁移、同时编辑多行、发布后去重、刷新、手机读取、冲突后保留和登录片段清理。真实用户OAuth授权仍需在博客点击登录完成。
