// ============================================================
//  数据库小工具：连通性自检 / 手动建表
//  用法：
//    npm run db:ping      # 测试能否连上 MySQL（返回 SELECT 1）
//    npm run db:migrate   # 手动建表（等价于服务启动时的自动建表）
//  依赖 .env 里的 MYSQL_* 配置。
// ============================================================
import { config } from './config.js';
import { db } from './db.js';

const cmd = process.argv[2] || 'ping';

if (!config.db.enabled) {
  console.error('❌ 未配置数据库：请在 .env / 云托管环境变量里填 MYSQL_URL 或 MYSQL_HOST 等。');
  process.exit(1);
}

try {
  if (cmd === 'ping') {
    const r = await db.ping();
    if (r.ok) {
      console.log('✅ 数据库连通正常。');
    } else {
      console.error('❌ 连接失败：', r.error);
      process.exit(1);
    }
  } else if (cmd === 'migrate') {
    await db.migrate();
    console.log('✅ 建表完成（rewards / transfers / notify_events）。');
  } else {
    console.error(`未知命令 ${cmd}，可用：ping | migrate`);
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  console.error('❌ 执行失败：', e.code || e.message);
  process.exit(1);
}
