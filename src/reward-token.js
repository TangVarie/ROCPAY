// ============================================================
//  奖励领取令牌（无状态·HMAC 签名）
//  员工生成奖励 → 得到一个 token，塞进领取链接发给客户；
//  客户领取时后端校验 token，防止金额被前端篡改。
//  载荷：{ rid, fen, remark, name, exp }
// ============================================================
import crypto from 'node:crypto';
import { config } from './config.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hmac(dataStr) {
  const secret = config.app.rewardTokenSecret;
  if (!secret) throw new Error('未配置 REWARD_TOKEN_SECRET，无法签发/校验领取令牌');
  return crypto.createHmac('sha256', secret).update(dataStr).digest('base64url');
}

// 生成令牌。fen=金额(分)，remark=备注，name=收款人姓名(可选)
export function createRewardToken({ fen, remark = '', name = '' }) {
  const rid = crypto.randomUUID().replace(/-/g, ''); // 32位，直接当商户单号 out_bill_no
  const exp = Math.floor(Date.now() / 1000) + config.app.rewardTtlHours * 3600;
  const payload = { rid, fen, remark, name, exp };
  const data = b64url(JSON.stringify(payload));
  const sig = hmac(data);
  return { token: `${data}.${sig}`, rid, exp };
}

// 校验令牌，返回载荷；失败抛错
export function verifyRewardToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw new Error('领取令牌格式错误');
  }
  const [data, sig] = token.split('.');
  const expect = hmac(data);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('领取令牌签名无效');
  }
  const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('领取链接已过期');
  }
  return payload; // { rid, fen, remark, name, exp }
}
