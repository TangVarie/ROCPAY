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
| `WECHATPAY_PRIVATE_KEY` | `apiclient_key.pem` 的**完整内容**（含 BEGIN/END 行）。**推荐改用 `WECHATPAY_PRIVATE_KEY_BASE64`**：把整个 pem 文件 base64（`base64 -w0 apiclient_key.pem`），填成一长串、无换行无转义烦恼，最不易出错 |
| `WECHATPAY_APPID` | 你的**小程序 AppID** |
| `WECHATPAY_TRANSFER_SCENE_ID` | 转账场景 ID（如 1000 现金营销 / 1005 佣金报酬），要和下面的报备信息配套 |
| `WECHATPAY_SCENE_REPORT_INFOS` | 该场景要求的报备字段（JSON 数组）。**非 1000 场景必填**，见 §11 |
| `WECHATPAY_NOTIFY_URL` | 先留空；拿到服务域名后回填 `https://<服务域名>/api/notify` |
| `REWARD_TOKEN_SECRET` | 一串长随机字符串（务必改） |
| `ADMIN_OPENIDS` | 先留空；第 6 步再填员工小程序 openid |
| **`MYSQL_HOST`** | **云托管 MySQL 内网地址**（纯地址，**不要带 `:3306`**；或改用 `MYSQL_URL`） |
| **`MYSQL_PORT`** | **3306** |
| **`MYSQL_USER`** | **root** |
| **`MYSQL_PASSWORD`** | **你设置的 root 密码** |
| **`MYSQL_DATABASE`** | **rocpay** |

> 企微（P2，接企微时才填，见 §12）：`WECOM_CORPID`、`WECOM_CONTACT_SECRET`、`WECOM_CALLBACK_TOKEN`、`WECOM_CALLBACK_AES_KEY`（后两个用于解锁「企业可信IP」，见 §12.4）、可选 `WECOM_AGENT_ID`。
> **安全（强烈建议）**：`WX_PUBLIC_HOSTS`=你的公网自定义域名（如 `roc.bywood.com.cn`，多个逗号分隔）。设了它，公网域名只放行回调/健康/验证路径、且不信任伪造的 x-wx-openid，防止有人从公网冒充管理员调 `/api/rewards` 等接口。小程序走内网 callContainer 不受影响（设完用体验版验一下发放正常即可）。`ALLOW_DEV_AUTH` 只在本地调试用 `DEV_OPENID` 时置 `1`，**生产环境绝不要设**。
> 可选：`MYSQL_POOL_SIZE`（默认 5）、`DB_AUTO_MIGRATE`（默认 true）、`REWARD_TTL_HOURS`（默认 72）、`MAX_AMOUNT_YUAN`（默认 5000）、`MIN_AMOUNT_YUAN`（默认 0.1，见 §11）。
> 余额台账：`WECHATPAY_BALANCE_ACCOUNT_TYPE`（默认 `BASIC`；若「商家转账」从运营账户出资则设 `OPERATION`）。余额查询是**独立接口权限**，需在商户平台「产品中心→申请开通」搜"余额"单独开通（与打款权限互不带通），未开通不影响发放与台账，只是余额块显示"未开通"。可临时用 `/api/balance?account=OPERATION` 探测你商户号有哪个账户。
> 安全医生域名验证：商户平台「账户中心→安全中心→安全医生」下载 `verify_xxx.html` 后，把**文件名**填 `WECHATPAY_VERIFY_FILE`、**文件内容**填 `WECHATPAY_VERIFY_CONTENT`，重部署 → 访问 `https://<你的域名>/verify_xxx.html` 能返回内容即可点"开始验证"。诊断链接按 `https://<域名>/api/notify` 格式绑定；对接 API 的服务器 IP = 云托管出口IP（与打款白名单同一个）。
> 私钥推荐用 `WECHATPAY_PRIVATE_KEY_BASE64`（`base64 -w0 apiclient_key.pem`），比多行 PEM 稳。
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
| 启动崩溃 `DECODER routines::unsupported` | 私钥 PEM 换行被压坏 | 改用 `WECHATPAY_PRIVATE_KEY_BASE64`（`base64 -w0 apiclient_key.pem`），并确认填的是私钥不是证书 |
| `db.ok=false` 且日志 `ENOTFOUND` | `MYSQL_HOST` 填错（常见误带 `:3306`） | `MYSQL_HOST` 只填纯地址，端口放 `MYSQL_PORT` |
| `db.ok=false` 且日志 `ETIMEDOUT` | MySQL 与服务不在同一环境/网络不通 | 确认 MySQL 就在本服务所在环境里开的 |
| diagnose `HTTP 406 传入了不支持的 Accept-Language` | 运行时/代理注入了微信不认的头 | 代码已写死 `Accept-Language: zh-CN`；确保跑的是最新构建 |
| 转账 `PARAM_ERROR 未传入完整且对应的转账场景报备信息` | 报备字段和场景不符 | 按场景配 `WECHATPAY_SCENE_REPORT_INFOS`（见 §11） |
| 转账 `INVALID_REQUEST 超过单笔转账上下限` | 金额低于系统最低额 / 高于你的单笔上限 | 金额取在下限~单笔上限之间；用 `MIN_AMOUNT_YUAN` 前端拦截 |
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

