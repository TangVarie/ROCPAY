// ============================================================
//  配置加载与校验
//  在服务启动 / 冒烟测试时最先执行，尽早暴露配置错误
// ============================================================
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..'); // 指向 server/ 目录

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`[配置错误] 缺少必填环境变量 ${name}，请在 server/.env 中填写`);
  }
  return v.trim();
}

function optional(name, def = '') {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : def;
}

// 相对路径按 server/ 解析；绝对路径原样返回
function resolvePath(p) {
  if (!p) return '';
  return p.startsWith('/') ? p : resolve(SERVER_ROOT, p);
}

// 环境变量里贴 PEM 时，把字面量 \n 还原成真正换行（云托管/serverless 常用）
function unescapePem(s) {
  return s ? s.replace(/\\n/g, '\n') : '';
}

// 读取 PEM 类环境变量：
//   优先 <NAME>_BASE64（把整个 .pem 文件 base64 后填入，一长串、无换行无转义，最稳妥）；
//   否则用 <NAME>（普通粘贴，自动把字面量 \n 还原成真换行）。
function readPemEnv(name) {
  const b64 = optional(`${name}_BASE64`);
  if (b64) {
    try {
      return Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  return unescapePem(optional(name));
}

export const config = {
  port: Number(optional('PORT', '3000')),

  wechatpay: {
    mchid: required('WECHATPAY_MCHID'),
    apiV3Key: required('WECHATPAY_API_V3_KEY'),
    merchantSerial: required('WECHATPAY_MERCHANT_CERT_SERIAL'),
    // 商户私钥：优先环境变量（WECHATPAY_PRIVATE_KEY 或更稳妥的 _BASE64），否则读文件
    privateKeyPem: readPemEnv('WECHATPAY_PRIVATE_KEY'),
    privateKeyPath: resolvePath(optional('WECHATPAY_PRIVATE_KEY_PATH', './cert/apiclient_key.pem')),
    // 收款 openid 与该 appid 必须一致；本方案 = 你的【小程序 AppID】
    appid: required('WECHATPAY_APPID'),
    transferSceneId: optional('WECHATPAY_TRANSFER_SCENE_ID', '1000'),
    // 场景报备信息（JSON 数组），必须匹配你申请到的转账场景要求的字段。
    // 例：WECHATPAY_SCENE_REPORT_INFOS=[{"info_type":"岗位类型","info_content":"推广合作"},{"info_type":"报酬说明","info_content":"{remark}"}]
    sceneReportInfos: (() => {
      const raw = optional('WECHATPAY_SCENE_REPORT_INFOS');
      if (!raw) return null;
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) && arr.every((i) => i && i.info_type) ? arr : null;
      } catch {
        return null;
      }
    })(),
    notifyUrl: optional('WECHATPAY_NOTIFY_URL'), // 商家转账回调，形如 https://xxx/api/notify
    // 微信支付「安全医生」域名验证：把下载到的 verify_xxx.html 的【文件名】和【文件内容】分别填这两个变量，
    // 后端会在 https://你的域名/verify_xxx.html 原样返回，用于证明域名归属。换文件不用改代码。
    verifyFile: optional('WECHATPAY_VERIFY_FILE'),
    verifyContent: optional('WECHATPAY_VERIFY_CONTENT'),
    // 平台验签/加密：微信支付公钥模式（可选），留空则自动下载平台证书
    publicKeyId: optional('WECHATPAY_PUBLIC_KEY_ID'),
    publicKeyPem: readPemEnv('WECHATPAY_PUBLIC_KEY'),
    publicKeyPath: resolvePath(optional('WECHATPAY_PUBLIC_KEY_PATH')),
  },

  app: {
    // 员工(管理员)的小程序 openid 白名单，逗号分隔；只有这些人能生成奖励
    adminOpenids: optional('ADMIN_OPENIDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // 奖励领取令牌的 HMAC 签名密钥，务必设为一串足够长的随机字符串
    rewardTokenSecret: optional('REWARD_TOKEN_SECRET'),
    // 领取链接有效期（小时）
    rewardTtlHours: Number(optional('REWARD_TTL_HOURS', '72')),
    // 单笔转账上限（元），保护性阈值
    maxAmountYuan: Number(optional('MAX_AMOUNT_YUAN', '5000')),
    // 单笔转账下限（元），前端/后端提前拦截，避免小于微信系统最低额被拒
    minAmountYuan: Number(optional('MIN_AMOUNT_YUAN', '0.1')),
    // 微信商户「单笔转账限额」（元）。定向发放单人金额超过它时自动拆成多笔串行领取；
    // 商户后台申请提额后改这个环境变量即可
    splitCapYuan: Number(optional('SPLIT_CAP_YUAN', '200')),
    // 微信「单日向单用户转账限额」（元）。单人一次发放总额的硬上限（拆单也绕不过微信这条线）
    perUserDailyCapYuan: Number(optional('PER_USER_DAILY_CAP_YUAN', '2000')),
  },

  // 微信小程序服务端能力（订阅消息直达通知）。三件齐才启用，缺任一则静默关闭、走企微群发老路：
  //   WECHAT_SUBSCRIBE_TEMPLATE_ID  公众平台「订阅消息」里选用的模板 ID
  //   WECHAT_SUBSCRIBE_DATA         模板字段映射 JSON，值里可用占位符 {remark}/{amount}/{count}/{time}
  //                                 例：{"thing1":"{remark}","amount2":"¥{amount}","time3":"{time}"}
  //                                 （每个模板字段 key 不同，必须按你选的模板填）
  //   鉴权二选一：WECHAT_APPSECRET（小程序密钥，走 access_token）；或在微信云托管开通
  //   「开放接口服务」后设 WECHAT_CLOUDBASE_OPENAPI=true（免密钥，容器内直连 http://api.weixin.qq.com）
  weixin: (() => {
    const templateId = optional('WECHAT_SUBSCRIBE_TEMPLATE_ID');
    const appSecret = optional('WECHAT_APPSECRET');
    const cloudbaseOpenapi = optional('WECHAT_CLOUDBASE_OPENAPI', 'false').toLowerCase() === 'true';
    const subscribeData = (() => {
      const raw = optional('WECHAT_SUBSCRIBE_DATA');
      if (!raw) return null;
      try {
        const o = JSON.parse(raw);
        return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
      } catch {
        return null;
      }
    })();
    return {
      appSecret,
      cloudbaseOpenapi,
      subscribeTemplateId: templateId,
      subscribeData,
      subscribePage: optional('WECHAT_SUBSCRIBE_PAGE', 'pages/claim/claim'),
      subscribeEnabled: !!(templateId && subscribeData && (appSecret || cloudbaseOpenapi)),
    };
  })(),

  // 企业微信（P2·客户列表/群发/unionid定向）。留空则企微功能不启用，不影响现有链路。
  wecom: (() => {
    const corpid = optional('WECOM_CORPID');
    const contactSecret = optional('WECOM_CONTACT_SECRET');
    return {
      enabled: !!(corpid && contactSecret),
      corpid,
      // 用于拉客户/群发的 corpsecret。新版企微已无独立「客户联系 Secret」：
      // 到「客户联系 → 客户 → API → 可调用接口的应用」里授权一个自建应用，
      // 这里填【那个自建应用的 Secret】（应用管理 → 该自建应用 → Secret）。
      contactSecret,
      agentId: optional('WECOM_AGENT_ID'), // 自建应用 AgentId（群发发送者等场景用）
      appSecret: optional('WECOM_APP_SECRET'), // 自建应用 Secret（可选）
      // 「接收消息服务器URL」回调：仅用于解锁「企业可信IP」白名单配置
      // 在企微「自建应用 → 接收消息」点「随机获取」生成，两处必须与企微后台一致
      callbackToken: optional('WECOM_CALLBACK_TOKEN'),
      callbackAesKey: optional('WECOM_CALLBACK_AES_KEY'),
    };
  })(),

  // 业务库（微信云托管自带 MySQL）。留空则不建库、退回无状态模式。
  // 二选一：① 填 MYSQL_URL 连接串；或 ② 填 MYSQL_HOST/PORT/USER/PASSWORD/DATABASE。
  db: (() => {
    const url = optional('MYSQL_URL');
    const host = optional('MYSQL_HOST');
    const enabled = !!(url || host); // 有 URL 或 HOST 才启用
    // 只填了账号/密码/库名却没填 HOST/URL：本意多半是想开库，提醒别静默降级
    const partialConfig =
      !enabled &&
      !!(optional('MYSQL_USER') || optional('MYSQL_PASSWORD') || optional('MYSQL_DATABASE'));
    const poolSize = Math.max(Number(optional('MYSQL_POOL_SIZE', '5')) || 5, 1);
    return {
      enabled,
      partialConfig,
      url,
      host,
      port: Number(optional('MYSQL_PORT', '3306')),
      user: optional('MYSQL_USER', 'root'),
      password: optional('MYSQL_PASSWORD'),
      database: optional('MYSQL_DATABASE', 'rocpay'),
      connectionLimit: poolSize,
      // DB 卡住时的排队上限：给一点余量（池大小×4），超出直接失败，避免无限堆积
      queueLimit: poolSize * 4,
      // 启动时自动建表（CREATE TABLE IF NOT EXISTS，幂等）。设 false 则需手动跑 db/schema.sql
      autoMigrate: optional('DB_AUTO_MIGRATE', 'true').toLowerCase() !== 'false',
    };
  })(),
};

// ---------- 启动即校验，尽早报错 ----------

function assertFiniteNumber(name, value, { min, max, integer = false } = {}) {
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) ||
      (min != null && value < min) || (max != null && value > max)) {
    const range = `${min != null ? ` >= ${min}` : ''}${max != null ? ` <= ${max}` : ''}`;
    throw new Error(`[配置错误] ${name} 必须是${integer ? '整数' : '数字'}${range}，当前值为 ${value}`);
  }
}

