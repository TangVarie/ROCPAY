// ============================================================
//  业务库（微信云托管自带 MySQL）· 数据访问层
//  设计原则：
//   1. 纯增量、带开关：不配置 MYSQL_* 环境变量时 dbEnabled=false，
//      所有写库函数变成空操作，后端退回「无状态」模式，绝不影响转账链路。
//   2. 尽力而为：业务接口里的落库都用 try/catch 包住，写库失败只记日志、
//      不阻断发钱/领钱（钱的幂等由微信 out_bill_no 保证，库只是账本）。
//   3. 自愈：领取/回调时若发现 rewards 行不存在（例如先前没开库），
//      会用令牌里自带的信息补insert，保证 transfers 一定有对应 reward。
//   4. 启动自动建表：CREATE TABLE IF NOT EXISTS，幂等安全。
// ============================================================
import mysql from 'mysql2/promise';
import { config } from './config.js';

export const dbEnabled = config.db.enabled;

// ---------------- 连接池 ----------------
let pool = null;
if (dbEnabled) {
  const base = {
    waitForConnections: true,
    connectionLimit: config.db.connectionLimit,
    maxIdle: config.db.connectionLimit,
    queueLimit: config.db.queueLimit, // DB 卡住时排队上限，超出直接失败，避免请求无限堆积
    idleTimeout: 60_000,
    connectTimeout: 5_000, // 连接超时快速失败，避免请求长时间挂起
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    charset: 'utf8mb4',
    timezone: 'Z', // 统一按 UTC 存取，避免时区错乱
    namedPlaceholders: true,
    dateStrings: true, // DATETIME 直接返回字符串，前端好显示
  };
  // 建池失败（如 MYSQL_URL 格式非法）不得拖垮整个服务：降级为无库模式
  try {
    pool = config.db.url
      ? mysql.createPool({ uri: config.db.url, ...base })
      : mysql.createPool({
          host: config.db.host,
          port: config.db.port,
          user: config.db.user,
          password: config.db.password,
          database: config.db.database,
          ...base,
        });
  } catch (e) {
    pool = null;
    console.error('⚠️ 创建数据库连接池失败，已降级为无状态模式（请检查 MYSQL_URL/连接参数）：', e.message);
  }
}

// ---------------- 建表 DDL（与 db/schema.sql 保持一致）----------------
const DDL = [
  `CREATE TABLE IF NOT EXISTS rewards (
     rid            VARCHAR(32)  NOT NULL PRIMARY KEY COMMENT '奖励ID=商户单号 out_bill_no',
     amount_fen     INT UNSIGNED NOT NULL COMMENT '金额(分)',
     remark         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '备注(用户可见)',
     recipient_name VARCHAR(64)  NULL COMMENT '收款人真实姓名(可选·PII)',
     target_external_userid VARCHAR(64) NULL COMMENT '定向目标企微客户(P2)，NULL=非定向',
     created_by     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '发放人(管理员)openid',
     status         VARCHAR(24)  NOT NULL DEFAULT 'CREATED' COMMENT 'CREATED|CLAIMED|SUCCESS|FAIL|CLOSED',
     expires_at     DATETIME     NULL COMMENT '领取有效期',
     created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     KEY idx_rewards_created_by (created_by),
     KEY idx_rewards_status (status),
     KEY idx_rewards_target (target_external_userid),
     KEY idx_rewards_created_at (created_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='发放的奖励'`,

  `CREATE TABLE IF NOT EXISTS transfers (
     out_bill_no      VARCHAR(32)  NOT NULL PRIMARY KEY COMMENT '=rewards.rid,天然幂等',
     claimer_openid   VARCHAR(64)  NOT NULL COMMENT '领取人openid(首个领取者)',
     amount_fen       INT UNSIGNED NOT NULL COMMENT '金额(分)',
     transfer_bill_no VARCHAR(64)  NULL COMMENT '微信转账单号',
     state            VARCHAR(32)  NOT NULL DEFAULT '' COMMENT 'WAIT_USER_CONFIRM|SUCCESS|FAIL|...',
     package_info     VARCHAR(255) NULL COMMENT '拉起确认页用',
     fail_reason      VARCHAR(255) NULL,
     created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     KEY idx_transfers_claimer (claimer_openid),
     KEY idx_transfers_state (state),
     KEY idx_transfers_created_at (created_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='实际发起的转账'`,

  `CREATE TABLE IF NOT EXISTS notify_events (
     id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     event_type       VARCHAR(64)  NULL,
     out_bill_no      VARCHAR(32)  NULL,
     transfer_bill_no VARCHAR(64)  NULL,
     state            VARCHAR(32)  NULL,
     raw              JSON         NULL COMMENT '解密后的回调原文',
     received_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     KEY idx_notify_out_bill_no (out_bill_no),
     KEY idx_notify_received_at (received_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='微信回调审计流水'`,

  `CREATE TABLE IF NOT EXISTS admins (
     openid       VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT '员工的小程序openid',
     name         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '备注名(谁)',
     role         VARCHAR(16)  NOT NULL DEFAULT 'operator' COMMENT 'super|operator',
     enabled      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '是否启用',
     wecom_userid VARCHAR(64)  NULL COMMENT '员工的企微userid(群发sender映射)',
     created_by   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '谁添加的',
     created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     KEY idx_admins_role (role)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='员工/管理员'`,

  // 客户↔跟进员工 多对多。customers.follow_userid 只有一列，同一客户加了多个员工时
  // 后同步的会覆盖先同步的；群发按 sender 分组必须知道完整的跟进关系，所以单独建表。
  `CREATE TABLE IF NOT EXISTS customer_follows (
     external_userid VARCHAR(64) NOT NULL COMMENT '企微外部联系人ID',
     userid          VARCHAR(64) NOT NULL COMMENT '跟进员工的企微userid',
     synced_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (external_userid, userid),
     KEY idx_cf_userid (userid)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客户-跟进员工多对多(群发sender分组用)'`,

  `CREATE TABLE IF NOT EXISTS customers (
     external_userid VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT '企微外部联系人ID',
     remark          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '员工给客户的备注名(搜索主字段)',
     name            VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '客户微信昵称',
     avatar          VARCHAR(512) NULL COMMENT '头像',
     corp_name       VARCHAR(128) NULL COMMENT '客户所在企业(如有)',
     mobiles         JSON         NULL COMMENT '备注手机号',
     tags            JSON         NULL COMMENT '标签',
     follow_userid   VARCHAR(64)  NULL COMMENT '跟进员工的企微userid',
     unionid         VARCHAR(64)  NULL COMMENT 'unionid(定向桥)',
     openid          VARCHAR(64)  NULL COMMENT '客户开过小程序后回填',
     synced_at       DATETIME     NULL COMMENT '最近从企微同步时间',
     created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     KEY idx_customers_remark (remark),
     KEY idx_customers_unionid (unionid),
     KEY idx_customers_openid (openid),
     KEY idx_customers_follow (follow_userid)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='企微客户缓存+身份映射'`,

  `CREATE TABLE IF NOT EXISTS settings (
     k          VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT '设置键',
     v          TEXT         NULL COMMENT '设置值',
     updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='通用键值设置(如打款周期清零点)'`,
];