---

## 11. 转账额度与场景备忘（实战踩坑总结）

### 11.1 转账额度（商户平台 → 商家转账 → 转账额度）
新商户默认额度较小，**这些是上限，下限由微信系统固定、页面不显示也不可改**：

| 额度 | 默认值 | 说明 |
|---|---|---|
| 单笔转账 | 约 ¥100 | 一次最多转多少 |
| 单日转账总额 | 约 ¥1,000 | 一天所有转账合计 |
| 单日向单用户 | 约 ¥200 | 一天给同一个人最多 |
| 单商户单月 | 3,000 万 | 不可改 |
| **单笔最低额（下限）** | 微信系统值 | 页面看不到；`0.01` 会被拒。用 `MIN_AMOUNT_YUAN` 前端拦截（默认 0.1，按实际调） |

- 发奖会超出上限 → 商户平台点「**修改额度**」申请提额（文档建议用一段时间后再申请）。
- 商户**可用余额要充足**，转账从余额扣。

### 11.2 转账场景与报备信息（`transfer_scene_id` + `WECHATPAY_SCENE_REPORT_INFOS` 配套）
不同场景要求的 `transfer_scene_report_infos` 字段不同，**必须严格一致**，否则报
`未传入完整且对应的转账场景报备信息`。常见：

| 场景ID | 场景 | 报备字段 `info_type`（各≤32字） |
|---|---|---|
| 1000 | 现金营销 | `活动名称`、`奖励说明`（**代码默认**，不填 `WECHATPAY_SCENE_REPORT_INFOS` 即用它） |
| 1005 | 佣金报酬 | `岗位类型`、`报酬说明` |
| 其他 | —— | 以「发起转账API文档 → `transfer_scene_report_infos` 参数表」为准 |

配置示例（场景 1005）：
```
WECHATPAY_TRANSFER_SCENE_ID=1005
WECHATPAY_SCENE_REPORT_INFOS=[{"info_type":"岗位类型","info_content":"推广合作"},{"info_type":"报酬说明","info_content":"{remark}"}]
```
- `info_content` 里的 `{remark}` 会自动替换成本次发奖备注。
- **换场景 = 两个一起改**（scene_id + report_infos）；换回 1000 可直接删掉 `WECHATPAY_SCENE_REPORT_INFOS`。
- ⚠️ 场景要和**实际用途一致**：给客户的营销奖励更贴近 `1000 现金营销`；`1005 佣金报酬` 通常是发员工/合作方。按你申请到的场景用。

### 11.3 对账 / 查看记录（数据库账本）
- 浏览器（对账）：`https://<域名>/api/rewards?key=<REWARD_TOKEN_SECRET>` → 返回 `{ list, stats }`。
- 小程序：管理员页底部「最近发放」。
- 单笔并回写状态：`GET /api/transfers/<out_bill_no>`。
- 客户「确认收款」后微信回调 `/api/notify`，状态自动更新为 `SUCCESS`（单调、不回退）。

### 11.4 部署关键顺序（避免返工）
1. 服务端口 **3000**、健康检查 **`/`**、代码来源指向本仓库分支。
2. 改代码后重部署**务必走「执行流水线」**（重新构建）；只改环境变量可复用镜像。用 `/api/health` 的 `build` 字段确认线上版本。
3. MySQL 与服务**同环境**；`MYSQL_HOST` 不带端口。
4. 出口IP加白名单后再验 `/api/diagnose`。
5. 私钥用 `_BASE64`；场景报备按 §11.2 配；金额在额度区间内。

---

## 12. P2 定向发放 · 使用说明与外部通道清单

### 12.1 运营怎么用（小程序工作台）
1. **发放 → 定向发放**：点「⟳ 从企微同步」拉客户 → 按**备注名**搜索（如"李部长"）→ 勾选一批 → 下一步
2. **逐人金额**：可先「统一填充」再单独微调某人 → 确认发放
3. **通知客户**：企微群发（员工在企微「群发助手」点一次发送），或直接「转发领取入口」到客户聊天
4. **客户侧零门槛**：客户打开小程序即**自动看到属于自己的奖励**（unionid 身份识别），点领取 → 确认收款 → 到账。**别人打开看不到、领不走**
5. 「链接快发」保留：生成不记名卡片转发，适合企微外临时发放

### 12.2 要接上的外部通道（代码已就绪，接上即用）
| 通道 | 操作 | 解锁什么 |
|---|---|---|
| **小程序发布上线** | 上传→提交审核→发布 | 真实客户可访问；企微可关联小程序 |
| **微信开放平台** | 小程序+企微绑同一开放平台（同主体） | unionid 一致 → 定向身份识别 |
| **企微·客户联系** | 在「客户联系→客户→API→可调用接口的应用」授权自建应用；`WECOM_CONTACT_SECRET`=**该自建应用的 Secret**（新版无独立「客户联系 Secret」）；**企业可信IP加云托管出口IP** | 同步客户/备注名、群发通知 |
| **云托管环境变量** | `WECOM_CORPID` + `WECOM_CONTACT_SECRET`（重部署） | 后端企微功能启用 |