assertFiniteNumber('PORT', config.port, { min: 1, max: 65535, integer: true });
assertFiniteNumber('REWARD_TTL_HOURS', config.app.rewardTtlHours, { min: 1 });
assertFiniteNumber('MIN_AMOUNT_YUAN', config.app.minAmountYuan, { min: 0.01 });
assertFiniteNumber('MAX_AMOUNT_YUAN', config.app.maxAmountYuan, { min: config.app.minAmountYuan });
assertFiniteNumber('SPLIT_CAP_YUAN', config.app.splitCapYuan, {
  min: config.app.minAmountYuan,
  max: config.app.maxAmountYuan,
});
assertFiniteNumber('PER_USER_DAILY_CAP_YUAN', config.app.perUserDailyCapYuan, {
  min: config.app.minAmountYuan,
});
if (config.db.enabled) {
  assertFiniteNumber('MYSQL_PORT', config.db.port, { min: 1, max: 65535, integer: true });
  assertFiniteNumber('MYSQL_POOL_SIZE', config.db.connectionLimit, { min: 1, max: 100, integer: true });
}

// 1) 商户私钥：环境变量 PEM 或 文件，二者至少有一个
if (!config.wechatpay.privateKeyPem && !existsSync(config.wechatpay.privateKeyPath)) {
  throw new Error(
    `[配置错误] 未提供商户私钥。请二选一：\n` +
    `  · 设置环境变量 WECHATPAY_PRIVATE_KEY 为 apiclient_key.pem 的完整内容；或\n` +
    `  · 把 apiclient_key.pem 放到 ${config.wechatpay.privateKeyPath}`
  );
}

// 2) APIv3 密钥必须正好 32 字节
{
  const len = Buffer.byteLength(config.wechatpay.apiV3Key, 'utf8');
  if (len !== 32) {
    throw new Error(`[配置错误] WECHATPAY_API_V3_KEY 必须是 32 位字符，当前是 ${len} 位`);
  }
}

// 3) 若配置了微信支付公钥模式，公钥（PEM 或 文件）必须存在
if (config.wechatpay.publicKeyId && !config.wechatpay.publicKeyPem && !existsSync(config.wechatpay.publicKeyPath)) {
  throw new Error(
    `[配置错误] 配置了 WECHATPAY_PUBLIC_KEY_ID 但没有提供公钥内容或文件（WECHATPAY_PUBLIC_KEY / WECHATPAY_PUBLIC_KEY_PATH）`
  );
}

export default config;