/**
 * 确保目标库存在。云托管托管型 MySQL 常常只给你一个实例、没有建好业务库，
 * 而连接池是绑定到 MYSQL_DATABASE 的——库不存在连接就会失败。
 * 这里先用一个不指定库的短连接执行 CREATE DATABASE IF NOT EXISTS，再由池建表。
 * 仅在「分开填变量」模式下生效；URL 模式假定连接串里的库已存在。
 */
async function ensureDatabase() {
  const name = config.db.database;
  if (config.db.url || !name) return;
  // 库名只允许字母数字下划线，避免反引号拼接注入
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`非法的 MYSQL_DATABASE 名称：${name}（只允许字母/数字/下划线）`);
  }
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    connectTimeout: 5_000,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await conn.end();
  }
}

/** 给已存在的表补列（幂等）。MySQL 无 ADD COLUMN IF NOT EXISTS，用 information_schema 判断。 */
async function ensureColumn(table, column, ddl) {
  if (!pool) return;
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (Number(rows[0].n) === 0) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  }
}

/** 启动时建库建表（幂等）。失败只记日志，不阻断服务启动。 */
export async function migrate() {
  if (!pool) return;
  await ensureDatabase();
  for (const stmt of DDL) await pool.query(stmt);
  // 老库补列：定向目标（P2）
  await ensureColumn(
    'rewards',
    'target_external_userid',
    "target_external_userid VARCHAR(64) NULL COMMENT '定向目标企微客户(P2)' AFTER recipient_name"
  );
  // 老库补列：员工企微userid（群发 sender 映射）
  await ensureColumn(
    'admins',
    'wecom_userid',
    "wecom_userid VARCHAR(64) NULL COMMENT '员工的企微userid(群发sender映射)' AFTER enabled"
  );
  await seedSuperAdmins(config.app.adminOpenids);
}

/** 把 ADMIN_OPENIDS 里的人写成超级管理员（幂等，只补不覆盖启用状态） */
export async function seedSuperAdmins(openids = []) {
  if (!pool || !openids.length) return;
  for (const openid of openids) {
    await pool.execute(
      `INSERT INTO admins (openid, name, role, enabled, created_by)
       VALUES (:openid, '超级管理员', 'super', 1, 'bootstrap')
       ON DUPLICATE KEY UPDATE role='super', enabled=1`,
      { openid }
    );
  }
}

// 给一个 Promise 加超时，避免 DB 卡住时把请求（尤其是探活）拖死
function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(label)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/**
 * 探活：给 /api/health 用，带 2s 超时，DB 挂了也会快速返回 ok:false，
 * 绝不阻塞健康检查（云托管探活务必用根路径 `/`，它完全不碰 DB）。
 * 注意：/api/health 是公网可匿名访问的，这里【不回传】具体连接错误，
 * 只回 enabled/ok；详细报错写日志，避免向外泄露内网连接信息。
 */
