// ============================================================
//  Express 服务入口（部署到微信云托管）
//  小程序通过 wx.cloud.callContainer 调用，云托管会自动注入 x-wx-openid
// ============================================================
import express from 'express';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createRewardToken, verifyRewardToken, newRid } from './reward-token.js';
import { createTransferBill, queryTransferByOutBillNo, cancelTransferByOutBillNo } from './transfer-service.js';
import { wechatpay } from './wechat-pay.js';
import { db } from './db.js';
import { wecom } from './wecom.js';
import { weixin } from './weixin.js';
import { verifyUrl, callbackEnabled } from './wecom-callback.js';

const app = express();

// 部署校验标记：每次改动会 bump，/api/health 会回显它，用来确认线上跑的是哪版代码
const BUILD = 'p21-alert-ack';

// 企微群发「小程序卡片」封面图（BYWOOD 藏蓝礼盒，scripts/make-cover.mjs 生成）
const CARD_COVER = fileURLToPath(new URL('../assets/reward-cover.png', import.meta.url));
// 封面图只读一次（懒加载缓存），避免每次群发都同步读盘阻塞事件循环
let cardCoverBuf = null;
function cardCover() {
  if (!cardCoverBuf) cardCoverBuf = readFileSync(CARD_COVER);
  return cardCoverBuf;
}
// 恒定时间比较 ?key=（避免计时侧信道）；密钥未配置或为空一律拒绝
function keyMatches(provided) {
  const secret = config.app.rewardTokenSecret;
  if (!secret || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// 收款人姓名规则（与 createTransferBill 一致）：在"生成"时就拦截，别拖到客户领取才炸
function nameRuleError(yuan, name) {
  const hasName = !!(name && String(name).trim());
  if (yuan >= 2000 && !hasName) return '金额 ≥ 2000 元必须填写收款人真实姓名';
  if (yuan < 0.3 && hasName) return '金额 < 0.3 元不支持填写收款人姓名';
  return null;
}

// 大额自动拆单：总额(分)按单笔限额 cap 拆成多笔（200×6+160 这种），客户逐笔确认串行到账。
// 余数小于起付线时，把最后一整笔和余数合并对半拆，保证每笔都在 [min, cap] 内
function splitAmountFen(totalFen, capFen, minFen) {
  if (totalFen <= capFen) return [totalFen];
  const bills = [];
  const k = Math.floor(totalFen / capFen);
  const r = totalFen - k * capFen;
  for (let i = 0; i < k; i++) bills.push(capFen);
  if (r === 0) return bills;
  if (r >= minFen) { bills.push(r); return bills; }
  const last = bills.pop() + r; // cap < last < cap+min，对半后两笔都 ≥ min 且 ≤ cap
  const a = Math.floor(last / 2);
  bills.push(a, last - a);
  return bills;
}

// 关键落库：同步等待 + 失败重试一次。用于"钱已划走"的记账（领取 CLAIMED），
// 最大限度保证额度台账不缺笔；两次都失败也不阻断业务（转账已发起），只留高危日志，
// 后台自动对账(reconcileTransfers)还会兜底追平。
async function persistCritical(action, fn) {
  if (!db.dbEnabled) return;
  try {
    await fn();
  } catch (e1) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      await fn();
    } catch (e2) {
      console.error(
        `[db][高危] ${action} 两次落库失败（转账已发起，台账可能缺一笔，自动对账会尝试追平）：`,
        e2.code || e2.message
      );
    }
  }
}

// 落库辅助：尽力而为，任何写库失败只记日志，绝不阻断发钱/领钱链路
function persist(action, fn) {
  if (!db.dbEnabled) return;
  Promise.resolve()
    .then(fn)
    .catch((e) => console.error(`[db] ${action} 落库失败（已忽略，不影响业务）：`, e.code || e.message));
}

// 保存原始报文，供回调验签使用
app.use(
  express.json({
    limit: '64kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// 静态文件：public/ 下的文件在域名根目录直接可访问（如安全医生验证文件 verify_xxx.html）。
// 放在最前、优先于下面的环境变量兜底：已提交的文件为准，避免环境变量填错时被旧值覆盖。
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

// 微信支付「安全医生」域名验证（备用）：在域名根目录原样返回 verify_xxx.html，证明域名归属。
// 文件名+内容用环境变量配置（WECHATPAY_VERIFY_FILE / WECHATPAY_VERIFY_CONTENT），换文件不改代码。
app.use((req, res, next) => {
  const vf = config.wechatpay.verifyFile;
  if (vf && req.method === 'GET' && req.path === '/' + vf) {
    return res.type('html').send(config.wechatpay.verifyContent || '');
  }
  next();
});

// ---- 公网域名防护 ----
// 公网自定义域名（企微/安全医生回调用）与小程序内网 callContainer 是同一个 Express。
// callContainer 由平台注入可信的 x-wx-openid；公网请求不会。为防有人在公网伪造 x-wx-openid
// 冒充管理员：① 公网只放行回调/健康/验证等无需身份的路径；② 公网一律不信任 x-wx-* 身份头。
// 在环境变量 WX_PUBLIC_HOSTS 填你的公网域名（逗号分隔，如 roc.bywood.com.cn）后生效。
const PUBLIC_HOSTS = (process.env.WX_PUBLIC_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOW_DEV_AUTH = process.env.ALLOW_DEV_AUTH === '1'; // 仅本地调试置 1；生产绝不设
function viaPublicDomain(req) {
  if (!PUBLIC_HOSTS.length) return false;
  return PUBLIC_HOSTS.includes(String(req.headers.host || '').split(':')[0].toLowerCase());
}
// 公网域名仅放行这些无需身份的路径；其余（/api/rewards、/api/period… 等管理/领取接口）一律 404
app.use((req, res, next) => {
  if (!viaPublicDomain(req)) return next();
  const p = req.path;
  const ok =
    p === '/' ||
    p === '/api/health' ||
    p === '/api/notify' ||
    p === '/api/wecom/callback' ||
    p.startsWith('/verify_');
  return ok ? next() : res.status(404).send('Not found');
});

// 身份来源：callContainer 注入的 x-wx-openid（公网不信任）。DEV_* 仅在 ALLOW_DEV_AUTH=1 时用于本地调试。
function getOpenid(req) {
  if (viaPublicDomain(req)) return '';
  return req.headers['x-wx-openid'] || (ALLOW_DEV_AUTH ? process.env.DEV_OPENID : '') || '';
}
function getUnionid(req) {
  if (viaPublicDomain(req)) return '';
  return req.headers['x-wx-unionid'] || (ALLOW_DEV_AUTH ? process.env.DEV_UNIONID : '') || '';
}
// ---- 管理员/员工：DB 缓存 + 引导超管（ADMIN_OPENIDS 里的人始终是超管）----
const bootstrapSupers = new Set(config.app.adminOpenids);
let adminCache = new Map(); // openid -> { role, enabled }
let adminCacheAt = 0;
let adminRefreshing = false;
const ADMIN_TTL = 15_000;

async function refreshAdmins() {
  if (!db.dbEnabled) return;
  try {
    const rows = await db.loadAdmins();
    const m = new Map();
    for (const a of rows)
      m.set(a.openid, { role: a.role, enabled: a.enabled, wecomUserid: a.wecom_userid || '' });
    adminCache = m;
    adminCacheAt = Date.now();
  } catch (e) {
    console.error('[admins] 刷新缓存失败：', e.code || e.message);
  }
}
function ensureFreshAdmins() {
  if (!db.dbEnabled || adminRefreshing || Date.now() - adminCacheAt <= ADMIN_TTL) return;
  adminRefreshing = true;
  refreshAdmins().finally(() => (adminRefreshing = false));
}
function adminRole(openid) {
  if (!openid) return null;
  if (bootstrapSupers.has(openid)) return 'super'; // 引导超管，DB 挂了也认
  ensureFreshAdmins();
  const a = adminCache.get(openid);
  return a && a.enabled ? a.role : null;
}
function isAdmin(openid) {
  return !!adminRole(openid);
}
function isSuperAdmin(openid) {
  return adminRole(openid) === 'super';
}
/** 员工 openid → 企微userid 映射（员工管理里配置）。没配返回 ''。 */
function adminWecomUserid(openid) {
  if (!openid) return '';
  ensureFreshAdmins();
  const a = adminCache.get(openid);
  return (a && a.enabled && a.wecomUserid) || '';
}

// 冷启动：首个 API 请求到达而管理员缓存尚未载入（adminCacheAt===0）时，先同步载入一次，
// 避免仅存在于 DB（非 ADMIN_OPENIDS）的管理员在扩容瞬间被误判 403。
app.use(async (req, res, next) => {
  if (db.dbEnabled && adminCacheAt === 0 && req.path.startsWith('/api/')) {
    await refreshAdmins().catch(() => {});
  }
  next();
});

// 健康检查（云托管探活）
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    build: BUILD,
    time: new Date().toISOString(),
    db: await db.ping(),
    wecom: wecom.wecomEnabled, // 企微客户联系是否已配置
    wecomCallback: callbackEnabled, // 「接收消息服务器URL」回调是否就绪（配可信IP前先看它是否 true）
  });
});

// 企业微信「接收消息服务器URL」回调
//   仅为满足企微前置（配「企业可信IP」需先设可信域名或本回调）而实现。
//   GET  = URL 验证：验签 + 解密 echostr，明文原样返回；
//   POST = 事件回调：本系统不消费企微事件，回空 200（企微视为无需回复）。
app.get('/api/wecom/callback', (req, res) => {
  try {
    const msg = verifyUrl({
      msgSignature: req.query.msg_signature,
      timestamp: req.query.timestamp,
      nonce: req.query.nonce,
      echostr: req.query.echostr,
    });
    res.type('text/plain').send(msg);
  } catch (e) {
    console.error('[wecom] 回调 URL 验证失败：', e.message);
    res.status(401).send('');
  }
});
app.post('/api/wecom/callback', (_req, res) => res.status(200).send(''));

