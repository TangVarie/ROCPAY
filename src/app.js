// ============================================================
//  Express 服务入口（部署到微信云托管）
//  小程序通过 wx.cloud.callContainer 调用，云托管会自动注入 x-wx-openid
// ============================================================
import express from 'express';
import { config } from './config.js';
import { createRewardToken, verifyRewardToken, newRid } from './reward-token.js';
import { createTransferBill, queryTransferByOutBillNo } from './transfer-service.js';
import { wechatpay } from './wechat-pay.js';
import { db } from './db.js';
import { wecom } from './wecom.js';

const app = express();

// 部署校验标记：每次改动会 bump，/api/health 会回显它，用来确认线上跑的是哪版代码
const BUILD = 'p2-scaffold';

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

// 云托管注入 x-wx-openid；本地调试可用 DEV_OPENID 环境变量顶替
function getOpenid(req) {
  return req.headers['x-wx-openid'] || process.env.DEV_OPENID || '';
}
// 云托管在「小程序已绑定开放平台」时注入 x-wx-unionid（P2 定向用）
function getUnionid(req) {
  return req.headers['x-wx-unionid'] || process.env.DEV_UNIONID || '';
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

// 健康检查（云托管探活）
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, build: BUILD, time: new Date().toISOString(), db: await db.ping() });
});

// 当前用户：帮员工拿到自己的 openid、判断是否管理员，并告知金额上下限（前端预校验用）
app.get('/api/me', (req, res) => {
  const openid = getOpenid(req);
  const role = adminRole(openid); // 'super' | 'operator' | null
  res.json({
    openid,
    isAdmin: !!role,
    isSuper: role === 'super',
    role: role || 'none',
    minAmountYuan: config.app.minAmountYuan,
    maxAmountYuan: config.app.maxAmountYuan,
  });
});

// 部署自检：验证 商户号/证书/私钥/APIv3密钥/出口IP白名单 是否全部有效
// 部署后用浏览器访问 https://你的域名/api/diagnose?key=<REWARD_TOKEN_SECRET>
app.get('/api/diagnose', async (req, res) => {
  if (!config.app.rewardTokenSecret || req.query.key !== config.app.rewardTokenSecret) {
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
  const byKey = !!config.app.rewardTokenSecret && req.query.key === config.app.rewardTokenSecret;
  if (!byOpenid && !byKey) {
    return res.status(403).json({ error: '无权限：小程序内管理员访问，或浏览器带 ?key=REWARD_TOKEN_SECRET' });
  }
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库，无发放记录（配置 MYSQL_* 后可用）' });
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const [list, stats] = await Promise.all([db.listRewards({ limit, offset }), db.getStats()]);
    res.json({ list, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
app.post('/api/customers/sync', async (req, res) => {
  if (!isAdmin(getOpenid(req))) return res.status(403).json({ error: '无权限' });
  if (!db.dbEnabled) return res.status(503).json({ error: '未开启数据库' });
  if (!wecom.wecomEnabled) return res.status(503).json({ error: '未配置企微（WECOM_CORPID/WECOM_CONTACT_SECRET）' });
  const userids = Array.isArray((req.body || {}).userids) ? req.body.userids.filter(Boolean) : [];
  if (!userids.length) return res.status(400).json({ error: '请在 body.userids 传要同步的企微员工 userid 列表' });
  try {
    let synced = 0;
    for (const uid of userids) {
      let cursor = '';
      do {
        const d = await wecom.batchGetByUser([uid], cursor, 100);
        for (const item of d.external_contact_list || []) {
          const c = wecom.normalizeContact(item);
          if (c.externalUserid) {
            await db.upsertCustomer(c);
            synced++;
          }
        }
        cursor = d.next_cursor || '';
      } while (cursor);
    }
    res.json({ ok: true, synced });
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
    persist('recordClaim(mine)', () =>
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

// unionid → external_userid（定向身份桥）；成功则回填 openid 到客户档案
async function resolveCustomer(unionid, openid) {
  if (!unionid || !wecom.wecomEnabled) return null;
  const externalUserid = await wecom.unionidToExternalUserid(unionid, openid);
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

  // 定向奖励(P2)只能由本人在小程序内按身份领取，禁止用令牌绕过（防领错）
  if (db.dbEnabled) {
    try {
      const target = await db.getRewardTarget(payload.rid);
      if (target) return res.status(403).json({ error: '这是定向奖励，请由指定客户在小程序内领取' });
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
    persist('recordClaim', () =>
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

// 查询转账单状态（对账/排查）
app.get('/api/transfers/:outBillNo', async (req, res) => {
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

app.listen(config.port, async () => {
  console.log(`✅ 服务已启动，监听端口 ${config.port}`);
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
