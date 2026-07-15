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
  created_by     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '发放人(管理员)openid',
  status         VARCHAR(24)  NOT NULL DEFAULT 'CREATED' COMMENT 'CREATED|CLAIMED|SUCCESS|FAIL|CLOSED',
  expires_at     DATETIME     NULL COMMENT '领取有效期',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_rewards_created_by (created_by),
  KEY idx_rewards_status (status),
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
  openid     VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT '员工的小程序openid',
  name       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '备注名(谁)',
  role       VARCHAR(16)  NOT NULL DEFAULT 'operator' COMMENT 'super|operator',
  enabled    TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '是否启用',
  created_by VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '谁添加的',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_admins_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='员工/管理员';