// 当前用户：帮员工拿到自己的 openid、判断是否管理员，并告知金额上下限（前端预校验用）
// ---- 客户等级（合作档案）：按真实到账的领取次数/累计金额定级，满足次数或金额其一即达标 ----
// 机制参考去中心化平台的分层激励：级别只升不降、门槛透明、下一级进度可见
// 客户等级：8 级，纯按累计真实到账金额划分（不看次数），门槛几何递增拉开区分度。
// minFen=达到该级所需的累计到账（分）。改门槛/名称只动这张表，全端同步。
const LEVELS = [
  { lv: 1, name: '新伙伴', minFen: 1 }, //         ≥ ¥0.01（领过就是新伙伴）
  { lv: 2, name: '铜牌伙伴', minFen: 10000 }, //   ≥ ¥100
  { lv: 3, name: '银牌伙伴', minFen: 30000 }, //   ≥ ¥300
  { lv: 4, name: '金牌伙伴', minFen: 80000 }, //   ≥ ¥800
  { lv: 5, name: '钻石伙伴', minFen: 200000 }, //  ≥ ¥2,000
  { lv: 6, name: '合作专家', minFen: 500000 }, //  ≥ ¥5,000
  { lv: 7, name: '配合大师', minFen: 1200000 }, // ≥ ¥12,000
];
function levelOf(count, fen) {
  let cur = { lv: 0, name: '初识' };
  for (const L of LEVELS) {
    if (fen >= L.minFen) cur = L;
  }
  const next = LEVELS.find((L) => L.lv === cur.lv + 1) || null;
  return {
    lv: cur.lv,
    name: cur.name,
    next: next ? { name: next.name, needYuan: Math.max(0, (next.minFen - fen) / 100) } : null,
  };
}

app.get('/api/me', async (req, res) => {
  const openid = getOpenid(req);
  const role = adminRole(openid); // 'super' | 'operator' | null
  // 客户合作档案：领取过几次、累计到账多少 → 等级（查不到不拖累主流程）
  let profile = null;
  if (openid && db.dbEnabled) {
    try {
      const p = await db.getClaimerProfile(openid);
      profile = { count: p.count, totalYuan: p.totalFen / 100, level: levelOf(p.count, p.totalFen) };
    } catch (_) {
      profile = null;
    }
  }
  res.json({
    openid,
    isAdmin: !!role,
    isSuper: role === 'super',
    role: role || 'none',
    minAmountYuan: config.app.minAmountYuan,
    maxAmountYuan: config.app.maxAmountYuan,
    splitCapYuan: config.app.splitCapYuan, // 单笔限额，超过自动拆单
    perUserDailyCapYuan: config.app.perUserDailyCapYuan, // 单人单日上限（拆单也绕不过）
    wecom: wecom.wecomEnabled, // 企微是否已连接（前端据此提示）
    wecomUserid: adminWecomUserid(openid), // 本人的企微账号映射（''=未配置，群发任务会派给客户跟进人）
    db: db.dbEnabled,
    // 订阅消息直达通知：非空 = 已配置。客户端据此在领取时请求授权；管理端据此显示"小程序直达通知"
    subscribeTmplId: weixin.subscribeEnabled && db.dbEnabled ? config.weixin.subscribeTemplateId : '',
    profile,
  });
});

