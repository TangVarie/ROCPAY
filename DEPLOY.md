# ROCPAY 部署指南（微信云托管 + 自带 MySQL）

> 这是在原 `README.md` 基础上、**加上数据库（建库）后**的完整部署走一遍。
> 只想跑通转账、暂时不要数据库？跳过第 3 步即可——不填 `MYSQL_*` 变量，系统自动运行在「无状态模式」，转账照常工作。

---

## 0. 架构与你需要准备的东西

```
微信小程序（本地上传）
      │  wx.cloud.callContainer（自动带 x-wx-openid）
      ▼
微信云托管 · 后端容器（本仓库根目录，监听 3000）
      │  内网
      ▼
微信云托管 · 自带 MySQL（库名 rocpay，3 张表由服务启动时自动创建）
      │  外网 HTTPS 签名请求
      ▼
微信支付 V3 · 商家转账 transfer-bills
```

**只有你能提供、我无法替你生成的凭证（部署前先备齐）：**

| 凭证 | 去哪拿 |
|---|---|
| 商户号 `MCHID` | 微信支付商户平台 |
| APIv3 密钥（32 位） | 商户平台 → 账户中心 → API安全 → APIv3密钥 |
| 商户证书序列号 | 商户平台 → API安全 → API证书 → 查看证书 |
| 商户私钥 `apiclient_key.pem` | 申请 API 证书时下载 |
| 小程序 `AppID` | 小程序后台 → 开发管理 → 开发设置 |
| 转账场景 ID | 商户平台 → 产品中心 → 商家转账（申请开通后获得） |

并确认：小程序已在【商户平台 → AppID授权管理】关联到商户号。

---

## 1. 代码推到 GitHub

本仓库已经准备好（含数据库集成）。把它推到你的 GitHub 私有仓库即可——**不含任何密钥**，密钥全部在云托管环境变量里填。
（如果你正在用本项目的自动化分支/PR，代码已经在远端，直接进第 2 步。）

> ⚠️ 千万别把真实 `.env`、`apiclient_key.pem` 提交上去（`.gitignore` 已忽略）。

---

## 2. 云托管绑定部署

1. **选择方式**：绑定 GitHub 仓库（授权时私有仓库勾 `repo`）。授权失败就改用「本地代码上传」上传本项目 zip。
2. **代码仓库/分支**：选你的仓库，分支 `main`（或你的部署分支）。
3. **端口**：默认 `80` 改成 **`3000`**（务必，和 Dockerfile 的 `EXPOSE 3000` 一致，否则探活失败）。
4. **健康检查路径**：如可配置，填 **`/`**（根路径，纯存活探测、不碰数据库，最快最稳）。
5. 展开「高级设置 → 环境变量」，按第 4 节《环境变量清单》逐条填。
6. 先别点发布——**先做第 3 步开通数据库**，把 MySQL 变量也一起填了，再发布。

---

## 3. 开通数据库（建库）★ 本次新增

后端和数据库**必须在同一个云托管环境**，才能走内网互通。

### 3.1 在云托管开通 MySQL
1. 云托管控制台 → **数据库 / MySQL** → **开通**（选 5.7 或 8.0 都行，代码两者都兼容）。
2. 设置 **root 密码**（记住它）。
3. 开通后，在「连接信息 / 连接管理」里抄下 **内网地址**（形如 `10.x.x.x`）、**端口**（一般 `3306`）、**用户名**（`root`）。

> **不需要**你手动建库建表。库名 `rocpay` 和 3 张表（`rewards` / `transfers` / `notify_events`）会在服务**第一次启动时自动创建**（`src/db.js` 里的 `CREATE DATABASE / CREATE TABLE IF NOT EXISTS`，幂等安全）。

### 3.2 把连接信息填进服务的环境变量
二选一：

- **方式①（推荐，一行搞定）**
  ```
  MYSQL_URL = mysql://root:你的密码@内网地址:3306/rocpay
  ```
  ⚠️ 用 URL 方式时，`rocpay` 库需已存在；若你的实例还没有这个库，请用方式②（方式②会自动建库）。

