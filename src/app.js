// ============================================================
//  Express 服务入口（部署到微信云托管）
//  小程序通过 wx.cloud.callContainer 调用，云托管会自动注入 x-wx-openid
// ============================================================
import express from 'express';
import { config } from './config.js';
import { createRewardToken, verifyRewardToken } from './reward-token.js';
import { createTransferBill, queryTransferByOutBillNo } from './transfer-service.js';
import { wechatpay } from './wechat-pay.js';
import { db } from './db.js';

const app = express();

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
function isAdmin(openid) {
  return !!openid && config.app.adminOpenids.includes(openid);
}

// 健康检查（云托管探活）
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), db: await db.ping() });
});

// 当前用户：帮员工拿到自己的 openid、判断是否管理员
app.get('/api/me', (req, res) => {
  const openid = getOpenid(req);
  res.json({ openid, isAdmin: isAdmin(openid) });
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

// 【员工】后台：最近发放记录 + 汇总（需管理员；需已开库）
app.get('/api/rewards', async (req, res) => {
  const openid = getOpenid(req);
  if (!isAdmin(openid)) return res.status(403).json({ error: '无权限：仅管理员可查看' });
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
        console.log('✅ 数据库已连接，业务表已就绪（rewards / transfers / notify_events）');
      } catch (e) {
        console.error('⚠️ 自动建表失败（服务仍可运行，落库会被跳过）：', e.code || e.message);
      }
    } else {
      console.log('ℹ️ 已配置数据库，但 DB_AUTO_MIGRATE=false，请手动执行 db/schema.sql');
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
