# 客户奖励发放 · 部署说明（GitHub + 微信云托管）

后端用微信支付「商家转账」把钱发到外部客户的微信零钱，员工在小程序里触发。**全程免 ICP 备案、不用国内服务器**。

> 2025 新规：商家转账必须收款人自己点「确认收款」，微信不会主动推送，所以必须有一个小程序当"确认载体"。这套方案已按新规实现。

> 📗 **要连数据库（把发奖/领取/到账状态落库、做对账后台）？** 看 **[`DEPLOY.md`](./DEPLOY.md)** —— 那是在本文基础上加了「微信云托管自带 MySQL」建库步骤的完整走查。
> 不想要数据库也没关系：不填 `MYSQL_*` 变量时系统自动运行在无状态模式，转账链路照常。

---

## 仓库结构（本仓库）

```
仓库根目录/                 ← 后端，云托管用它构建（Dockerfile 就在根目录）
├── Dockerfile             # 监听端口 3000
├── package.json
├── .env.example           # 环境变量清单（不要把真实 .env 提交）
├── .gitignore / .dockerignore
├── cert/                  # 本方案用环境变量传私钥，这里可留空
├── db/
│   └── schema.sql         # MySQL 建表参考（服务启动会自动建，通常不用手跑）
├── src/
│   ├── config.js          # 配置加载（含 MySQL 配置块）
│   ├── wechat-pay.js      # 微信支付 V3：签名/证书/加密/验签
│   ├── transfer-service.js# 发起商家转账 + 查询
│   ├── reward-token.js    # 领取令牌（防篡改）
│   ├── db.js              # 业务库数据层（云托管自带 MySQL·带开关·可降级）
│   ├── db-cli.js          # 数据库自检/建表小工具（npm run db:ping / db:migrate）
│   ├── app.js             # Express 路由入口
│   └── smoke-test.js
└── miniprogram/           # 小程序（本地用微信开发者工具打开，【不部署到云托管】）
```

**要点**：云托管只部署根目录后端；`miniprogram/` 是小程序，单独用微信开发者工具打开上传，构建镜像时已被 `.dockerignore` 排除。

---

## 步骤 A · 把代码推到 GitHub

在 GitHub 新建一个仓库（**private 私有即可**，本仓库不含任何密钥）。然后在本项目目录里执行：

```bash
git init
git add .
git commit -m "init: 商家转账后端"
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

> ⚠️ 千万不要把真实的 `.env` 和 `apiclient_key.pem` 提交上去（`.gitignore` 已帮你忽略）。密钥统一在云托管「环境变量」里填。

---

## 步骤 B · 云托管绑定 GitHub 部署（对着你现在这个「部署发布」页）

1. **选择方式**：绑定 GitHub 仓库。
2. 点红字里的 **「点击授权」** → 跳转授权微信云托管访问你的 GitHub。
   - 授权时如果是 **私有仓库**，记得勾选 `repo` 权限；授权后回来刷新。
   - 若私有仓库授权后仍不显示：把 `选择方式` 改成 **「本地代码上传」**，直接上传本项目 zip 即可（一样能用，跳过 GitHub）。
3. **代码仓库**：选你刚建的仓库；**分支**：`main`。
4. **端口**：把默认的 `80` 改成 **`3000`**（务必！要和 Dockerfile 里的 `EXPOSE 3000` 一致，否则健康检查过不了）。
5. 展开下方 **「高级设置」→ 环境变量**，按下面《环境变量清单》逐条添加。
6. 点 **「发布」**，等待自动构建部署（约几分钟；之后每次 push 到 main 都会自动重新部署）。

---

## 环境变量清单（填在「高级设置 → 环境变量」里）

| 变量名 | 填什么 |
|---|---|
| `WECHATPAY_MCHID` | 商户号（纯数字） |
| `WECHATPAY_API_V3_KEY` | APIv3 密钥（正好 32 位） |
| `WECHATPAY_MERCHANT_CERT_SERIAL` | 商户证书序列号（API证书→查看证书） |
| `WECHATPAY_PRIVATE_KEY` | `apiclient_key.pem` 的**完整内容**（含 BEGIN/END 行） |
| `WECHATPAY_APPID` | 你的**小程序 AppID** |
| `WECHATPAY_TRANSFER_SCENE_ID` | 转账场景 ID（商家转账里申请，如 1000） |
| `WECHATPAY_NOTIFY_URL` | 先留空；拿到服务域名后回填 `https://<服务域名>/api/notify` |
| `REWARD_TOKEN_SECRET` | 你自定义的一串长随机字符串（务必改） |
| `ADMIN_OPENIDS` | 先留空；第 D 步再填员工的小程序 openid |

