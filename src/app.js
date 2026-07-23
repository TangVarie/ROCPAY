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
import { verifyUrl, callbackEnabled } from './wecom-callback.js';

const app = express();

// 部署校验标记：每次改动会 bump，/api/health 会回显它，用来确认线上跑的是哪版代码
const BUILD = 'p4-ledger-pro';

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
    for (const a of rows) m.set(a.openid, { role: a.role, enabled: a.enabled });
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
const LEVELS = [
  { lv: 1, name: '新伙伴', minCount: 1, minFen: 0 },
  { lv: 2, name: '熟客', minCount: 3, minFen: 20000 },
  { lv: 3, name: '金牌伙伴', minCount: 10, minFen: 100000 },
  { lv: 4, name: '钻石伙伴', minCount: 30, minFen: 500000 },
];
function levelOf(count, fen) {
  let cur = { lv: 0, name: '初识' };
  for (const L of LEVELS) {
    if (count >= L.minCount || (L.minFen > 0 && fen >= L.minFen)) cur = L;
  }
  const next = LEVELS.find((L) => L.lv === cur.lv + 1) || null;
  return {
    lv: cur.lv,
    name: cur.name,
    next: next
      ? { name: next.name, needCount: Math.max(0, next.minCount - count), needYuan: next.minFen > 0 ? Math.max(0, (next.minFen - fen) / 100) : null }
      : null,
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
    wecom: wecom.wecomEnabled, // 企微是否已连接（前端据此提示）
    db: db.dbEnabled,
    profile,
  });
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
  try {
    // 事务 + 行锁（db.adjustQuota）：两位管理员同时充值也不会丢任何一笔
    await db.adjustQuota({ mode, amountFen: amtFen });
    res.json(await computeQuota());
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
  const nameErr = nameRuleError(yuan, name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  const fen = Math.round(yuan * 100);
  try {
    const { token, rid, exp } = createRewardToken({ fen, remark, name });
    persist('saveReward', () =>
      db.saveReward({ rid, amountFen: fen, remark, name, createdBy: openid, exp })
    );
    res.json({ token, rid, exp, amountYuan: yuan, remark });
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
    // 台账筛选：status=created|waiting|success|failed，days=近N天，target=某客户（单人往来）
    // 列表和 stats 用同一组筛选 → stats 即"筛选范围内的资金消耗汇总"
    const filters = {
      status: String(req.query.status || 'all'),
      days: Number(req.query.days) || 0,
      target: String(req.query.target || ''),
    };
    const [list, stats] = await Promise.all([
      db.listRewards({ limit, offset, ...filters }),
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
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  const rid = String((req.body || {}).rid || '').trim();
  if (!rid) return res.status(400).json({ error: '缺少 rid' });
  try {
    const r = await db.getReward(rid);
    if (!r) return res.status(404).json({ error: '找不到这笔奖励' });
    if (r.status === 'CREATED') {
      const ok = await db.revokeReward(rid);
      if (!ok) return res.status(409).json({ error: '这笔奖励刚被领取，无法撤回' });
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
  if (!openid) return res.status(400).json({ error: '请填写员工的 openid' });
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(openid)) return res.status(400).json({ error: 'openid 格式不对' });
  try {
    // 若把最后一个超管降级为操作员，拦截
    if (role !== 'super') {
      const cur = (await db.loadAdmins()).find((a) => a.openid === openid);
      if (cur && cur.role === 'super' && cur.enabled && (await db.countEnabledSupers()) <= 1) {
        return res.status(400).json({ error: '不能把最后一个超级管理员降级' });
      }
    }
    await db.upsertAdmin({ openid, name, role, createdBy: me });
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
    const list = await db.searchCustomers({
      q: String(req.query.q || '').trim(),
      followUserid: String(req.query.follow || '').trim(),
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ list, wecom: wecom.wecomEnabled });
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
    let userids = Array.isArray((req.body || {}).userids) ? req.body.userids.filter(Boolean) : [];
    if (!userids.length) userids = await wecom.getFollowUserList();
    if (!userids.length) {
      return res.status(400).json({ error: '企微里没有配置「客户联系」的员工（请在企微后台把负责客户的员工加入客户联系使用范围）' });
    }
    const startIndex = Math.min(Math.max(Number((req.body || {}).startIndex) || 0, 0), userids.length);
    const startCursor = typeof (req.body || {}).cursor === 'string' ? req.body.cursor : '';
    let synced = 0;
    for (let i = startIndex; i < userids.length; i++) {
      const uid = userids[i];
      let cursor = i === startIndex ? startCursor : '';
      let guard = 0;
      do {
        if (Date.now() - startAt > DEADLINE_MS) {
          return res.json({ ok: true, partial: true, synced, nextIndex: i, nextCursor: cursor, totalStaff: userids.length });
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
    }
    res.json({ ok: true, synced, totalStaff: userids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 企微群发通知：给选中的客户发一条文案（员工需在企微「群发助手」点一次发送）
app.post('/api/deliver', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!wecom.wecomEnabled) return res.status(503).json({ error: '未配置企微，无法群发（可让员工手动转发小程序给客户）' });
  const externalUserids = Array.isArray((req.body || {}).externalUserids)
    ? req.body.externalUserids.filter(Boolean)
    : [];
  if (!externalUserids.length) return res.status(400).json({ error: '请选择要通知的客户' });
  const text = String((req.body || {}).text || '').trim() ||
    '你有一笔奖励待领取，请打开我们的小程序查看～';
  try {
    const body = {
      chat_type: 'single',
      external_userid: externalUserids,
      text: { content: text.slice(0, 600) },
    };
    // 带上小程序卡片：客户点开卡片直达领取页（按 unionid 认出本人、显示他那一笔），
    // 不用再让客户去搜索小程序名字。封面上传失败则自动降级为纯文字群发，不阻断。
    let withCard = false;
    try {
      const picMediaId = await wecom.getCardCoverMediaId(cardCover());
      body.attachments = [
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
    const r = await wecom.addMsgTemplate(body);
    res.json({
      ok: true,
      msgid: r.msgid || '',
      withCard,
      failCount: (r.fail_list || []).length,
      failList: r.fail_list || [],
    });
  } catch (e) {
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
  if (items.length > 200) return res.status(400).json({ error: '单次最多 200 笔' });

  const created = [];
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const target = String(it.externalUserid || '').trim();
    const yuan = Number(it.amountYuan);
    if (!target) {
      errors.push({ i, error: '缺少客户 externalUserid' });
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
    if (yuan > config.app.maxAmountYuan) {
      errors.push({ i, target, error: `金额不能大于 ${config.app.maxAmountYuan} 元` });
      continue;
    }
    const itNameErr = nameRuleError(yuan, it.name);
    if (itNameErr) {
      errors.push({ i, target, error: itNameErr });
      continue;
    }
    const rid = newRid();
    const exp = Math.floor(Date.now() / 1000) + config.app.rewardTtlHours * 3600;
    try {
      await db.saveReward({
        rid,
        amountFen: Math.round(yuan * 100),
        remark: it.remark,
        name: it.name,
        createdBy: openid,
        exp,
        targetExternalUserid: target,
      });
      created.push({ rid, externalUserid: target, amountYuan: yuan, remark: it.remark || '' });
    } catch (e) {
      errors.push({ i, target, error: '落库失败：' + (e.code || e.message) });
    }
  }
  res.json({ createdCount: created.length, errorCount: errors.length, created, errors });
});

// 【客户】查我的定向奖励（身份匹配，防领错）
app.get('/api/claim/mine', async (req, res) => {
  const openid = getOpenid(req);
  const unionid = getUnionid(req);
  if (!openid) return res.status(401).json({ error: '请在微信小程序内打开' });
  if (!db.dbEnabled) return res.json({ reward: null, reason: 'no_db' });
  try {
    // 首页自动探测：本地库优先（快），未命中再走企微在线转换兜底（已带 6s 超时，不会拖死）。
    // 否则"同步时未拿到 unionid / 未同步"的定向客户会一直看不到属于自己的奖励。
    const externalUserid = await resolveCustomer(unionid, openid);
    if (!externalUserid) return res.json({ reward: null, reason: unionid ? 'not_a_customer' : 'no_unionid' });
    const r = await db.findPendingRewardForTarget(externalUserid);
    if (!r) return res.json({ reward: null, reason: 'no_pending' });
    res.json({ reward: { rid: r.rid, amountYuan: r.amount_fen / 100, remark: r.remark } });
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
    const externalUserid = await resolveCustomer(unionid, openid);
    if (!externalUserid) return res.status(403).json({ error: '未识别到你的客户身份，无法领取' });
    const r = await db.findPendingRewardForTarget(externalUserid);
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
      if (rw && rw.target_external_userid) {
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
