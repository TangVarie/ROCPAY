-- ============================================================
--  ROCPAY 业务库 · MySQL 建表脚本（微信云托管自带 MySQL）
--  说明：
--   · 后端启动时会自动执行等价的 CREATE TABLE IF NOT EXISTS（见 src/db.js）。
--     所以正常情况下你【不需要】手动跑这个文件；它仅供参考 / 手动初始化用。
--   · 若你把 DB_AUTO_MIGRATE 设为 false，则请在云托管 MySQL 控制台粘贴执行本文件。
--   · 字符集 utf8mb4，兼容 MySQL 5.7.8+ / 8.0（JSON 类型需 5.7.8+）。
--  用法（云托管 MySQL「数据库管理」网页控制台）：先建库，再执行本文件。
--    CREATE DATABASE IF NOT EXISTS rocpay DEFAULT CHARSET utf8mb4;
--    USE rocpay;
-- ============================================================

-- 发放的奖励（员工在小程序生成一笔奖励即 insert 一行）
CREATE TABLE IF NOT EXISTS rewards (
  rid            VARCHAR(32)  NOT NULL PRIMARY KEY COMMENT '奖励ID=商户单号 out_bill_no',
  amount_fen     INT UNSIGNED NOT NULL COMMENT '金额(分)',
  remark         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '备注(用户可见)',
  recipient_name VARCHAR(64)  NULL COMMENT '收款人真实姓名(可选·PII)',
  target_external_userid VARCHAR(64) NULL COMMENT '定向目标企微客户(P2)，NULL=非定向',
  batch_id       VARCHAR(32)  NULL COMMENT '批次号：同一次批量发放的多笔共用，按批查看/撤回用',
  revoked_by     VARCHAR(64)  NULL COMMENT '撤回操作人openid(审计:谁撤的这笔钱)',
  revoked_at     DATETIME     NULL COMMENT '撤回操作时间',
  created_by     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '发放人(管理员)openid',
  status         VARCHAR(24)  NOT NULL DEFAULT 'CREATED' COMMENT 'CREATED|CLAIMED|SUCCESS|FAIL|CLOSED',
  expires_at     DATETIME     NULL COMMENT '领取有效期',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_rewards_created_by (created_by),
  KEY idx_rewards_status (status),
  KEY idx_rewards_batch (batch_id),
  KEY idx_rewards_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='发放的奖励';

-- 实际发起的转账（客户领取时 insert；out_bill_no=rewards.rid，天然幂等）
CREATE TABLE IF NOT EXISTS transfers (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='实际发起的转账';

-- 微信回调审计流水（每收到一条 /api/notify 就 insert 一行）
CREATE TABLE IF NOT EXISTS notify_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_type       VARCHAR(64)  NULL,
  out_bill_no      VARCHAR(32)  NULL,
  transfer_bill_no VARCHAR(64)  NULL,
  state            VARCHAR(32)  NULL,
  raw              JSON         NULL COMMENT '解密后的回调原文',
  received_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notify_out_bill_no (out_bill_no),
  KEY idx_notify_received_at (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='微信回调审计流水';

-- 员工/管理员（ADMIN_OPENIDS 里的人启动时自动写成 super）
CREATE TABLE IF NOT EXISTS admins (
  openid       VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT '员工的小程序openid',
  name         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '备注名(谁)',
  role         VARCHAR(16)  NOT NULL DEFAULT 'operator' COMMENT 'super|operator',
  enabled      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '是否启用',
  wecom_userid VARCHAR(64)  NULL COMMENT '员工的企微userid(群发sender映射)',
  created_by   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '谁添加的',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_admins_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='员工/管理员';

-- 客户↔跟进员工 多对多（customers.follow_userid/remark 都只有一列，多跟进时会互相覆盖；
-- 群发按 sender 分组需要完整跟进关系，每个员工要看到自己起的备注，所以单独记一张表）
CREATE TABLE IF NOT EXISTS customer_follows (
  external_userid VARCHAR(64) NOT NULL COMMENT '企微外部联系人ID',
  userid          VARCHAR(64) NOT NULL COMMENT '跟进员工的企微userid',
  remark          VARCHAR(64) NOT NULL DEFAULT '' COMMENT '该跟进人给客户起的备注名(每人各自一份)',
  synced_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (external_userid, userid),
  KEY idx_cf_userid (userid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客户-跟进员工多对多(群发sender分组+每人备注)';

-- 企微客户缓存 + 身份映射（P2·按备注名搜索、unionid 定向桥）
CREATE TABLE IF NOT EXISTS customers (
  external_userid VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT '企微外部联系人ID',
  remark          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '备注名兜底单值(最后同步的跟进人的；每人各自的在customer_follows.remark)',
  name            VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '客户微信昵称',
  avatar          VARCHAR(512) NULL,
  corp_name       VARCHAR(128) NULL,
  mobiles         JSON         NULL COMMENT '备注手机号',
  tags            JSON         NULL COMMENT '标签',
  follow_userid   VARCHAR(64)  NULL COMMENT '跟进员工企微userid',
  unionid         VARCHAR(64)  NULL COMMENT 'unionid(定向桥)',
  openid          VARCHAR(64)  NULL COMMENT '客户开过小程序后回填',
  synced_at       DATETIME     NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_customers_remark (remark),
  KEY idx_customers_unionid (unionid),
  KEY idx_customers_openid (openid),
  KEY idx_customers_follow (follow_userid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='企微客户缓存+身份映射';

-- 通用键值设置（如可发额度锚点 quota_base_fen / 锚点已发放 quota_base_paid_fen）
CREATE TABLE IF NOT EXISTS settings (
  k          VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT '设置键',
  v          TEXT         NULL COMMENT '设置值',
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='通用键值设置(如打款周期)';

-- ============================================================
--  老库升级（幂等，可重复执行）
--  CREATE TABLE IF NOT EXISTS 对已存在的表不会补新列；DB_AUTO_MIGRATE=true（默认）
--  时后端启动会自动补列，无需执行本段；关闭自动迁移、手动维护表结构的库，
--  升级时请连同上文一起执行本段（MySQL 无 ADD COLUMN IF NOT EXISTS，
--  这里用 information_schema 判断后动态执行，已有该列时自动跳过）。
-- ============================================================

-- customer_follows.remark：每个跟进人各自的客户备注名（执行后需重跑一次「从企微同步」回填）
SET @cf_has_remark := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'customer_follows' AND column_name = 'remark');
SET @cf_ddl := IF(@cf_has_remark = 0,
  'ALTER TABLE customer_follows ADD COLUMN remark VARCHAR(64) NOT NULL DEFAULT '''' COMMENT ''该跟进人给客户起的备注名(每人各自一份)'' AFTER userid',
  'SELECT ''customer_follows.remark 已存在，跳过'' AS note');
PREPARE cf_stmt FROM @cf_ddl;
EXECUTE cf_stmt;
DEALLOCATE PREPARE cf_stmt;