> 私钥多行不好粘贴时：可以把换行替换成 `\n` 连成一行填入（代码会自动还原），或直接用云托管环境变量的多行输入。
> `PORT` 不用填（Dockerfile 已设 3000）；但上一步页面的「端口」字段一定要填 3000。

---

## 步骤 C · 部署后自检

1. 浏览器访问 `https://<你的服务域名>/api/health` → 返回 `ok`，说明服务起来了。
2. 访问 `https://<你的服务域名>/api/diagnose?key=<你的REWARD_TOKEN_SECRET>`
   - 返回 `"ok": true` 且能看到 `platformSerials` → **商户号/证书/私钥/APIv3密钥/出口IP白名单 全部正确**。
   - 报错就按下面《排错表》查。
3. 把服务的公网域名回填到环境变量 `WECHATPAY_NOTIFY_URL`（`https://<域名>/api/notify`），重新发布一次。
4. **出口 IP 加白名单**：在云托管服务的「服务设置 / 网络」里找到该服务的**公网出口 IP**，回到微信支付商户平台 → 账户中心 → API安全 → **接口安全IP** 里加入它（否则调转账会报"此IP不允许调用"）。

---

## 步骤 D · 小程序（本地，不走云托管）

1. 用**微信开发者工具**打开本仓库的 `miniprogram/` 目录。
2. 改 `miniprogram/project.config.json` 里的 `appid` 为你的小程序 AppID。
3. 改 `miniprogram/miniprogram/config.js`：
   - `CLOUD_ENV` = 云托管的**环境ID**（如 `prod-xxxx`）。
   - `SERVICE` = 云托管的**服务名**（你的是 `express-u6ju`）。
4. 点「上传」→ 在小程序后台设为**体验版**，把你和员工加为体验成员。

**设管理员**：员工用小程序打开，页面会显示他自己的 openid；把这些 openid 填进云托管环境变量 `ADMIN_OPENIDS`（多个用英文逗号隔开），重新发布。

---

## 步骤 E · 0.01 元真实联调

员工在小程序【发放页】输 `0.01` → 生成奖励 → 点「转发给客户」发给自己的微信 → 点开领取 → 微信官方「确认收款」→ 确认 → 查零钱是否 +0.01。到账即全链路打通。

---

## 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| 部署后 `/api/health` 打不开 | 端口没填 3000 | 部署页「端口」改 3000 重发 |
| appid 和 mch_id 不匹配 | 小程序没关联商户号 | 商户平台 AppID授权管理 关联小程序 |
| 此IP地址不允许调用接口 | 云托管出口IP没进白名单 | API安全→接口安全IP 加入出口IP |
| SIGN_ERROR 签名错误 | 证书序列号/私钥/APIv3 不对 | 核对三者，用 `/api/diagnose` 自检 |
| 客户"收不到钱" | 客户没点确认收款 | 必须客户自己在微信里点「确认收款」，24h不确认自动退回 |

---

## 重要规则

- 单笔 **≥ 2000 元必须**填收款人真实姓名；**< 0.3 元不能**填姓名（代码已按此校验）。
- 一张领取卡片只对应第一个领取的人；同一张卡片重复点不会重复付款（幂等）。
- 商户号要有足够可用余额。

> 微信支付客服 95017 ｜ 商家转账文档 https://pay.weixin.qq.com/doc/v3/merchant/4012716434