export async function ping() {
  if (!pool) return { enabled: false, ok: false };
  try {
    await withTimeout(pool.query('SELECT 1'), 2_000, 'ping-timeout');
    return { enabled: true, ok: true };
  } catch (e) {
    console.error('[db] 探活失败：', e.code || e.message);
    return { enabled: true, ok: false };
  }
}

// 把 exp(unix秒) 转成 DATETIME 可接受的 Date；无则 null
function expToDate(exp) {
  return exp ? new Date(Number(exp) * 1000) : null;
}

// 转账状态 → 奖励状态（只在终态时回写 rewards.status）。
// 撤销(CANCELLED/CANCELING)单独立状态：台账要能看出"我们主动撤回、资金已回流"，和真失败区分开
function rewardStatusOf(state) {
  const s = String(state || '').toUpperCase();
  if (s === 'SUCCESS') return 'SUCCESS';
  if (s === 'CANCELLED' || s === 'CANCELING') return 'CANCELLED';
  if (s === 'FAIL' || s === 'CLOSED') return 'FAIL';
  return null;
}

// 终态集合：一旦到达终态，除非新状态也是终态，否则不允许回退（保证状态单调）
const TERMINAL_STATES = ['SUCCESS', 'FAIL', 'CLOSED', 'CANCELLED', 'CANCELING'];
const TERMINAL_SQL = TERMINAL_STATES.map((s) => `'${s}'`).join(','); // 常量，无注入风险
const isTerminal = (s) => TERMINAL_STATES.includes(String(s || '').toUpperCase());
// 状态回写守卫：新状态非空，且（新状态是终态 或 当前不是终态）时才覆盖，否则保留原值。
// 既防止「空状态清空已有状态」，也防止「终态被回退成非终态」。
// 额外：SUCCESS 一旦写入即"钉死"，不被任何后续状态覆盖（与 rewards.status 的 SUCCESS 保护一致，
// 避免已到账的转账在乱序/重放事件里被翻成失败，误导后台对账、诱发重发）。
const STATE_GUARD = (newExpr) =>
  `IF(:state_nonempty = 1 AND state <> 'SUCCESS' AND (:new_terminal = 1 OR state NOT IN (${TERMINAL_SQL})), ${newExpr}, state)`;

// 截断到列长度，避免超长字符串触发 MySQL 严格模式 'Data too long' 导致整行落库失败
function clip(s, n) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}

/** 【发奖】管理员生成奖励时落库。targetExternalUserid 非空=定向奖励(P2) */
export async function saveReward({ rid, amountFen, remark, name, createdBy, exp, targetExternalUserid }) {
  if (!pool) return;
  await pool.execute(
    `INSERT INTO rewards (rid, amount_fen, remark, recipient_name, target_external_userid, created_by, status, expires_at)
     VALUES (:rid, :amount_fen, :remark, :recipient_name, :target, :created_by, 'CREATED', :expires_at)
     ON DUPLICATE KEY UPDATE amount_fen=VALUES(amount_fen), remark=VALUES(remark),
       recipient_name=VALUES(recipient_name), target_external_userid=VALUES(target_external_userid),
       created_by=VALUES(created_by)`,
    {
      rid,
      amount_fen: amountFen,
      remark: clip(remark || '', 64),
      recipient_name: name ? clip(name, 64) : null,
      target: targetExternalUserid || null,
      created_by: clip(createdBy || '', 64),
      expires_at: expToDate(exp),
    }
  );
}

/**
 * 【领取】客户领取、转账已发起时落库。
 * 用事务：先自愈补 rewards（若不存在），再写 transfers。
 * transfers 主键=out_bill_no，重复领取只更新状态，不覆盖首个领取人。
 */