- **方式②（分开填，能自动建库）**
  ```
  MYSQL_HOST = 内网地址（如 10.x.x.x）
  MYSQL_PORT = 3306
  MYSQL_USER = root
  MYSQL_PASSWORD = 你设置的root密码
  MYSQL_DATABASE = rocpay
  ```

> 密码里若含 `@ : / ?` 等特殊字符，优先用方式②（避免 URL 转义问题）。

### 3.3 手动建表（可选，仅当你把 `DB_AUTO_MIGRATE` 设成 `false`）
在云托管 MySQL 的「数据库管理」网页控制台，粘贴执行 `db/schema.sql`。正常情况下**不用管这步**。

---

## 4. 环境变量清单（高级设置 → 环境变量）

| 变量名 | 填什么 |
|---|---|
| `WECHATPAY_MCHID` | 商户号（纯数字） |
| `WECHATPAY_API_V3_KEY` | APIv3 密钥（正好 32 位） |
| `WECHATPAY_MERCHANT_CERT_SERIAL` | 商户证书序列号 |
| `WECHATPAY_PRIVATE_KEY` | `apiclient_key.pem` 的**完整内容**（含 BEGIN/END 行；多行不便时把换行替换成 `\n` 连成一行，代码会自动还原） |
| `WECHATPAY_APPID` | 你的**小程序 AppID** |
| `WECHATPAY_TRANSFER_SCENE_ID` | 转账场景 ID（如 1000） |
| `WECHATPAY_NOTIFY_URL` | 先留空；拿到服务域名后回填 `https://<服务域名>/api/notify` |
| `REWARD_TOKEN_SECRET` | 一串长随机字符串（务必改） |
| `ADMIN_OPENIDS` | 先留空；第 6 步再填员工小程序 openid |
| **`MYSQL_HOST`** | **云托管 MySQL 内网地址**（或改用 `MYSQL_URL`） |
| **`MYSQL_PORT`** | **3306** |
| **`MYSQL_USER`** | **root** |
| **`MYSQL_PASSWORD`** | **你设置的 root 密码** |
| **`MYSQL_DATABASE`** | **rocpay** |

> 可选：`MYSQL_POOL_SIZE`（默认 5）、`DB_AUTO_MIGRATE`（默认 true）、`REWARD_TTL_HOURS`（默认 72）、`MAX_AMOUNT_YUAN`（默认 5000）。
> `PORT` 不用填（Dockerfile 已设 3000）；但部署页「端口」字段一定要填 3000。

填完点 **发布**，等构建部署（几分钟）。

---

## 5. 部署后自检

1. 浏览器访问 `https://<服务域名>/api/health` →
   ```json
   { "ok": true, "time": "...", "db": { "enabled": true, "ok": true } }
   ```
   - `db.enabled=true, ok=true` → **数据库连通、表已就绪** ✅
   - `db.enabled=false` → 没填 `MYSQL_*`（无状态模式）。要落库就回去补变量重发。
   - `db.ok=false` → 连不上库：查内网地址/端口/账号/密码，确认 MySQL 与服务同环境。
2. 访问 `https://<服务域名>/api/diagnose?key=<你的REWARD_TOKEN_SECRET>` →
   返回 `"ok": true` 且能看到 `platformSerials` → 商户号/证书/私钥/APIv3密钥/出口IP白名单 全部正确。
3. 回填 `WECHATPAY_NOTIFY_URL = https://<服务域名>/api/notify`，重新发布一次。
4. **出口 IP 加白名单**：云托管「服务设置/网络」找到**公网出口 IP** → 商户平台 → API安全 → **接口安全IP** 加入它。

---

## 6. 小程序（本地，不走云托管）

1. 微信开发者工具打开本仓库 `miniprogram/` 目录。
2. 改 `miniprogram/project.config.json` 的 `appid` 为你的小程序 AppID。
3. 改 `miniprogram/miniprogram/config.js`：`CLOUD_ENV`=云托管环境ID，`SERVICE`=云托管服务名。
4. 点「上传」→ 小程序后台设为**体验版**，把你和员工加为体验成员。