// 【客户】记录一次订阅授权（客户在小程序对模板点了「允许」后调用）。
// 配额记在客户自己的 openid 名下，只能给自己加——无越权面
app.post('/api/subscribe/grant', async (req, res) => {
  const openid = getOpenid(req);
  if (!openid) return res.status(401).json({ error: '未识别到身份' });
  if (!weixin.subscribeEnabled) return res.status(503).json({ error: '订阅消息未配置' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  try {
    await db.grantSubscribe(openid, config.weixin.subscribeTemplateId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 部署自检：验证 商户号/证书/私钥/APIv3密钥/出口IP白名单 是否全部有效
// 部署后用浏览器访问 https://你的域名/api/diagnose?key=<REWARD_TOKEN_SECRET>
app.get('/api/diagnose', async (req, res) => {
  if (!keyMatches(req.query.key)) {
    return res.status(403).json({ error: 'forbidden：请带上正确的 ?key=REWARD_TOKEN_SECRET' });
  }
  try {
    const certs = await wechatpay.refreshPlatformCerts();
    res.json({
      ok: true,
      mchid: config.wechatpay.mchid,
      appid: config.wechatpay.appid,
      transferSceneId: config.wechatpay.transferSceneId,
      platformSerials: certs.map((c) => c.serial),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 可发额度台账（自家账本；微信余额查询接口已弃用——需单独开通权限、且此账本已覆盖需求）——「运行式余额」模型：
//   剩余 = 锚点剩余(quota_base_fen) − 自锚点起已发放(allTimePaid − quota_base_paid_fen)
//   充值时新剩余 = 当前剩余 + 充值额（携带上期结余，解决"还剩一点又充值"）
//   校准时新剩余 = 直接设为实际余额（与商户平台核对时用）
// 每次充值/校准都重新锚定(把"自锚点已发放"归零)。管理员/发放员均可见可操作。
async function computeQuota() {
  const allTime = await db.getPeriodStats(null); // 全部已发放(已划走+在途冻结)
  const baseRaw = await db.getSetting('quota_base_fen', null);
  const hasQuota = baseRaw != null;
  const baseFen = Number(baseRaw) || 0;
  const anchorPaidFen = Number(await db.getSetting('quota_base_paid_fen', '0')) || 0;
  const paidSinceFen = allTime.paidFen - anchorPaidFen; // 自上次充值/校准起已发放
  const remainingFen = baseFen - paidSinceFen;
  return {
    hasQuota,
    remainingYuan: hasQuota ? remainingFen / 100 : null,
    paidSinceYuan: hasQuota ? Math.max(0, paidSinceFen) / 100 : null,
    allTimePaidYuan: allTime.paidFen / 100,
    allTimePaidCount: allTime.paidCount,
  };
}

app.get('/api/period', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  try {
    res.json(await computeQuota());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 调整额度：mode='add' 充值(累加,携带结余) | mode='set' 校准(设为实际余额)。金额单位元。
// 本质是给台账记个数（计算器），管理员都可操作，不设超管门槛——少一道审批麻烦
app.post('/api/period/adjust', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  const body = req.body || {};
  const mode = body.mode === 'set' ? 'set' : 'add';
  const yuan = Number(body.yuan);
  if (!(yuan >= 0)) return res.status(400).json({ error: '请输入正确金额' });
  const amtFen = Math.round(yuan * 100);
  // 幂等键：响应丢失后的重复提交带同一键，只记一次账（重复提交返回当前额度，前端无感）
  const opKeyRaw = String(body.opKey || '');
  const opKey = /^[a-f0-9]{16,64}$/i.test(opKeyRaw) ? opKeyRaw.toLowerCase() : '';
  try {
    // 事务 + 行锁（db.adjustQuota）：两位管理员同时充值也不会丢任何一笔
    await db.adjustQuota({ mode, amountFen: amtFen, opKey });
    res.json(await computeQuota());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 【员工】客户等级总榜：按真实到账聚合排名 + 等级；?lv=N 只看某一级。
// 返回 list（含各行等级）+ dist（各等级人数分布，给筛选条 + 概览用）+ levels（等级表，前端展示门槛）
app.get('/api/leaderboard', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  try {
    const LIMIT = 40;
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    // 分布桶：每级 [minFen, 下一级门槛)；SQL 聚合出各级人数，不受列表分页影响
    const buckets = LEVELS.map((L, i) => ({
      lv: L.lv,
      name: L.name,
      minFen: L.minFen,
      maxFen: i + 1 < LEVELS.length ? LEVELS[i + 1].minFen : null,
    }));
    // 榜单：按等级筛选时用该级金额区间做 HAVING，翻页 LIMIT/OFFSET（真分页，几千客户也翻得到底）
    const wantLv = req.query.lv != null && req.query.lv !== '' ? Number(req.query.lv) : null;
    const b = wantLv != null ? buckets.find((x) => x.lv === wantLv) : null;
    const [rows, distRes] = await Promise.all([
      db.getLeaderboard({
        limit: LIMIT,
        offset,
        minFen: b ? b.minFen : null,
        maxFen: b ? b.maxFen : null,
        viewerUserid: adminWecomUserid(getOpenid(req)), // 榜单名字优先显示查看者自己起的备注
      }),
      offset === 0 ? db.getLeaderboardDist(buckets) : Promise.resolve(null), // 分布只在第一页算一次
    ]);
    const list = rows.map((r, i) => {
      const lv = levelOf(Number(r.n), Number(r.fen));
      return {
        rank: offset + i + 1,
        name: r.remark || r.name || '客户' + String(r.claimer_openid || '').slice(-4),
        eu: r.external_userid || '', // 有企微档案才可跳单人台账
        count: Number(r.n),
        totalYuan: Number(r.fen) / 100,
        lv: lv.lv,
        lvName: lv.name,
      };
    });
    const out = { list, hasMore: rows.length === LIMIT };
    if (distRes) {
      out.dist = distRes.dist;
      out.total = distRes.total;
      out.levels = LEVELS.map((L) => ({ lv: L.lv, name: L.name, minYuan: L.minFen / 100 }));
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 异常提醒（记录 Tab 角标 / 主页警示）：只统计「知悉水位」之后新出现的失败/关闭单。
// 此前口径是历史总数——失败/关闭是终态永远不变，提醒处理完也消不掉，把统计当了待办。
// 现在：处理完点「标记已处理」记水位即清零，之后的新失败重新提醒；历史单台账永远可查
app.get('/api/alerts', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  try {
    const ackAt = await db.getSetting('fail_ack_at', null);
    res.json({ count: await db.countUnackedFailures(ackAt), ackAt: ackAt || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/alerts/ack', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  try {
    // 水位必须取【数据库时钟】：rewards.updated_at 由 MySQL CURRENT_TIMESTAMP 按库服务器
    // 时区（云托管为北京时间）生成，此前用应用时钟的 UTC 写水位，两边差 8 小时——
    // 失败落库后的 8 小时内 updated_at >= 水位 恒成立，怎么标记都清不掉（线上实测复现）
    const now = await db.getDbNow();
    if (!now) return res.status(500).json({ error: '取数据库时间失败，请重试' });
    await db.setSetting('fail_ack_at', now);
    res.json({ ok: true, ackAt: now });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 【员工】生成奖励，返回领取 token（前端据此拼领取链接/二维码）
app.post('/api/rewards', (req, res) => {
  const openid = getOpenid(req);
  if (!isAdmin(openid)) return res.status(403).json({ error: '无权限：仅管理员可生成奖励' });

  const { amountYuan, remark = '', name = '' } = req.body || {};
  const yuan = Number(amountYuan);
  if (!(yuan > 0)) return res.status(400).json({ error: '金额必须大于 0' });
  if (yuan < config.app.minAmountYuan) {
    return res.status(400).json({ error: `金额不能小于 ${config.app.minAmountYuan} 元（微信商家转账有最低单笔限额）` });
  }
  if (yuan > config.app.maxAmountYuan) {
    return res.status(400).json({ error: `金额超过上限 ${config.app.maxAmountYuan} 元` });
  }
  // 链接快发是单笔转账，超过微信单笔限额领取时必被拒——提前拦，大额走定向发放（自动拆单）
  if (yuan > config.app.splitCapYuan) {
    return res.status(400).json({ error: `单笔转账限额 ¥${config.app.splitCapYuan}，大额请用「定向发放」（自动拆成多笔）` });
  }
  const nameErr = nameRuleError(yuan, name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  const fen = Math.round(yuan * 100);
  try {
    // 幂等：前端带 clientKey 时 rid 由键确定性派生——重试得到同一 rid，
    // saveReward upsert 不会产生"界面拿不到 token 的孤儿单"白占额度；
    // 两次响应的 token 都指向同一笔，领取按 out_bill_no 天然幂等
    const ckRaw = String((req.body || {}).clientKey || '');
    const rid = /^[a-f0-9]{16,64}$/i.test(ckRaw)
      ? crypto.createHash('sha256').update(`quick:${ckRaw.toLowerCase()}`).digest('hex').slice(0, 32)
      : undefined;
    const { token, rid: outRid, exp } = createRewardToken({ fen, remark, name, rid });
    persist('saveReward', () =>
      db.saveReward({ rid: outRid, amountFen: fen, remark, name, createdBy: openid, exp })
    );
    res.json({ token, rid: outRid, exp, amountYuan: yuan, remark });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 【员工】后台：最近发放记录 + 汇总。
// 两种鉴权：① 小程序内 x-wx-openid 命中管理员；或 ② 浏览器带 ?key=REWARD_TOKEN_SECRET（对账用）。
app.get('/api/rewards', async (req, res) => {
  const byOpenid = isAdmin(getOpenid(req));
  const byKey = keyMatches(req.query.key);
  if (!byOpenid && !byKey) {
    return res.status(403).json({ error: '无权限：小程序内管理员访问，或浏览器带 ?key=REWARD_TOKEN_SECRET' });
  }
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库，无发放记录（配置 MYSQL_* 后可用）' });
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    // 台账筛选：status=created|expired|waiting|success|failed，days=近N天，target=某客户（单人往来），
    // batch=某一批次，q=关键词（备注/单号/金额/客户名），month=自然月 YYYY-MM
    // 列表和 stats 用同一组筛选 → stats 即"筛选范围内的资金消耗汇总"
    const filters = {
      status: String(req.query.status || 'all'),
      days: Number(req.query.days) || 0,
      target: String(req.query.target || ''),
      targetOpenid: String(req.query.targetOpenid || ''), // 直连客户单人往来（与 target 二选一）
      batch: String(req.query.batch || ''),
      q: String(req.query.q || ''),
      month: String(req.query.month || ''),
    };
    const [list, stats] = await Promise.all([
      // 客户名个性化：小程序内按操作员工显示各自的备注；?key= 对账模式没有 openid，退回兜底单值
      db.listRewards({ limit, offset, ...filters, viewerUserid: adminWecomUserid(getOpenid(req)) }),
      db.getStats(filters),
    ]);
    res.json({ list, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 【员工】撤回一笔奖励：未领取的直接作废；已领取待确认的向微信撤销转账（冻结资金解冻回流）。
// 撤回后客户端不再展示、不可再领；台账状态变「已撤回」，可发额度自动回流（撤销单不再计入消耗）。
app.post('/api/rewards/revoke', async (req, res) => {
  const openid = getOpenid(req);
  if (!isAdmin(openid)) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  const rid = String((req.body || {}).rid || '').trim();
  if (!rid) return res.status(400).json({ error: '缺少 rid' });
  try {
    const r = await db.getReward(rid);
    if (!r) return res.status(404).json({ error: '找不到这笔奖励' });
    if (r.status === 'CREATED') {
      const ok = await db.revokeReward(rid, openid); // 撤回连操作人一起落（审计）
      if (!ok) {
        // 状态在读写之间变了：查明真实状态再说话——重复撤回时别把"已撤回"误说成"刚被领取"
        const cur = await db.getReward(rid).catch(() => null);
        const st = cur && cur.status;
        const msg =
          st === 'CANCELLED'
            ? '这笔奖励已是撤回状态，无需重复操作'
            : st === 'CLAIMED'
              ? '这笔奖励刚被领取（转账已发起），刷新后可对「待确认」继续撤回'
              : '这笔奖励状态刚发生变化，请刷新后重试';
        return res.status(409).json({ error: msg });
      }
      return res.json({ ok: true, mode: 'unclaimed' });
    }
    if (r.status === 'CLAIMED') {
      // 已发起转账、客户还没点确认：向微信撤销，资金解冻回流
      const data = await cancelTransferByOutBillNo(rid);
      await db.updateTransferState({
        outBillNo: rid,
        state: data.state || 'CANCELING',
        transferBillNo: data.transfer_bill_no,
      });
      persist('markRevoked', () => db.markRevoked(rid, openid)); // 状态由撤销结果驱动，这里只补审计
      return res.json({ ok: true, mode: 'canceled', state: data.state });
    }
    return res.status(409).json({ error: `当前状态(${r.status})不可撤回：已到账或已终结` });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.data });
  }
});

// ================= 员工/管理员管理（仅超级管理员）=================
function requireSuper(req, res) {
  if (!isSuperAdmin(getOpenid(req))) {
    res.status(403).json({ error: '仅超级管理员可管理员工' });
    return false;
  }
  if (!db.dbEnabled) {
    res.status(503).json({ error: '未开启数据库，无法管理员工（配置 MYSQL_* 后可用）' });
    return false;
  }
  return true;
}

// 列出所有员工
app.get('/api/admins', async (req, res) => {
  if (!requireSuper(req, res)) return;
  try {
    res.json({ list: await db.loadAdmins(), me: getOpenid(req) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 新增 / 修改员工（openid + 备注名 + 角色）
app.post('/api/admins', async (req, res) => {
  if (!requireSuper(req, res)) return;
  const me = getOpenid(req);
  const openid = String((req.body || {}).openid || '').trim();
  const name = String((req.body || {}).name || '').trim();
  const role = (req.body || {}).role === 'super' ? 'super' : 'operator';
  // 员工的企微 userid（可选）：配置后该员工发起群发，任务会派给他自己
  const wecomUserid = String((req.body || {}).wecomUserid || '').trim();
  if (!openid) return res.status(400).json({ error: '请填写员工的 openid' });
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(openid)) return res.status(400).json({ error: 'openid 格式不对' });
  if (wecomUserid && !/^[\w@.-]{1,64}$/.test(wecomUserid)) {
    return res.status(400).json({ error: '企微账号（userid）格式不对' });
  }
  try {
    // 若把最后一个超管降级为操作员，拦截
    if (role !== 'super') {
      const cur = (await db.loadAdmins()).find((a) => a.openid === openid);
      if (cur && cur.role === 'super' && cur.enabled && (await db.countEnabledSupers()) <= 1) {
        return res.status(400).json({ error: '不能把最后一个超级管理员降级' });
      }
    }
    await db.upsertAdmin({ openid, name, role, createdBy: me, wecomUserid });
    await refreshAdmins();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 停用/启用员工。停用立即生效（缓存即时刷新），资料与企微映射保留，可随时恢复——
// 比"删了重加"多一条不中断权限档案的路（评审 管P1-4）
app.post('/api/admins/enable', async (req, res) => {
  if (!requireSuper(req, res)) return;
  const openid = String((req.body || {}).openid || '').trim();
  const enabled = !!(req.body || {}).enabled;
  if (!openid) return res.status(400).json({ error: '缺少 openid' });
  try {
    if (!enabled) {
      const cur = (await db.loadAdmins()).find((a) => a.openid === openid);
      if (cur && cur.role === 'super' && cur.enabled && (await db.countEnabledSupers()) <= 1) {
        return res.status(400).json({ error: '不能停用最后一个超级管理员' });
      }
    }
    await db.setAdminEnabled(openid, enabled);
    await refreshAdmins();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除员工
app.post('/api/admins/remove', async (req, res) => {
  if (!requireSuper(req, res)) return;
  const openid = String((req.body || {}).openid || '').trim();
  if (!openid) return res.status(400).json({ error: '缺少 openid' });
  try {
    const cur = (await db.loadAdmins()).find((a) => a.openid === openid);
    if (cur && cur.role === 'super' && cur.enabled && (await db.countEnabledSupers()) <= 1) {
      return res.status(400).json({ error: '不能删除最后一个超级管理员' });
    }
    await db.deleteAdmin(openid);
    await refreshAdmins();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= P2 · 客户 & 定向批量发放 =================

// 搜索客户（按备注名/昵称）——管理员
app.get('/api/customers', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  try {
    const q = String(req.query.q || '').trim();
    const searching = q.length > 0;
    // 搜索：全量匹配，一次返回，绝不截断（搜一个人搜不到很离谱）；仅在结果多到接近上限时提示精确化
    // 浏览：分页，避免一次塞几千客户
    const SEARCH_CAP = 500;
    const limit = searching ? SEARCH_CAP : Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = searching ? 0 : Math.max(Number(req.query.offset) || 0, 0);
    const [list, lastSyncAt] = await Promise.all([
      db.searchCustomers({
        q,
        followUserid: String(req.query.follow || '').trim(),
        viewerUserid: adminWecomUserid(getOpenid(req)), // 备注按操作员工个性化（''=未配企微账号，退回单值）
        limit,
        offset,
      }),
      db.getLastSyncAt().catch(() => null), // 上次同步时间：拿不到不影响列表
    ]);
    res.json({
      list,
      hasMore: !searching && list.length === limit, // 搜索不分页
      capped: searching && list.length >= SEARCH_CAP, // 搜索结果过多，提示精确化
      wecom: wecom.wecomEnabled,
      lastSyncAt, // 客户档案最近一次从企微同步的时间（null=从未同步）
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= 直连客户池（免企微模式的"客户列表"）=================
// 入池不动钱：真正的资金定向在发放时绑定到 rewards.target_openid。
// 池的来源：① 客户在小程序领取过奖励自动入池；② 管理员手动按 openid 添加
// （客户打开小程序空态页能看到自己的 openid 并一键复制，发给员工即可）。

// 列表/搜索（备注模糊 / openid 精确）——管理员
app.get('/api/direct-customers', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  try {
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const list = await db.listDirectCustomers({
      q: String(req.query.q || ''),
      limit,
      offset,
      // 企微身份桥的备注个性化：借来的企微备注优先显示查看者自己起的那份
      viewerUserid: adminWecomUserid(getOpenid(req)),
    });
    res.json({ list, hasMore: list.length === limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 添加/改备注（upsert by openid）——管理员
app.post('/api/direct-customers', async (req, res) => {
  const me = getOpenid(req);
  if (!isAdmin(me)) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  const openid = String((req.body || {}).openid || '').trim();
  const remark = String((req.body || {}).remark || '').trim();
  if (!openid) return res.status(400).json({ error: '请填写客户的 openid' });
  // 与员工管理同一套格式校验：openid 填错顶多是"发出去没人能领"（过期自动回流），不会错发给别人，
  // 但格式垃圾直接拦住
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(openid)) return res.status(400).json({ error: 'openid 格式不对' });
  try {
    await db.upsertDirectCustomer({ openid, remark, createdBy: me });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 从池里移除（只删名单，不影响历史奖励/台账）——管理员
app.post('/api/direct-customers/remove', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  const openid = String((req.body || {}).openid || '').trim();
  if (!openid) return res.status(400).json({ error: '缺少 openid' });
  try {
    const ok = await db.removeDirectCustomer(openid);
    res.json({ ok: !!ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 从企微同步客户入库——管理员（需配企微）。body.userids = 要同步的企微员工 userid 列表
// 大客户量防超时：单次最多跑 ~10s（客户端 callContainer 15s 超时，留足余量），
// 超时返回 { partial:true, nextIndex, nextCursor }，前端自动带回续传直到跑完。upsert 幂等，重跑无害。
app.post('/api/customers/sync', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  if (!wecom.wecomEnabled) return res.status(503).json({ error: '未配置企微（WECOM_CORPID/WECOM_CONTACT_SECRET）' });
  const DEADLINE_MS = 10_000;
  const startAt = Date.now();
  try {
    // 不传 userids 时，自动发现所有配置了「客户联系」的员工，全量同步
    const bodyUserids = Array.isArray((req.body || {}).userids) ? req.body.userids.filter(Boolean) : [];
    const explicit = bodyUserids.length > 0; // 指定子集同步：只动这些员工的行，收尾清理绝不越界
    let userids = bodyUserids;
    if (!userids.length) userids = await wecom.getFollowUserList();
    if (!userids.length) {
      return res.status(400).json({ error: '企微里没有配置「客户联系」的员工（请在企微后台把负责客户的员工加入客户联系使用范围）' });
    }
    const startIndex = Math.min(Math.max(Number((req.body || {}).startIndex) || 0, 0), userids.length);
    const startCursor = typeof (req.body || {}).cursor === 'string' ? req.body.cursor : '';
    // 各员工同步的起始水位（DB 时钟，跨 partial 续传由前端带回）：员工全量翻页完成后，
    // 删掉 synced_at 早于水位的行——企微本轮没再返回的 (客户,员工) 关系（转接/删除）连同旧备注退场。
    // 续传请求缺水位（老前端）时该员工跳过清理：宁可留旧行等下轮，不冒误删风险
    const startAtRaw = String((req.body || {}).uidStartAt || '');
    let uidStartAt = startCursor && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(startAtRaw) ? startAtRaw : '';
    let synced = 0;
    let pruned = 0;
    for (let i = startIndex; i < userids.length; i++) {
      const uid = userids[i];
      let cursor = i === startIndex ? startCursor : '';
      if (!cursor) uidStartAt = await db.getDbNow(); // 该员工从头拉：取新水位
      let guard = 0;
      do {
        if (Date.now() - startAt > DEADLINE_MS) {
          return res.json({ ok: true, partial: true, synced, nextIndex: i, nextCursor: cursor, uidStartAt, totalStaff: userids.length });
        }
        const d = await wecom.batchGetByUser([uid], cursor, 100);
        const contacts = (d.external_contact_list || [])
          .map((item) => wecom.normalizeContact(item))
          .filter((c) => c.externalUserid);
        // 10 个一批并发落库，比逐条 await 快一个数量级
        for (let j = 0; j < contacts.length; j += 10) {
          await Promise.all(contacts.slice(j, j + 10).map((c) => db.upsertCustomer(c)));
        }
        synced += contacts.length;
        cursor = d.next_cursor || '';
      } while (cursor && ++guard < 200);
      // cursor 耗尽 = 该员工全量翻页完成，可安全清理；guard 打满属于防御性中断，不清、留待下轮
      if (!cursor && uidStartAt) pruned += await db.pruneCustomerFollows(uid, uidStartAt);
    }
    // 自动发现全员的全量同步收尾：名单之外员工（离职/被移出「客户联系」）的跟进行整体退场
    if (!explicit) pruned += await db.pruneFollowsNotIn(userids);
    res.json({ ok: true, synced, pruned, totalStaff: userids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 小程序直达通知：给选中的定向客户直接推微信「服务通知」（订阅消息），点开直达领取页，
// 不经企微群发、员工无需再点发送。企微客户（externalUserids）需两个条件都满足：
//   ① 开过小程序（customers.openid 已回填）；② 此前在小程序点过「允许提醒」且授权还有余量。
// 直连客户（openids）openid 即身份，只需条件②。
// 其余客户按原因分列返回，前端引导走企微群发/转发兜底。配额先本地原子占用再调微信，
// 非配额类失败退回占用；微信回 43101（授权用尽/撤销）则对齐清零本地配额。
// 大批量防超时：服务端 8s 处理期限（callContainer 15s 上限内留足余量），到点把没处理的
// 放进 remaining 返回 partial，由前端自动续传——绝不让一个请求跑满超时后重试重发。
// 防重放：clientKey -> {at, promise}（处理中，等同一份结果）| {at, payload}（已完成，回放）。
// 结构同群发 deliverRecent：生命周期只跟 settle 挂钩，已 settle 条目 10 分钟过期
const miniNotifyRecent = new Map();
function pruneMiniNotify() {
  const now = Date.now();
  for (const [k, v] of miniNotifyRecent) {
    if (!v.promise && now - v.at > 10 * 60_000) miniNotifyRecent.delete(k);
  }
}
app.post('/api/notify-mini', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!weixin.subscribeEnabled) return res.status(503).json({ error: '订阅消息未配置（需 WECHAT_SUBSCRIBE_TEMPLATE_ID/WECHAT_SUBSCRIBE_DATA + 密钥或云托管开放接口）' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  const eus = Array.isArray((req.body || {}).externalUserids)
    ? [...new Set(req.body.externalUserids.filter(Boolean))]
    : [];
  // 双模式：直连客户按 openid 通知（openid 即身份，不查 customers 表）。两组可同请求混发
  const oids = Array.isArray((req.body || {}).openids)
    ? [...new Set(req.body.openids.filter(Boolean))]
    : [];
  if (!eus.length && !oids.length) return res.status(400).json({ error: '缺少要通知的客户' });
  if (eus.length + oids.length > 200) return res.status(400).json({ error: '单次最多通知 200 位客户' });
  const clientKey = String((req.body || {}).clientKey || '');
  const hasKey = /^[a-f0-9]{16,64}$/i.test(clientKey);
  if (hasKey) {
    pruneMiniNotify();
    const hit = miniNotifyRecent.get(clientKey);
    if (hit) {
      // 同键重试：处理中等同一份结果、已完成直接回放——同一步绝不给客户发第二条
      try {
        return res.json(hit.promise ? await hit.promise : hit.payload);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
  }
  const tid = config.weixin.subscribeTemplateId;
  const work = (async () => {
    const DEADLINE_MS = 8000;
    const startAt = Date.now();
    const [openidMap, pendingMap, pendingMapD] = await Promise.all([
      db.getCustomerOpenids(eus),
      db.pendingSummaryForTargets(eus),
      db.pendingSummaryForOpenidTargets(oids),
    ]);
    const noOpenid = []; // 没开过小程序：拿不到 openid，发不了（仅企微客户会落这里）
    const noPending = []; // 名下已无待领（已领完/已过期/已撤回）：不该再催
    const noQuota = []; // 没订阅过或授权次数用完
    const failed = []; // 微信侧发送失败（配额已退回，可重试）：{eu}|{openid} 标明身份类型
    const remaining = []; // 处理期限内没轮到的企微客户：前端带新键续传
    const remainingOpenids = []; // 处理期限内没轮到的直连客户（与 remaining 分列，老前端不受影响）
    let sent = 0;
    // 统一队列：企微客户在前、直连客户在后；到期各按身份类型归还续传名单
    const queue = [
      ...eus.map((id) => ({ kind: 'eu', id })),
      ...oids.map((id) => ({ kind: 'oid', id })),
    ];
    for (let i = 0; i < queue.length; i++) {
      const it = queue[i];
      if (Date.now() - startAt > DEADLINE_MS) {
        for (const rest of queue.slice(i)) (rest.kind === 'eu' ? remaining : remainingOpenids).push(rest.id);
        break;
      }
      // 直连客户 openid 即身份；企微客户需经 customers 表回填的 openid
      const openid = it.kind === 'eu' ? openidMap.get(it.id) : it.id;
      if (!openid) { noOpenid.push(it.id); continue; }
      const pending = it.kind === 'eu' ? pendingMap.get(it.id) : pendingMapD.get(it.id);
      if (!pending || !pending.n) { noPending.push(it.id); continue; }
      if (!(await db.consumeSubscribe(openid, tid))) { noQuota.push(it.id); continue; }
      const r = await weixin.sendRewardNotice({
        openid,
        remark: pending.remark,
        amountYuan: pending.fen / 100,
        count: pending.n,
      });
      if (r.ok) { sent++; continue; }
      if (r.quotaExhausted) {
        // 微信侧授权已用尽/被撤销：本地配额对齐清零，归入"未订阅"引导兜底
        await db.exhaustSubscribe(openid, tid).catch(() => {});
        noQuota.push(it.id);
      } else {
        await db.refundSubscribe(openid, tid).catch(() => {}); // 非配额失败：授权不白丢
        failed.push(it.kind === 'eu' ? { eu: it.id, error: r.error } : { openid: it.id, error: r.error });
      }
    }
    return {
      ok: true, sent, noOpenid, noPending, noQuota, failed,
      remaining, remainingOpenids,
      partial: remaining.length > 0 || remainingOpenids.length > 0,
    };
  })();
  if (hasKey) miniNotifyRecent.set(clientKey, { at: Date.now(), promise: work });
  try {
    const payload = await work;
    if (hasKey) miniNotifyRecent.set(clientKey, { at: Date.now(), payload });
    res.json(payload);
  } catch (e) {
    if (hasKey) miniNotifyRecent.delete(clientKey); // 整体失败不缓存：重试重新执行
    res.status(500).json({ error: e.message });
  }
});

// 企微群发通知：给选中的客户发一条文案（跟进员工需在企微确认发送）。
// 企微硬性语义：不传 sender 时，任务派给客户跟进人里「最后聊过天」的那个，与谁点按钮无关——
// 客户加了多个员工时任务会漂移（A 发起、任务落到 B）。所以这里按跟进关系分组、逐组带 sender：
//   发起人跟进的客户 → 派给发起人；其他客户 → 派给各自跟进人；查不到跟进关系 → 交企微默认派发。
// 群发防重表：clientKey -> {at, payload}（已完成，回放）| {at, promise}（处理中，等待）
// | {at, indeterminate}（提交结果未知，拦截盲目重试）。三类条目统一 10 分钟过期——
// 包括万一悬死的 in-flight（所有企微外呼均有超时，悬死只在有 bug 时发生，过期是兜底）
const deliverRecent = new Map();
function pruneDeliver() {
  const now = Date.now();
  // 只清理已 settle 的条目（回放缓存/拦截位，10 分钟过期）。in-flight 一律不碰：
  // 处理端自带 120s 总预算，必然在有限时间内 settle 并替换/清理自己的条目——
  // 任何"按时间窗猜测存活性"的清理都会留下被撞上边界后并行执行的口子，
  // 此前 10/30 分钟两版时间窗策略先后被评审击穿，教训是生命周期只跟 settle 挂钩、不跟钟表挂钩
  for (const [k, v] of deliverRecent) {
    if (!v.promise && now - v.at > 10 * 60_000) deliverRecent.delete(k);
  }
}
app.post('/api/deliver', async (req, res) => {
  const openid = getOpenid(req);
  if (!isAdmin(openid)) return res.status(403).json({ error: '无权限' });
  if (!wecom.wecomEnabled) return res.status(503).json({ error: '未配置企微，无法群发（可让员工手动转发小程序给客户）' });
  // 去重：拆单后同一客户会出现多次，群发每人只该收到一张卡片
  const externalUserids = Array.isArray((req.body || {}).externalUserids)
    ? [...new Set(req.body.externalUserids.filter(Boolean))]
    : [];
  if (!externalUserids.length) return res.status(400).json({ error: '请选择要通知的客户' });
  // 上限：批量发放单次 ≤200 人，正常流量到不了这里；不设上限的话派发组数无界，
  // 单请求执行时长也随之无界，防重条目的"必然 settle"保证会被击穿
  if (externalUserids.length > 400) {
    return res.status(400).json({ error: '单次群发最多 400 位客户，请分批发送' });
  }
  const ckRaw = String((req.body || {}).clientKey || '');
  const clientKey = /^[a-f0-9]{16,64}$/i.test(ckRaw) ? ckRaw.toLowerCase() : '';
  if (clientKey) {
    pruneDeliver();
    const hit = deliverRecent.get(clientKey);
    if (hit) {
      if (hit.payload) return res.json({ ...hit.payload, duplicate: true });
      if (hit.indeterminate) {
        // 上一次提交结果未知（超时/响应丢失，企微可能已建任务）：拦下盲目重试防重复打扰客户
        return res.status(409).json({
          error: '上一次群发提交结果未知（可能已创建任务）：请先到企微「客户联系」确认是否已有本次群发；10 分钟后可重试，或用「转发领取入口」补发',
          resultUnknown: true,
        });
      }
      // 同键请求仍在处理中（多组派发超过客户端 15s 超时后的重试恰好撞上）：
      // 等原请求完成后回放结果，绝不并行执行第二遍——这正是防重要堵的竞态窗口。
      // 最多等 30s（所有企微外呼均有超时，正常一定会settle）；等不到不动预占，让调用方稍后再来
      let timer;
      try {
        const payload = await Promise.race([
          hit.promise,
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('PENDING_TIMEOUT')), 30_000); }),
        ]);
        clearTimeout(timer);
        return res.json({ ...payload, duplicate: true });
      } catch (e) {
        clearTimeout(timer);
        if (e && e.message === 'PENDING_TIMEOUT') {
          return res.status(503).json({ error: '上一次群发仍在处理中，请稍后再试' });
        }
        return res.status(500).json({ error: '上一次群发提交失败，请重试' });
      }
    }
  }
  // 预占：外呼企微前先把键登记为 in-flight，并发同键请求只能等待上面那条路
  let settleOk = null;
  let settleErr = null;
  if (clientKey) {
    const pending = new Promise((resolve, reject) => { settleOk = resolve; settleErr = reject; });
    pending.catch(() => {}); // 没有等待方时不产生 unhandledRejection
    deliverRecent.set(clientKey, { at: Date.now(), promise: pending });
  }
  const text = String((req.body || {}).text || '').trim() ||
    '你有一笔奖励待领取，请打开我们的小程序查看～';
  try {
    const base = {
      chat_type: 'single',
      text: { content: text.slice(0, 600) },
    };
    // 带上小程序卡片：客户点开卡片直达领取页（按 unionid 认出本人、显示他那一笔），
    // 不用再让客户去搜索小程序名字。封面上传失败则自动降级为纯文字群发，不阻断。
    let withCard = false;
    try {
      const picMediaId = await wecom.getCardCoverMediaId(cardCover());
      base.attachments = [
        {
          msgtype: 'miniprogram',
          miniprogram: {
            title: String((req.body || {}).cardTitle || '梨响ROC · 奖励待领取').slice(0, 64),
            pic_media_id: picMediaId,
            appid: config.wechatpay.appid, // = 小程序 AppID，须已关联到企微
            page: 'pages/claim/claim.html', // 企微卡片 page 必须带 .html，否则打开报"页面不存在"
          },
        },
      ];
      withCard = true;
    } catch (e) {
      console.error('[wecom] 群发卡片封面上传失败，降级为纯文字：', e.code || e.message);
    }

    // 按 sender 分组。'' 组 = 查不到跟进关系，交企微默认派发（旧行为兜底）
    const senderUid = adminWecomUserid(openid);
    const followMap = db.dbEnabled
      ? await db.getFollowMap(externalUserids).catch(() => new Map())
      : new Map();
    const groups = new Map();
    for (const eu of externalUserids) {
      const fus = followMap.get(eu) || [];
      let s = '';
      if (senderUid && fus.includes(senderUid)) s = senderUid; // 发起人自己跟进的 → 派给发起人
      else if (fus.length) s = [...fus].sort()[0]; // 其他 → 固定取字典序第一个跟进人，派发确定可预期
      // 本地查不到跟进关系（多为客户档案未同步）：兜底派给发起人本人——
      // 宁可显式失败（企微判定非跟进人会进 fail_list，前端看得见、可同步后重试），
      // 也不交企微默认派发：那会把任务黑箱漂移到"最近聊过天"的员工那里，
      // 他不知道要去点【发送】，客户收不到，发起人还以为群发没问题
      else s = senderUid;
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(eu);
    }

    const tasks = [];
    const errors = [];
    const failList = [];
    // 总预算：保证本请求必然在有限时间内 settle（防重条目生命周期依赖这一点）。
    // 超预算的组不提交、按"确定失败（未提交，可安全重试）"入重试名单
    const DELIVER_BUDGET_MS = 120_000;
    const startAt = Date.now();
    for (const [s, list] of groups) {
      if (!s) {
        // 派发员工无法确定（发起人未配企微账号 + 客户跟进关系未同步）：显式失败并计入
        // 可重试名单，而不是提交"企微默认派发"——那会漂移到"最近聊天"的员工，无人点发送
        errors.push({ sender: '', count: list.length, error: '未能确定派发员工：请先「从企微同步」刷新跟进关系，或让超管为发起人配置企微账号' });
        failList.push(...list);
        console.warn(`[wecom] 群发跳过 ${list.length} 位客户：无跟进关系且发起人未配置企微账号`);
        continue;
      }
      if (Date.now() - startAt > DELIVER_BUDGET_MS) {
        // 超总预算：该组未提交（确定失败，可安全重试），只记录不再外呼——settle 有界的保证所在
        errors.push({ sender: s, count: list.length, error: '本次处理超时，该组未提交，可直接重试' });
        failList.push(...list);
        console.warn(`[wecom] 群发超预算跳过 sender=${s} 客户=${list.length}`);
        continue;
      }
      const body = { ...base, external_userid: list, sender: s };
      try {
        const r = await wecom.addMsgTemplate(body);
        const fails = r.fail_list || [];
        failList.push(...fails);
        tasks.push({
          sender: s,
          senderSelf: s === senderUid,
          count: list.length,
          failCount: fails.length,
          msgid: r.msgid || '',
        });
        console.log(
          `[wecom] 群发任务已创建 sender=${s} 客户=${list.length} 失败=${fails.length} msgid=${r.msgid || ''}`
        );
      } catch (e) {
        // 企微带 errcode = 明确拒绝；preSubmit = 取 token 阶段失败、请求根本没发出——
        // 两者任务都确定没建，客户进重试名单可安全重发。
        // 只有"请求已发出但超时/网络中断/非 JSON 响应" = 提交结果未知，任务可能已建——
        // 不进重试名单，防重复打扰
        const determinate = !!e.errcode || !!e.preSubmit;
        errors.push({ sender: s, count: list.length, error: e.message, indeterminate: !determinate });
        if (determinate) failList.push(...list);
        console.error(`[wecom] 群发任务创建失败 sender=${s} 客户=${list.length} 结果${determinate ? '确定' : '未知'}：`, e.message);
      }
    }
    if (!tasks.length) {
      const anyIndet = errors.some((er) => er.indeterminate);
      const msg =
        '群发任务全部创建失败：' + ((errors[0] || {}).error || '未知错误') +
        (anyIndet ? '。部分提交结果未知（可能已创建任务）：请先到企微「客户联系」确认，10 分钟内重试会被拦截' : '');
      if (clientKey) {
        if (anyIndet) {
          // 结果未知不释放：保留拦截位（10 分钟过期），同键盲目重试会被上面的 409 挡住
          deliverRecent.set(clientKey, { at: Date.now(), indeterminate: true });
        } else {
          deliverRecent.delete(clientKey); // 明确失败才释放预占：同键重试可真正重新执行
        }
        settleErr(new Error(msg));
      }
      return res.status(500).json({ error: msg, resultUnknown: anyIndet || undefined });
    }
    const payload = {
      ok: true,
      withCard,
      senderConfigured: !!senderUid, // 发起人是否已配置企微账号映射
      tasks,
      errors,
      failCount: failList.length,
      failList,
      msgid: tasks[0].msgid, // 旧版小程序兼容字段
    };
    if (clientKey) {
      deliverRecent.set(clientKey, { at: Date.now(), payload });
      settleOk(payload); // 唤醒并发等待的同键请求
      pruneDeliver();
    }
    res.json(payload);
  } catch (e) {
    if (clientKey) {
      deliverRecent.delete(clientKey); // 失败释放预占：同键重试可真正重新执行
      if (settleErr) settleErr(e);
    }
    console.error('[wecom] /api/deliver 异常：', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 批量定向发放（每人可不同金额/备注）——管理员。需数据库（定向靠库落地）
app.post('/api/rewards/batch', async (req, res) => {
  const openid = getOpenid(req);
  if (!isAdmin(openid)) return res.status(403).json({ error: '无权限：仅管理员可发放' });
  if (!db.dbEnabled) return res.status(503).json({ error: '定向批量发放需要数据库（配置 MYSQL_* 后可用）' });

  const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: '没有要发放的项目' });
  if (items.length > 200) return res.status(400).json({ error: '单次最多 200 人' });

  // 幂等键：前端为一次发放意图生成随机键，重试（超时后的手动重发）复用同一键。
  // 命中已建批次直接回放原结果——从根上杜绝"客户端判失败重发 → 整批重复建单 → 客户领双份"的资损面
  const ckRaw = String((req.body || {}).clientKey || '');
  const clientKey = /^[a-f0-9]{16,64}$/i.test(ckRaw) ? ckRaw.toLowerCase() : '';
  const batchId = clientKey ? clientKey.slice(0, 32) : newRid();
  if (clientKey) {
    const existing = await db.listBatchRewards(batchId).catch(() => []);
    if (existing.length) {
      return res.json({
        createdCount: existing.length,
        // 双模式：目标可能是企微客户(external_userid)或直连客户(openid)，按各自 ID 去重计人数
        peopleCount: new Set(existing.map((r) => r.target_external_userid || r.target_openid)).size,
        errorCount: 0,
        batchId,
        duplicate: true, // 此前已创建成功，这是原结果回放，未重复建单
        created: existing.map((r) => ({
          rid: r.rid,
          externalUserid: r.target_external_userid || undefined,
          openid: r.target_openid || undefined,
          amountYuan: r.amount_fen / 100,
          remark: r.remark || '',
        })),
        people: [],
        errors: [],
      });
    }
  }

  // 大额自动拆单：单人金额超过微信单笔限额时拆成多笔（200×6+160），客户逐笔确认串行到账。
  // 单人总额受微信「单日向单用户」上限约束——拆单绕不过这条线，直接前置拦截
  const capFen = Math.round(config.app.splitCapYuan * 100);
  const minFen = Math.round(config.app.minAmountYuan * 100);
  const perUserCapYuan = Math.min(config.app.perUserDailyCapYuan, config.app.maxAmountYuan);

  // 先整体校验并算出拆单计划，再落库——避免拆一半发现超限。
  // 双模式目标：每项二选一——externalUserid(企微客户，领取走 unionid 桥) 或 openid(直连客户，
  // 领取按 openid 直查)。两个都传/都不传都拒绝：一笔钱必须有唯一明确的定向语义
  const plans = [];
  const errors = [];
  let totalBills = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const targetEu = String(it.externalUserid || '').trim();
    const targetOid = String(it.openid || '').trim();
    const target = targetEu || targetOid; // 报错定位用（errors[].target）
    const yuan = Number(it.amountYuan);
    if (!targetEu && !targetOid) {
      errors.push({ i, error: '缺少发放对象（externalUserid 或 openid）' });
      continue;
    }
    if (targetEu && targetOid) {
      errors.push({ i, target, error: '发放对象只能二选一（企微客户或直连 openid）' });
      continue;
    }
    if (targetOid && !/^[A-Za-z0-9_-]{6,64}$/.test(targetOid)) {
      errors.push({ i, target, error: 'openid 格式不对' });
      continue;
    }
    if (!(yuan > 0)) {
      errors.push({ i, target, error: '金额必须大于 0' });
      continue;
    }
    if (yuan < config.app.minAmountYuan) {
      errors.push({ i, target, error: `金额不能小于 ${config.app.minAmountYuan} 元` });
      continue;
    }
    if (yuan > perUserCapYuan) {
      errors.push({ i, target, error: `单人不能超过 ${perUserCapYuan} 元（微信单日向单用户转账上限，拆单也绕不过）` });
      continue;
    }
    const bills = splitAmountFen(Math.round(yuan * 100), capFen, minFen);
    const itNameErr = nameRuleError(bills[0] / 100, it.name); // 拆后每笔 ≤ 单笔限额，按最大一笔校验姓名规则
    if (itNameErr) {
      errors.push({ i, target, error: itNameErr });
      continue;
    }
    totalBills += bills.length;
    plans.push({ i, target, targetEu, targetOid, yuan, bills, remark: it.remark, name: it.name });
  }
  if (totalBills > 400) {
    return res.status(400).json({ error: `本批拆单后共 ${totalBills} 笔，超过单次 400 笔上限，请分批发放` });
  }

  const created = [];
  const people = []; // 每人汇总：{externalUserid, totalYuan, bills}
  // batchId：拆单后的所有笔共用，台账按批查看/按批撤回的锚点（clientKey 模式下即幂等键本身）
  for (const p of plans) {
    // 整体取整，与 createRewardToken 的 exp 口径一致（TTL 允许小数）
    const exp = Math.floor(Date.now() / 1000 + config.app.rewardTtlHours * 3600);
    let ok = 0;
    for (let j = 0; j < p.bills.length; j++) {
      const billFen = p.bills[j];
      // clientKey 模式下 rid 由批次键+条目序号确定性派生：极端并发下同一批被处理两次，
      // 也只会 upsert 同一套 rid（主键去重），绝不会长出第二套单
      const rid = clientKey
        ? crypto.createHash('sha256').update(`${batchId}:${p.i}:${j}`).digest('hex').slice(0, 32)
        : newRid();
      try {
        await db.saveReward({
          rid,
          amountFen: billFen,
          remark: p.remark,
          name: p.name,
          createdBy: openid,
          exp,
          targetExternalUserid: p.targetEu || undefined,
          targetOpenid: p.targetOid || undefined,
          batchId,
        });
        created.push({
          rid,
          externalUserid: p.targetEu || undefined,
          openid: p.targetOid || undefined,
          amountYuan: billFen / 100,
          remark: p.remark || '',
        });
        ok++;
      } catch (e) {
        errors.push({ i: p.i, target: p.target, error: `落库失败（已成功 ${ok}/${p.bills.length} 笔）：` + (e.code || e.message) });
        break; // 这个人剩余的笔不再继续，已落库的仍有效可领
      }
    }
    if (ok > 0) people.push({ externalUserid: p.targetEu || undefined, openid: p.targetOid || undefined, totalYuan: p.yuan, bills: ok });
  }
  res.json({
    createdCount: created.length, // 拆单后的总笔数
    peopleCount: people.length,
    errorCount: errors.length,
    batchId: created.length ? batchId : '', // 一笔都没落库就不返回批次号
    created,
    people,
    errors,
  });
});

// 【员工】按批撤回：一次确认撤掉整批里所有还没到账的（发错一批不用 30 次逐条点）。
// 逐笔处理：未领取(CREATED)直接作废；已领待确认(CLAIMED)向微信撤销资金回流；
// 已到账/已终结跳过不动。逐笔回执，部分失败不回滚已成功的（撤回本就是幂等安全操作）。
app.post('/api/rewards/batch/revoke', async (req, res) => {
  const openid = getOpenid(req);
  if (!isAdmin(openid)) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  const batchId = String((req.body || {}).batchId || '').trim();
  if (!batchId) return res.status(400).json({ error: '缺少 batchId' });
  try {
    const rows = await db.listBatchRewards(batchId);
    if (!rows.length) return res.status(404).json({ error: '找不到该批次' });
    let revoked = 0; // 未领取，直接作废
    let canceled = 0; // 已发起转账，向微信撤销
    let skipped = 0; // 已到账/已终结，不动
    const errors = [];
    for (const r of rows) {
      try {
        if (r.status === 'CREATED') {
          (await db.revokeReward(r.rid, openid)) ? revoked++ : skipped++; // 撤的瞬间被领走 → 跳过
        } else if (r.status === 'CLAIMED') {
          const data = await cancelTransferByOutBillNo(r.rid);
          await db.updateTransferState({
            outBillNo: r.rid,
            state: data.state || 'CANCELING',
            transferBillNo: data.transfer_bill_no,
          });
          persist('markRevoked(batch)', () => db.markRevoked(r.rid, openid)); // 审计：谁发起的整批撤回
          canceled++;
        } else {
          skipped++;
        }
      } catch (e) {
        errors.push({ rid: r.rid, error: e.message });
      }
    }
    res.json({ ok: true, total: rows.length, revoked, canceled, skipped, errors });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.data });
  }
});

// 【客户】查我的定向奖励（身份匹配，防领错）
app.get('/api/claim/mine', async (req, res) => {
  const openid = getOpenid(req);
  const unionid = getUnionid(req);
  if (!openid) return res.status(401).json({ error: '请在微信小程序内打开' });
  if (!db.dbEnabled) return res.json({ reward: null, reason: 'no_db' });
  try {
    // 双模式定向：先查「直连」（奖励直接绑我的 openid，无需任何身份桥，最快最稳），
    // 再走「企微」老路（unionid → external_userid 桥）。两池的待领汇总合并展示，
    // 逐笔领取时 GET 每次都会重查，两个池会被串行领完。
    // ---- 直连池（openid 直查，零外部依赖）----
    const aggD = await db.countPendingRewardsForOpenid(openid).catch(() => ({ n: 0, fen: 0 }));
    // ---- 企微池（身份桥可能不通：不通只是企微池不可见，不影响直连池）----
    // 首页自动探测：本地库优先（快），未命中再走企微在线转换兜底（已带 6s 超时，不会拖死）。
    const externalUserid = await resolveCustomer(unionid, openid);
    const aggW = externalUserid
      ? await db.countPendingRewardsForTarget(externalUserid).catch(() => ({ n: 0, fen: 0 }))
      : { n: 0, fen: 0 };
    const agg = { n: aggD.n + aggW.n, fen: aggD.fen + aggW.fen };
    // 优先续办「已领取待确认」的在途单：转账已发起、资金已冻结，重开确认页即可到账。
    // 此前这种单重进后会被当成"没有待领奖励"，客户卡死到微信超时关单
    const resumable =
      (await db.findResumableTransferForOpenid(openid).catch(() => null)) ||
      (externalUserid ? await db.findResumableTransferForTarget(externalUserid, openid).catch(() => null) : null);
    if (resumable) {
      return res.json({
        reward: { rid: resumable.rid, amountYuan: resumable.amount_fen / 100, remark: resumable.remark },
        resume: {
          package_info: resumable.package_info,
          transfer_bill_no: resumable.transfer_bill_no || '',
          mchId: config.wechatpay.mchid,
          appId: config.wechatpay.appid,
        },
        // 待领汇总只算 CREATED，这笔在途单要补进去，"共 N 笔"才对得上
        pending: { count: agg.n + 1, totalYuan: (agg.fen + resumable.amount_fen) / 100 },
      });
    }
    const r =
      (await db.findPendingRewardForOpenid(openid)) ||
      (externalUserid ? await db.findPendingRewardForTarget(externalUserid) : null);
    if (!r) {
      // 空态原因只在「确实可能有企微定向但身份没接上」时给企微向的提示；
      // 纯直连模式（未配企微）不该拿"加企业微信好友"误导客户
      const reason = !externalUserid && wecom.wecomEnabled ? (unionid ? 'not_a_customer' : 'no_unionid') : 'no_pending';
      return res.json({ reward: null, reason });
    }
    res.json({
      reward: { rid: r.rid, amountYuan: r.amount_fen / 100, remark: r.remark },
      pending: { count: agg.n, totalYuan: agg.fen / 100 },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 【客户】领取我的定向奖励：核对身份 → 发起转账到本人
app.post('/api/claim/mine', async (req, res) => {
  const openid = getOpenid(req);
  const unionid = getUnionid(req);
  if (!openid) return res.status(401).json({ error: '请在微信小程序内打开' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  try {
    // 双模式：先取直连池（奖励的 target_openid == 我的 openid，查询条件即身份校验，无桥可错），
    // 直连池空再走企微池老路。找到哪笔就发哪笔——转账收款人恒为当前请求者本人的 openid
    let r = await db.findPendingRewardForOpenid(openid);
    if (!r) {
      const externalUserid = await resolveCustomer(unionid, openid);
      if (!externalUserid) return res.status(403).json({ error: '未识别到你的客户身份，无法领取' });
      r = await db.findPendingRewardForTarget(externalUserid);
    }
    if (!r) return res.status(404).json({ error: '没有属于你的待领奖励' });
    const result = await createTransferBill({
      outBillNo: r.rid, // 幂等：重复领取不重复付款
      openid,
      amountFen: r.amount_fen,
      remark: r.remark,
      name: r.recipient_name || undefined,
    });
    await persistCritical('recordClaim(mine)', () =>
      db.recordClaim({
        rid: r.rid,
        claimerOpenid: openid,
        amountFen: r.amount_fen,
        remark: r.remark,
        name: r.recipient_name,
        exp: null,
        transferBillNo: result.transfer_bill_no,
        state: result.state,
        packageInfo: result.package_info,
      })
    );
    persist('touchDirectCustomer(mine)', () => db.touchDirectCustomer(openid)); // 领取者自动入直连客户池
    res.json({
      state: result.state,
      package_info: result.package_info,
      transfer_bill_no: result.transfer_bill_no,
      out_bill_no: result.out_bill_no,
      mchId: config.wechatpay.mchid,
      appId: config.wechatpay.appid,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.data });
  }
});

// unionid → external_userid（定向身份桥）。
// 优先查本地 customers（企微同步后就有 unionid，快且不依赖企微在线）；
// 查不到再调企微转换接口。命中后回填 openid 到客户档案。
async function resolveCustomer(unionid, openid) {
  if (!unionid) return null;
  let externalUserid = await db.findCustomerByUnionid(unionid).catch(() => null);
  if (!externalUserid && wecom.wecomEnabled) {
    externalUserid = await wecom.unionidToExternalUserid(unionid, openid).catch(() => null);
  }
  if (externalUserid) await db.bindCustomerByUnionid(unionid, openid).catch(() => {});
  return externalUserid;
}

// 【客户】链接领取前置校验（只读，不发起任何转账）：
// 领取页进入即调，金额/备注以这里返回的令牌载荷为准（URL 的 amt 参数任何人都能改，只配当兜底展示）；
// 已过期/已撤回/已到账/定向 直接返回终态，前端不再出现"先渲染领取块、点了才报错"的倒置流程。
// CLAIMED（已发起待确认）不拦：同一领取人重开确认页是合法路径，他人误点由 POST /api/claim 兜底报错。
app.get('/api/claim/status', async (req, res) => {
  let payload;
  try {
    payload = verifyRewardToken(String(req.query.token || ''));
  } catch (e) {
    const state = /过期/.test(e.message) ? 'EXPIRED' : 'INVALID';
    return res.json({ state, error: e.message });
  }
  let state = 'VALID';
  if (db.dbEnabled) {
    try {
      const rw = await db.getReward(payload.rid);
      if (rw) {
        if (rw.status === 'CANCELLED') state = 'CANCELLED';
        else if (rw.status === 'SUCCESS') state = 'SUCCESS';
        else if (rw.target_external_userid || rw.target_openid) state = 'TARGETED'; // 两种定向同等拦截
      }
    } catch (_) {
      /* 查库失败按可领处理：点领取时 POST /api/claim 仍有全量强校验兜底 */
    }
  }
  res.json({ state, amountYuan: payload.fen / 100, remark: payload.remark || '' });
});

// 【客户】领取：发起转账，返回 package_info 供小程序拉起确认页
app.post('/api/claim', async (req, res) => {
  const openid = getOpenid(req);
  if (!openid) return res.status(401).json({ error: '无法识别用户身份，请在微信小程序内打开' });

  let payload;
  try {
    payload = verifyRewardToken((req.body || {}).token);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // 定向奖励(P2)只能由本人在小程序内按身份领取，禁止用令牌绕过（防领错）；
  // 已撤回(CANCELLED)的奖励令牌同样作废
  if (db.dbEnabled) {
    try {
      const rw = await db.getReward(payload.rid);
      if (rw && rw.status === 'CANCELLED') {
        return res.status(410).json({ error: '这笔奖励已被发放方撤回' });
      }
      if (rw && (rw.target_external_userid || rw.target_openid)) {
        // 定向奖励（企微定向或直连定向）只能由目标本人按身份领取，令牌路径一律拒绝（防冒领）
        return res.status(403).json({ error: '这是定向奖励，请由指定客户在小程序内领取' });
      }
    } catch (_) {
      /* 查不到就按普通流程走 */
    }
  }

  try {
    const result = await createTransferBill({
      outBillNo: payload.rid, // 用 rid 作商户单号：天然幂等，重复领取不会重复付款
      openid,
      amountFen: payload.fen,
      remark: payload.remark,
      name: payload.name || undefined,
    });
    await persistCritical('recordClaim', () =>
      db.recordClaim({
        rid: payload.rid,
        claimerOpenid: openid,
        amountFen: payload.fen,
        remark: payload.remark,
        name: payload.name,
        exp: payload.exp,
        transferBillNo: result.transfer_bill_no,
        state: result.state,
        packageInfo: result.package_info,
      })
    );
    persist('touchDirectCustomer(claim)', () => db.touchDirectCustomer(openid)); // 领取者自动入直连客户池
    res.json({
      state: result.state, // 一般是 WAIT_USER_CONFIRM
      package_info: result.package_info,
      transfer_bill_no: result.transfer_bill_no,
      out_bill_no: result.out_bill_no,
      mchId: config.wechatpay.mchid, // 前端 wx.requestMerchantTransfer 需要
      appId: config.wechatpay.appid,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.data });
  }
});

// 查询转账单状态（对账/排查）——管理员或对账 ?key=；含收款人 openid/金额，不可匿名访问
app.get('/api/transfers/:outBillNo', async (req, res) => {
  if (!isAdmin(getOpenid(req)) && !keyMatches(req.query.key)) {
    return res.status(403).json({ error: '无权限：小程序内管理员访问，或带 ?key=REWARD_TOKEN_SECRET' });
  }
  try {
    const data = await queryTransferByOutBillNo(req.params.outBillNo);
    // 顺手用最新状态回写库（对账自愈；带 openid+金额，行缺失也能补齐）
    persist('updateTransferState(query)', () =>
      db.updateTransferState({
        outBillNo: data.out_bill_no || req.params.outBillNo,
        state: data.state,
        transferBillNo: data.transfer_bill_no,
        failReason: data.fail_reason,
        claimerOpenid: data.openid,
        amountFen: data.transfer_amount,
      })
    );
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, detail: e.data });
  }
});

// 商家转账异步回调：验签 + 解密
app.post('/api/notify', async (req, res) => {
  try {
    const ok = await wechatpay.verifySignature({
      timestamp: req.headers['wechatpay-timestamp'],
      nonce: req.headers['wechatpay-nonce'],
      signature: req.headers['wechatpay-signature'],
      serial: req.headers['wechatpay-serial'],
      body: req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body),
    });
    if (!ok) return res.status(401).json({ code: 'FAIL', message: '签名验证失败' });

    const decrypted = JSON.parse(wechatpay.decryptAesGcm(req.body.resource));
    console.log('[notify]', req.body.event_type, decrypted.out_bill_no, decrypted.state);

    // 审计流水：尽力而为，不影响回执
    persist('saveNotifyEvent', () =>
      db.saveNotifyEvent({
        eventType: req.body.event_type,
        outBillNo: decrypted.out_bill_no,
        transferBillNo: decrypted.transfer_bill_no,
        state: decrypted.state,
        raw: decrypted,
      })
    );

    // 状态回写是账本关键：改为「同步落库」，失败就回 FAIL 让微信按策略重试（至少一次），
    // 避免一次 DB 抖动导致状态永久丢失。DB 未开启则跳过、直接回 SUCCESS。
    if (db.dbEnabled) {
      try {
        await db.updateTransferState({
          outBillNo: decrypted.out_bill_no,
          state: decrypted.state,
          transferBillNo: decrypted.transfer_bill_no,
          failReason: decrypted.fail_reason,
          claimerOpenid: decrypted.openid,
          amountFen: decrypted.transfer_amount,
        });
      } catch (e) {
        console.error('[notify] 状态落库失败，回 FAIL 让微信稍后重试：', e.code || e.message);
        return res.status(500).json({ code: 'FAIL', message: '业务处理失败，请重试' });
      }
    }
    res.json({ code: 'SUCCESS' });
  } catch (e) {
    console.error('[notify] 处理失败', e);
    res.status(500).json({ code: 'FAIL', message: e.message });
  }
});

// ---- 自动对账：定时把"在途/未终态"的转账用微信侧最新状态刷新 ----
// 作用：① 没配回调(WECHATPAY_NOTIFY_URL)也能追平到账状态；② 回调偶发丢失能兜底；
// ③ 领取时 recordClaim 万一没写上，微信侧查到的单也会把 CLAIMED/终态补回，台账自愈。
let reconciling = false;
async function reconcileTransfers() {
  if (!db.dbEnabled || reconciling) return;
  reconciling = true;
  try {
    const bills = await db.listUnfinishedTransfers(20);
    for (const outBillNo of bills) {
      try {
        const data = await queryTransferByOutBillNo(outBillNo);
        await db.updateTransferState({
          outBillNo: data.out_bill_no || outBillNo,
          state: data.state,
          transferBillNo: data.transfer_bill_no,
          failReason: data.fail_reason,
          claimerOpenid: data.openid,
          amountFen: data.transfer_amount,
        });
      } catch (_) {
        /* 单笔查询失败跳过，下一轮再试 */
      }
    }
  } catch (e) {
    console.error('[reconcile] 自动对账失败：', e.code || e.message);
  } finally {
    reconciling = false;
  }
}

app.listen(config.port, async () => {
  console.log(`✅ 服务已启动，监听端口 ${config.port}`);
  if (db.dbEnabled) {
    setTimeout(reconcileTransfers, 60_000); // 启动 1 分钟后先跑一轮
    setInterval(reconcileTransfers, 10 * 60_000); // 之后每 10 分钟一轮
  }
  if (db.dbEnabled) {
    if (config.db.autoMigrate) {
      try {
        await db.migrate();
        await refreshAdmins();
        console.log('✅ 数据库已连接，业务表已就绪（rewards / transfers / notify_events / admins）');
      } catch (e) {
        console.error('⚠️ 自动建表失败（服务仍可运行，落库会被跳过）：', e.code || e.message);
      }
    } else {
      console.log('ℹ️ 已配置数据库，但 DB_AUTO_MIGRATE=false，请手动执行 db/schema.sql');
      await refreshAdmins();
    }
  } else {
    if (config.db.partialConfig) {
      console.warn(
        '⚠️ 检测到部分 MySQL 配置（MYSQL_USER/PASSWORD/DATABASE），但缺少 MYSQL_HOST 或 MYSQL_URL —— ' +
          '当前仍是无状态模式、不会落库。要开库请补上 MYSQL_HOST（或改用 MYSQL_URL）后重发。'
      );
    }
    console.log('ℹ️ 未配置 MYSQL_*，运行在无状态模式（不落库）');
  }
});