export async function recordClaim({
  rid,
  claimerOpenid,
  amountFen,
  remark,
  name,
  exp,
  transferBillNo,
  state,
  packageInfo,
}) {
  if (!pool) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO rewards (rid, amount_fen, remark, recipient_name, status, expires_at)
       VALUES (:rid, :amount_fen, :remark, :recipient_name, 'CLAIMED', :expires_at)
       ON DUPLICATE KEY UPDATE status=IF(status='CREATED','CLAIMED',status)`,
      {
        rid,
        amount_fen: amountFen,
        remark: clip(remark || '', 64),
        recipient_name: name ? clip(name, 64) : null,
        expires_at: expToDate(exp),
      }
    );
    // transfers 主键=out_bill_no：不覆盖首个领取人；state 单调（不回退终态）
    await conn.execute(
      `INSERT INTO transfers (out_bill_no, claimer_openid, amount_fen, transfer_bill_no, state, package_info)
       VALUES (:out_bill_no, :claimer_openid, :amount_fen, :transfer_bill_no, :state, :package_info)
       ON DUPLICATE KEY UPDATE
         transfer_bill_no=COALESCE(VALUES(transfer_bill_no), transfer_bill_no),
         state=${STATE_GUARD('VALUES(state)')},
         package_info=COALESCE(VALUES(package_info), package_info),
         updated_at=CURRENT_TIMESTAMP`,
      {
        out_bill_no: rid,
        claimer_openid: claimerOpenid,
        amount_fen: amountFen,
        transfer_bill_no: transferBillNo || null,
        state: state || '',
        package_info: packageInfo || null,
        new_terminal: isTerminal(state) ? 1 : 0,
        state_nonempty: state ? 1 : 0,
      }
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 【状态更新】回调 / 主动查询后回写转账与奖励状态。
 * 自愈：回调/查询报文本身带 openid + 金额时，行不存在会补 insert（不再静默丢状态）。
 * 单调：不把已终态（SUCCESS/FAIL）回退成非终态；空状态不覆盖。
 */
export async function updateTransferState({ outBillNo, state, transferBillNo, failReason, claimerOpenid, amountFen }) {
  if (!pool || !outBillNo) return;
  const newTerminal = isTerminal(state) ? 1 : 0;

  if (claimerOpenid && amountFen != null) {
    // 有足够字段 → upsert，行缺失也能补齐（notify/query 都带 openid + transfer_amount）
    await pool.execute(
      `INSERT INTO transfers (out_bill_no, claimer_openid, amount_fen, transfer_bill_no, state, fail_reason)
       VALUES (:out_bill_no, :claimer_openid, :amount_fen, :transfer_bill_no, :state, :fail_reason)
       ON DUPLICATE KEY UPDATE
         transfer_bill_no=COALESCE(VALUES(transfer_bill_no), transfer_bill_no),
         fail_reason=COALESCE(VALUES(fail_reason), fail_reason),
         state=${STATE_GUARD('VALUES(state)')},
         updated_at=CURRENT_TIMESTAMP`,
      {
        out_bill_no: outBillNo,
        claimer_openid: claimerOpenid,
        amount_fen: amountFen,
        transfer_bill_no: transferBillNo || null,
        state: state || '',
        fail_reason: failReason || null,
        new_terminal: newTerminal,
        state_nonempty: state ? 1 : 0,
      }
    );
  } else {
    // 字段不足 → 只更新已存在的行（state 仍单调、不空写）
    await pool.execute(
      `UPDATE transfers
         SET state=${STATE_GUARD(':state')},
             transfer_bill_no=COALESCE(:transfer_bill_no, transfer_bill_no),
             fail_reason=COALESCE(:fail_reason, fail_reason),
             updated_at=CURRENT_TIMESTAMP
       WHERE out_bill_no=:out_bill_no`,
      {
        out_bill_no: outBillNo,
        state: state || '',
        transfer_bill_no: transferBillNo || null,
        fail_reason: failReason || null,
        new_terminal: newTerminal,
        state_nonempty: state ? 1 : 0,
      }
    );
  }

  // 回写 rewards.status（仅终态）；行缺失补 insert；已 SUCCESS 不被覆盖
  const rs = rewardStatusOf(state);
  if (rs) {
    await pool.execute(
      `INSERT INTO rewards (rid, amount_fen, status)
       VALUES (:rid, :amount_fen, :status)
       ON DUPLICATE KEY UPDATE status=IF(status='SUCCESS', status, :status)`,
      { rid: outBillNo, amount_fen: amountFen != null ? amountFen : 0, status: rs }
    );
  }
}

/** 【审计】记录一条微信回调原文 */
export async function saveNotifyEvent({ eventType, outBillNo, transferBillNo, state, raw }) {
  if (!pool) return;
  await pool.execute(
    `INSERT INTO notify_events (event_type, out_bill_no, transfer_bill_no, state, raw)
     VALUES (:event_type, :out_bill_no, :transfer_bill_no, :state, :raw)`,
    {
      event_type: eventType || null,
      out_bill_no: outBillNo || null,
      transfer_bill_no: transferBillNo || null,
      state: state || null,
      raw: JSON.stringify(raw ?? {}),
    }
  );
}

/**
 * 【后台】最近发放记录（含转账状态）。limit/offset 已强制为安全整数。
 * 数据最小化：不返回 recipient_name（真实姓名·PII）；如需按单查姓名请单独走审计。
 */
// 台账筛选条件 → WHERE 子句（listRewards/getStats 共用，保证列表和汇总口径一致）
//   status: all|created(待领取)|waiting(待确认)|success|failed(含失败/关闭/撤回)
//   days:   只看近 N 天（0=全部）；target: 只看某个客户（单人资金往来）
function rewardFilterSql({ status = 'all', days = 0, target = '' } = {}) {
  const conds = [];
  const params = {};
  const st = String(status || 'all');
  if (st === 'created') conds.push(`r.status = 'CREATED'`);
  else if (st === 'waiting') conds.push(`r.status = 'CLAIMED'`);
  else if (st === 'success') conds.push(`r.status = 'SUCCESS'`);
  else if (st === 'failed') conds.push(`r.status IN ('FAIL','CLOSED','CANCELLED')`);
  const d = parseInt(days, 10) || 0;
  if (d > 0) {
    conds.push(`r.created_at > DATE_SUB(NOW(), INTERVAL :days DAY)`);
    params.days = d;
  }
  if (target) {
    conds.push(`r.target_external_userid = :target`);
    params.target = String(target);
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

export async function listRewards({ limit = 50, offset = 0, status, days, target } = {}) {
  if (!pool) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const { where, params } = rewardFilterSql({ status, days, target });
  const [rows] = await pool.execute(
    `SELECT r.rid, r.amount_fen, r.remark, r.created_by, r.status,
            r.created_at, r.expires_at, r.target_external_userid,
            c.remark AS target_remark, c.name AS target_name,
            a.name AS created_by_name,
            t.claimer_openid, t.transfer_bill_no, t.state AS transfer_state,
            t.updated_at AS transfer_updated_at
       FROM rewards r
       LEFT JOIN transfers t ON t.out_bill_no = r.rid
       LEFT JOIN customers c ON c.external_userid = r.target_external_userid
       LEFT JOIN admins a ON a.openid = r.created_by
      ${where}
      ORDER BY r.created_at DESC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );
  return rows;
}

