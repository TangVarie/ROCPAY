// ============================================================
//  奖励领取令牌（无状态·HMAC 签名）
//  员工生成奖励 → 得到一个 token，塞进领取链接发给客户；
//  客户领取时后端校验 token，防止金额被前端篡改。
//  载荷：{ rid, fen, remark, name, exp }
// ============================================================
import crypto from 'node:crypto';
import { config } from './config.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// 生成 32 位商户单号(out_bill_no)。定向奖励用它，无需令牌。
export function newRid() {
  return crypto.randomUUID().replace(/-/g, '');
}

function hmac(dataStr) {
  const secret = config.app.rewardTokenSecret;
  if (!secret) throw new Error('未配置 REWARD_TOKEN_SECRET，无法签发/校验领取令牌');
  return crypto.createHmac('sha256', secret).update(dataStr).digest('base64url');
}

// 生成令牌。fen=金额(分)，remark=备注，name=收款人姓名(可选)
// rid 可由调用方传入（幂等场景：同一 clientKey 确定性派生同一 rid），不传则随机生成
export function createRewardToken({ fen, remark = '', name = '', rid }) {
  if (!Number.isSafeInteger(fen) || fen <= 0) throw new Error('奖励金额必须是大于 0 的安全整数（单位：分）');
  if (rid != null && !/^[A-Za-z0-9_-]{1,32}$/.test(rid)) throw new Error('奖励单号格式错误');
  const theRid = rid || crypto.randomUUID().replace(/-/g, ''); // 32位，直接当商户单号 out_bill_no
  // 整体取整：REWARD_TTL_HOURS 允许小数（如 1.5），TTL×3600 可能非整——
  // 不取整的话 verifyRewardToken 的整数校验会把自己刚签发的令牌拒收
  const exp = Math.floor(Date.now() / 1000 + config.app.rewardTtlHours * 3600);
  const payload = { rid: theRid, fen, remark, name, exp };
  const data = b64url(JSON.stringify(payload));
  const sig = hmac(data);
  return { token: `${data}.${sig}`, rid: theRid, exp };
}

// 校验令牌，返回载荷；失败抛错
export function verifyRewardToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('领取令牌格式错误');
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('领取令牌格式错误');
  const [data, sig] = parts;
  const expect = hmac(data);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('领取令牌签名无效');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    throw new Error('领取令牌载荷无效');
  }
  if (!payload || typeof payload !== 'object' ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(payload.rid || '') ||
      !Number.isSafeInteger(payload.fen) || payload.fen <= 0 ||
      !Number.isSafeInteger(payload.exp) || payload.exp <= 0) {
    throw new Error('领取令牌载荷无效');
  }
  if (Math.floor(Date.now() / 1000) >= payload.exp) {
    throw new Error('领取链接已过期');
  }
  return payload; // { rid, fen, remark, name, exp }
}