**设管理员**：员工用小程序打开（非管理员页会显示他的 openid）→ 把 openid 填进环境变量 `ADMIN_OPENIDS`（多个逗号隔开）→ 重新发布。管理员的发放页底部会出现「**最近发放**」列表（数据来自数据库；未开库则不显示）。

---

## 7. 0.01 元真实联调

发放页输 `0.01` → 生成奖励 → 「转发给客户」发给自己微信 → 点开领取 → 微信「确认收款」→ 查零钱是否 +0.01。
到账后：
- 管理员页「最近发放」应看到这笔，状态随确认收款变为 `SUCCESS`；
- 或调 `GET /api/rewards`（管理员身份）看列表 + 汇总；
- `POST /api/notify` 回调会把状态与审计流水写进库。

---

## 8. 对账 / 后台

- **列表 + 汇总**：`GET /api/rewards?limit=50`（需管理员）→ `{ list, stats }`。
- **单笔查询并回写状态**：`GET /api/transfers/<out_bill_no>`（会顺手用微信最新状态刷新库）。
- **审计流水**：`notify_events` 表存每一条微信回调解密原文。
- 数据表结构见 `db/schema.sql`。

> **回调可靠性**：`/api/notify` 收到回调后会**先把状态同步落库**再回执；万一此刻数据库抖动写入失败，会返回 `FAIL` 让微信按策略稍后重试（至少一次），不会因一次抖动永久丢状态。数据库未开启时则直接回 `SUCCESS`。状态回写是**单调**的：不会把已到账(SUCCESS)/已失败(FAIL)的终态回退。

---

## 9. 排错表（含数据库）

| 现象 | 原因 | 处理 |
|---|---|---|
| `/api/health` 打不开 | 端口没填 3000 | 部署页端口改 3000 重发 |
| `db.ok=false` | 连不上 MySQL | 核对内网地址/端口/账号/密码；确认库与服务**同环境**；`MYSQL_URL` 模式确认库已存在 |
| 启动日志「自动建表失败」 | 库连不上/权限不足 | 服务仍能跑转账，只是不落库；修好连接后重启即自动建表 |
| appid 和 mch_id 不匹配 | 小程序没关联商户号 | 商户平台 AppID授权管理 关联小程序 |
| 此IP不允许调用接口 | 出口IP没进白名单 | API安全 → 接口安全IP 加入出口IP |
| SIGN_ERROR 签名错误 | 证书序列号/私钥/APIv3 不对 | 用 `/api/diagnose` 自检 |
| 客户收不到钱 | 客户没点确认收款 | 必须客户在微信里点「确认收款」，24h 不确认自动退回 |

---

## 10. 重要规则（与代码一致）

- 单笔 **≥ 2000 元必须**填收款人真实姓名；**< 0.3 元不能**填姓名。
- 一张领取卡片只对应第一个领取的人；重复点不会重复付款（`out_bill_no` 幂等，库里也只记首个领取人）。
- 数据库只是**账本**：即使库暂时挂了，发钱/领钱也不受影响（best-effort 落库），事后可用 `GET /api/transfers/<单号>` 对账补录。
- `recipient_name`（真实姓名）属敏感信息，存在 `rewards` 表；后台列表接口 `GET /api/rewards` **默认不返回真实姓名**（数据最小化），只在库里留档。

### 安全须知（身份与后台接口）
- 管理员身份靠请求头 `x-wx-openid` 判断。这个头在**通过小程序 `wx.cloud.callContainer` 调用云托管**时由平台注入、无法伪造；但服务的**公网域名**（给 `/api/notify` 回调用）不会注入它。
- 因此：**不要把管理员 openid 当秘密到处发**；如条件允许，在云托管为服务开启「仅小程序端可访问 / 访问来源限制」，或用网关规则**限制公网直接访问 `/api/rewards`、`/api/me`** 等管理接口，只放行 `/api/notify`、`/api/health`。
- `/api/diagnose` 已用 `?key=REWARD_TOKEN_SECRET` 保护；`/api/health` 不回传任何数据库连接细节。

> 微信支付客服 95017 ｜ 商家转账文档 https://pay.weixin.qq.com/doc/v3/merchant/4012716434