/** 【后台】汇总统计（空表也返回 0；数值统一为 number 类型） */
// 汇总：支持与 listRewards 相同的筛选（期间资金消耗、单人资金往来都从这里出）
export async function getStats(filters = {}) {
  if (!pool) return null;
  const { where, params } = rewardFilterSql(filters);
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(IF(r.status<>'CANCELLED', r.amount_fen, 0)),0) AS total_fen,
            COALESCE(SUM(r.status IN ('CLAIMED','SUCCESS') ), 0) AS paid_count,
            COALESCE(SUM(IF(r.status IN ('CLAIMED','SUCCESS'), r.amount_fen, 0)),0) AS paid_fen,
            COALESCE(SUM(r.status='SUCCESS'),0) AS success_count,
            COALESCE(SUM(r.status IN ('CREATED','CLAIMED')),0) AS pending_count,
            COALESCE(SUM(r.status IN ('FAIL','CLOSED','CANCELLED')),0) AS fail_count,
            COALESCE(SUM(r.status='CANCELLED'),0) AS cancelled_count
       FROM rewards r
      ${where}`,
    params
  );
  return {
    total: Number(row.total),
    total_fen: Number(row.total_fen), // 发放合计——不含已撤回（撤回=当没发过，撤回后合计立刻下降）
    paid_count: Number(row.paid_count), // 实际动钱的笔数（已划走/在途）
    paid_fen: Number(row.paid_fen), //     实际动钱的金额——期间资金消耗看这个
    success_count: Number(row.success_count),
    pending_count: Number(row.pending_count),
    fail_count: Number(row.fail_count),
    cancelled_count: Number(row.cancelled_count),
  };
}

// ---------------- 通用设置(键值) & 打款周期台账 ----------------

/** 读一个设置项，无则返回默认值 */
export async function getSetting(key, def = null) {
  if (!pool) return def;
  const [rows] = await pool.execute(`SELECT v FROM settings WHERE k=:k`, { k: key });
  return rows.length ? rows[0].v : def;
}

/** 写一个设置项（幂等 upsert） */
export async function setSetting(key, value) {
  if (!pool) throw new Error('未开启数据库');
  await pool.execute(
    `INSERT INTO settings (k, v) VALUES (:k, :v)
     ON DUPLICATE KEY UPDATE v=VALUES(v)`,
    { k: key, v: value == null ? null : String(value) }
  );
}

// 额度占用口径（getPeriodStats / adjustQuota 必须一致）：
//   生成即占用 —— CREATED(未过期)+CLAIMED+SUCCESS 都算"已承诺的钱"；
//   撤回(CANCELLED)/失败(FAIL/CLOSED)/过期未领 自动不再占用 → 可发额度自动回流。
//   这样"发出去、撤回来"在额度上立刻对得上，符合运营心智。
const QUOTA_CONSUMED_SQL = `(status IN ('CLAIMED','SUCCESS')
   OR (status = 'CREATED' AND (expires_at IS NULL OR expires_at > NOW())))`;

/**
 * 本期占用：自 since 起、按上面口径"已承诺"的金额与笔数。since 为空表示统计全部。
 */
export async function getPeriodStats(since) {
  if (!pool) return { paidFen: 0, paidCount: 0 };
  const [rows] = await pool.execute(
    `SELECT COALESCE(SUM(amount_fen),0) AS paid_fen, COUNT(*) AS paid_count
       FROM rewards
      WHERE ${QUOTA_CONSUMED_SQL} AND created_at >= :since`,
    { since: since || '1970-01-01 00:00:00' }
  );
  return { paidFen: Number(rows[0].paid_fen), paidCount: Number(rows[0].paid_count) };
}

/**
 * 原子调整可发额度（mode='add' 充值累加携带结余 / mode='set' 校准设为实际余额）。
 * 事务 + SELECT...FOR UPDATE 行锁：两位管理员同时充值也不会互相覆盖丢一笔。
 */
export async function adjustQuota({ mode, amountFen }) {
  if (!pool) throw new Error('未开启数据库');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 锁住两行设置，序列化并发的充值/校准
    const [rows] = await conn.query(
      `SELECT k, v FROM settings WHERE k IN ('quota_base_fen','quota_base_paid_fen') FOR UPDATE`
    );
    const map = {};
    for (const r of rows) map[r.k] = r.v;
    const [[paid]] = await conn.query(
      `SELECT COALESCE(SUM(amount_fen),0) AS paid_fen FROM rewards WHERE ${QUOTA_CONSUMED_SQL}`
    );
    const allPaidFen = Number(paid.paid_fen);
    let newBaseFen;
    if (mode === 'set') {
      newBaseFen = amountFen;
    } else {
      const baseRaw = 'quota_base_fen' in map ? map.quota_base_fen : null;
      const baseFen = Number(baseRaw) || 0;
      const anchorPaidFen = Number(map.quota_base_paid_fen || '0') || 0;
      const remainingNow = baseRaw != null ? baseFen - (allPaidFen - anchorPaidFen) : 0;
      newBaseFen = remainingNow + amountFen;
    }
    await conn.query(
      `INSERT INTO settings (k, v) VALUES ('quota_base_fen', :b), ('quota_base_paid_fen', :p)
       ON DUPLICATE KEY UPDATE v=VALUES(v)`,
      { b: String(newBaseFen), p: String(allPaidFen) }
    );
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* 回滚失败不掩盖原错误 */ }
    throw e;
  } finally {
    conn.release();
  }
}

/** 近 7 天内未到终态(在途)的转账单号：给自动对账用（回调丢失/落库缺笔都能追平） */
export async function listUnfinishedTransfers(limit = 20) {
  if (!pool) return [];
  const n = Math.max(1, Math.min(Number(limit) || 20, 100));
  const [rows] = await pool.query(
    `SELECT out_bill_no FROM transfers
      WHERE state NOT IN (${TERMINAL_SQL})
        AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
      ORDER BY updated_at ASC
      LIMIT ${n}`
  );
  return rows.map((r) => r.out_bill_no);
}

// ---------------- 员工/管理员 ----------------

/** 返回全部管理员，用于内存缓存 */
export async function loadAdmins() {
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT openid, name, role, enabled, wecom_userid, created_by, created_at
       FROM admins ORDER BY (role='super') DESC, created_at ASC`
  );
  return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
}