> 未接企微时系统自动降级：客户档案可手动/DB维护，群发按钮提示改用转发；不影响确认收款主链路。

### 12.3 P2 相关接口速查
`GET /api/customers?q=备注名` 搜客户 ·
`POST /api/customers/sync` 企微同步（自动发现员工）·
`POST /api/rewards/batch` 逐人金额定向发放 ·
`POST /api/deliver` 企微群发通知（带**小程序卡片**，客户点开直达领取页，无需搜索小程序名；封面上传失败自动降级为纯文字）·
`GET /api/balance` 商户实时可用余额（管理员/发放员可见，元）·
`GET|POST /api/claim/mine` 客户身份领取（防领错）

> **群发卡片**：`/api/deliver` 会自动上传封面（`assets/reward-cover.png`，由 `scripts/make-cover.mjs` 生成）拿 `pic_media_id`，附一张跳 `pages/claim/claim.html` 的小程序卡片。要求小程序 AppID 已关联企微。
> **实时余额**：`/api/balance` 走微信支付 V3 直连商户端点 `/v3/merchant/fund/balance/BASIC`，金额分转元；工作台「记录」页顶部展示，配合「累计发放」看清发了多少/还剩多少。

### 12.4 企业可信IP 配置（解锁企微服务端接口）★

企微规定：读通讯录/客户联系数据的服务端接口，调用方 IP 必须在「企业可信IP」白名单里，
否则报 `errcode 60020`。这个 IP = **云托管服务的公网出口IP**（和微信支付白名单用的是同一个）。

企微后台配「企业可信IP」前，会要求先设「可信域名」或「接收消息服务器URL」二选一。
⚠️ **两者都会对域名做「主体校验」：填的域名必须已 ICP 备案，且备案主体与企微企业主体相同或关联。**
云托管默认域名（`*.run.tcloudbase.com`）备案主体是腾讯 → 永远校验不过。**必须绑一个你自己的、
备案主体与企微一致的自定义域名。** 本项目走**接收消息服务器URL**（后端已内置回调端点）。按序操作：

0. **前置（决定成败）**：确认你的域名（如 `lyrison.com.cn`）已备案，且**备案主体 = 企微企业主体**。
   个人备案对企业主体、或不同公司，都会报「域名主体校验未通过」。不一致就得改备案主体或联系企微客服。
1. **绑自定义域名到云托管**：云托管 → 自定义域名 → 绑定。用一个子域名（如 `roc.lyrison.com.cn`；
   ⚠️ 别用 `pay.`/`bank.` 等词，腾讯免费证书对含这些词的域名不签发），关联服务 `roc`，开启 HTTPS，
   上传该域名的 SSL 证书 + 私钥。**证书用腾讯云「SSL 证书 → 免费证书」免费签发（¥0，与域名注册商无关，
   加一条 TXT 到你 DNS 做验证即可，现为 90 天有效期、到期免费重申）**，下载 Nginx 格式得 `.crt`/`.key`。
   确定后按提示在你的 DNS 加一条 CNAME 指向云托管给的目标。解析生效后访问
   `https://roc.lyrison.com.cn/api/health` 应正常返回。回调地址 = 该域名 + `/api/wecom/callback`。
2. **企微生成 Token / EncodingAESKey**：企微管理后台 → 应用管理 → 你的自建应用 → 接收消息 →
   「设置API接收」→ 两个「随机获取」分别生成 **Token** 和 **EncodingAESKey**（先别点保存，复制出来）。
3. **回填云托管环境变量并重部署**：
   - `WECOM_CALLBACK_TOKEN` = 上一步的 Token
   - `WECOM_CALLBACK_AES_KEY` = 上一步的 EncodingAESKey（43 位）
   - 重部署后访问 `https://roc.lyrison.com.cn/api/health`，确认 `"wecomCallback": true`（回调已就绪）。
4. **企微保存回调URL**：URL 填第 1 步的回调地址 → 保存。此时才会做主体校验 + 发验证请求；
   主体一致且后端验签正确即保存成功。
5. **配企业可信IP**：输入框解锁后，填入**云托管出口IP**（服务详情里的出口IP，和微信支付白名单同一个，
   多个用英文 `;` 分隔）→ 确定。
6. 至此企微服务端接口全部放行，`/api/customers/sync`、unionid 定向、群发即可真机联调。

> 顺序很关键：**先第 3 步（环境变量 + 重部署）再第 4 步（企微保存）**，否则企微验证时后端还没配好 Token，验证会失败。
> 不想弄自定义域名？企微服务端接口无法绕开可信IP（externalcontact 也受管控，会报 60020）。
> 此时系统按「自动降级」运行：核心发钱/领取/确认收款链路完全不受影响，仅少了企微自动同步客户/群发，
> 客户档案改为手动或直接数据库维护、通知改用「转发领取入口」。

> 微信支付客服 95017 ｜ 商家转账文档 https://pay.weixin.qq.com/doc/v3/merchant/4012716434