/** 新增/更新一个员工。wecomUserid 不传则保留原值（COALESCE），避免普通编辑把映射冲掉。 */
export async function upsertAdmin({ openid, name, role, createdBy, wecomUserid }) {
  if (!pool) throw new Error('未开启数据库');
  const r = role === 'super' ? 'super' : 'operator';
  await pool.execute(
    `INSERT INTO admins (openid, name, role, enabled, wecom_userid, created_by)
     VALUES (:openid, :name, :role, 1, :wu, :created_by)
     ON DUPLICATE KEY UPDATE name=VALUES(name), role=VALUES(role), enabled=1,
       wecom_userid=COALESCE(VALUES(wecom_userid), wecom_userid)`,
    {
      openid,
      name: clip(name || '', 64),
      role: r,
      wu: wecomUserid ? clip(wecomUserid, 64) : null,
      created_by: createdBy || '',
    }
  );
}

/** 启用/停用 */
export async function setAdminEnabled(openid, enabled) {
  if (!pool) throw new Error('未开启数据库');
  await pool.execute(`UPDATE admins SET enabled=:e WHERE openid=:openid`, {
    e: enabled ? 1 : 0,
    openid,
  });
}

/** 删除一个员工 */
export async function deleteAdmin(openid) {
  if (!pool) throw new Error('未开启数据库');
  await pool.execute(`DELETE FROM admins WHERE openid=:openid`, { openid });
}

/** 统计启用中的超管数量（用于"不能删掉最后一个超管"保护） */
export async function countEnabledSupers() {
  if (!pool) return 0;
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM admins WHERE role='super' AND enabled=1`
  );
  return Number(row.n);
}

// ---------------- 客户（企微缓存 + 定向身份桥）----------------

/** 企微同步：upsert 一个客户。unionid 用 COALESCE 避免被空值冲掉。 */
export async function upsertCustomer(c) {
  if (!pool) return;
  await pool.execute(
    `INSERT INTO customers
       (external_userid, remark, name, avatar, corp_name, mobiles, tags, follow_userid, unionid, synced_at)
     VALUES (:eu, :remark, :name, :avatar, :corp_name, :mobiles, :tags, :follow, :unionid, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE remark=VALUES(remark), name=VALUES(name), avatar=VALUES(avatar),
       corp_name=VALUES(corp_name), mobiles=VALUES(mobiles), tags=VALUES(tags),
       follow_userid=VALUES(follow_userid), unionid=COALESCE(VALUES(unionid), unionid),
       synced_at=CURRENT_TIMESTAMP`,
    {
      eu: c.externalUserid,
      remark: clip(c.remark || '', 64),
      name: clip(c.name || '', 64),
      avatar: c.avatar || null,
      corp_name: c.corpName ? clip(c.corpName, 128) : null,
      mobiles: JSON.stringify(c.mobiles || []),
      tags: JSON.stringify(c.tags || []),
      follow: c.followUserid || null,
      unionid: c.unionid || null,
    }
  );
  // 跟进关系是多对多（客户可能加了多个员工），customers.follow_userid 会被后同步的覆盖，
  // 这里把每条 (客户, 跟进人) 都记入 customer_follows，群发按 sender 分组时用
  if (c.followUserid) {
    await pool.execute(
      `INSERT INTO customer_follows (external_userid, userid)
       VALUES (:eu, :uid)
       ON DUPLICATE KEY UPDATE synced_at=CURRENT_TIMESTAMP`,
      { eu: c.externalUserid, uid: c.followUserid }
    );
  }
}

/**
 * 查一批客户的完整跟进人列表：external_userid -> [userid...]。
 * customer_follows 还没数据的客户（改版后未重新同步）退回 customers.follow_userid 单值。
 */
export async function getFollowMap(eus = []) {
  const map = new Map();
  if (!pool || !eus.length) return map;
  const ph = eus.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT external_userid, userid FROM customer_follows WHERE external_userid IN (${ph})`,
    eus
  );
  for (const r of rows) {
    if (!map.has(r.external_userid)) map.set(r.external_userid, []);
    map.get(r.external_userid).push(r.userid);
  }
  const missing = eus.filter((eu) => !map.has(eu));
  if (missing.length) {
    const ph2 = missing.map(() => '?').join(',');
    const [rows2] = await pool.query(
      `SELECT external_userid, follow_userid FROM customers
        WHERE external_userid IN (${ph2}) AND follow_userid IS NOT NULL`,
      missing
    );
    for (const r of rows2) map.set(r.external_userid, [r.follow_userid]);
  }
  return map;
}

/** 搜索客户（按备注名/昵称 LIKE）。返回是否已开过小程序(opened)。 */
export async function searchCustomers({ q = '', followUserid = '', limit = 50, offset = 0 } = {}) {
  if (!pool) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const where = [];
  const params = {};
  if (q) {
    where.push('(remark LIKE :q OR name LIKE :q)');
    params.q = `%${q}%`;
  }
  if (followUserid) {
    where.push('follow_userid = :fu');
    params.fu = followUserid;
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [rows] = await pool.query(
    `SELECT external_userid, remark, name, avatar, corp_name, tags, follow_userid,
            (openid IS NOT NULL) AS opened
       FROM customers ${whereSql}
      ORDER BY remark ASC, name ASC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );
  return rows.map((r) => ({ ...r, opened: !!r.opened }));
}

/** 按 unionid 查客户（只读）。企微同步后本地就有 unionid，领取时优先走库、不必调企微。 */
export async function findCustomerByUnionid(unionid) {
  if (!pool || !unionid) return null;
  const [rows] = await pool.query(
    `SELECT external_userid FROM customers WHERE unionid=:unionid LIMIT 1`,
    { unionid }
  );
  return rows.length ? rows[0].external_userid : null;
}

/** 客户开小程序后：用 unionid 回填 openid，并返回其 external_userid（定向桥的落地点） */
export async function bindCustomerByUnionid(unionid, openid) {
  if (!pool || !unionid) return null;
  await pool.execute(`UPDATE customers SET openid=:openid WHERE unionid=:unionid`, { openid, unionid });
  const [rows] = await pool.query(
    `SELECT external_userid FROM customers WHERE unionid=:unionid LIMIT 1`,
    { unionid }
  );
  return rows.length ? rows[0].external_userid : null;
}

/** 直接用 external_userid 回填 openid（备用：已知客户身份时） */
export async function bindCustomerOpenid(externalUserid, openid) {
  if (!pool || !externalUserid) return;
  await pool.execute(`UPDATE customers SET openid=:openid WHERE external_userid=:eu`, {
    openid,
    eu: externalUserid,
  });
}

/** 找某客户名下"待领取"的定向奖励（用于身份领取，防领错） */
export async function findPendingRewardForTarget(externalUserid) {
  if (!pool || !externalUserid) return null;
  const [rows] = await pool.query(
    `SELECT rid, amount_fen, remark, recipient_name, expires_at, status
       FROM rewards
      WHERE target_external_userid = :t AND status = 'CREATED'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at ASC LIMIT 1`,
    { t: externalUserid }
  );
  return rows.length ? rows[0] : null;
}

/** 某客户名下待领奖励汇总（大额拆单后一人多笔，前端显示"共 N 笔 · 合计"用） */
export async function countPendingRewardsForTarget(externalUserid) {
  if (!pool || !externalUserid) return { n: 0, fen: 0 };
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_fen),0) AS fen
       FROM rewards
      WHERE target_external_userid = :t AND status = 'CREATED'
        AND (expires_at IS NULL OR expires_at > NOW())`,
    { t: externalUserid }
  );
  return { n: Number(rows[0].n), fen: Number(rows[0].fen) };
}

/** 取一笔奖励的关键字段（撤回/领取拦截用） */
export async function getReward(rid) {
  if (!pool || !rid) return null;
  const [rows] = await pool.execute(
    `SELECT rid, amount_fen, remark, status, target_external_userid FROM rewards WHERE rid=:rid LIMIT 1`,
    { rid }
  );
  return rows.length ? rows[0] : null;
}

/** 撤回一笔未领取(CREATED)的奖励：置 CANCELLED，客户随即不可再领。返回是否真的撤到了 */
export async function revokeReward(rid) {
  if (!pool) throw new Error('未开启数据库');
  const [r] = await pool.execute(
    `UPDATE rewards SET status='CANCELLED' WHERE rid=:rid AND status='CREATED'`,
    { rid }
  );
  return r.affectedRows > 0;
}

/** 客户领取档案：合作次数/累计到账（等级体系的数据源，按领取人 openid 统计真实到账） */
export async function getClaimerProfile(openid) {
  if (!pool || !openid) return { count: 0, totalFen: 0 };
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_fen),0) AS fen
       FROM transfers WHERE claimer_openid=:o AND state='SUCCESS'`,
    { o: openid }
  );
  return { count: Number(row.n), totalFen: Number(row.fen) };
}

/** 客户等级总榜：按真实到账（SUCCESS）以领取人 openid 聚合，联客户档案取名字 */
// 客户等级榜（分页）。minFen/maxFen 用累计到账金额做区间筛选（对应等级门槛），
// 由调用方按 LEVELS 换算传入；不传则全部。DESC 排序 + LIMIT/OFFSET 真分页，几千客户也能翻到底。
export async function getLeaderboard({ limit = 50, offset = 0, minFen = null, maxFen = null } = {}) {
  if (!pool) return [];
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const having = [];
  const params = {};
  if (minFen != null) { having.push('fen >= :minFen'); params.minFen = Math.round(minFen); }
  if (maxFen != null) { having.push('fen < :maxFen'); params.maxFen = Math.round(maxFen); }
  const havingSql = having.length ? 'HAVING ' + having.join(' AND ') : '';
  const [rows] = await pool.query(
    `SELECT t.claimer_openid, COUNT(*) AS n, COALESCE(SUM(t.amount_fen),0) AS fen,
            MAX(c.external_userid) AS external_userid,
            MAX(c.remark) AS remark, MAX(c.name) AS name
       FROM transfers t
       LEFT JOIN customers c ON c.openid = t.claimer_openid
      WHERE t.state = 'SUCCESS'
      GROUP BY t.claimer_openid
      ${havingSql}
      ORDER BY fen DESC, n DESC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );
  return rows;
}

// 各金额档人数分布（SQL 聚合，不受任何列表上限影响，永远准）。
// buckets = [{lv, name, minFen, maxFen}]（maxFen 为该级上界=下一级门槛，最高级为 null）。
export async function getLeaderboardDist(buckets) {
  if (!pool || !buckets || !buckets.length) return { dist: [], total: 0 };
  // 每个客户一行（累计到账 fen），在内存里归档到桶——聚合结果每客户一行、几千行也很轻
  const [rows] = await pool.query(
    `SELECT COALESCE(SUM(t.amount_fen),0) AS fen
       FROM transfers t WHERE t.state='SUCCESS'
      GROUP BY t.claimer_openid`
  );
  const dist = buckets.map((b) => ({ lv: b.lv, name: b.name, count: 0 }));
  for (const r of rows) {
    const fen = Number(r.fen);
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (fen >= buckets[i].minFen) { dist[i].count++; break; }
    }
  }
  return { dist, total: rows.length };
}

/** 查一笔奖励是否是定向的（供 token 领取时拦截，防止绕过定向） */
export async function getRewardTarget(rid) {
  if (!pool || !rid) return null;
  const [rows] = await pool.query(
    `SELECT target_external_userid FROM rewards WHERE rid=:rid LIMIT 1`,
    { rid }
  );
  return rows.length ? rows[0].target_external_userid : null;
}

export const db = {
  dbEnabled,
  migrate,
  seedSuperAdmins,
  ping,
  saveReward,
  recordClaim,
  updateTransferState,
  saveNotifyEvent,
  listRewards,
  getStats,
  getSetting,
  setSetting,
  getPeriodStats,
  adjustQuota,
  listUnfinishedTransfers,
  loadAdmins,
  upsertAdmin,
  setAdminEnabled,
  deleteAdmin,
  countEnabledSupers,
  upsertCustomer,
  getFollowMap,
  searchCustomers,
  findCustomerByUnionid,
  bindCustomerByUnionid,
  bindCustomerOpenid,
  findPendingRewardForTarget,
  countPendingRewardsForTarget,
  getRewardTarget,
  getReward,
  revokeReward,
  getClaimerProfile,
  getLeaderboard,
  getLeaderboardDist,
};

export default db;
