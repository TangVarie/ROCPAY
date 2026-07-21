// ============================================================
//  企业微信「接收消息服务器」回调验签 / 解密（WXBizMsgCrypt 兼容）
//  用途：满足企微「设置接收消息服务器URL」这一前置，从而解锁「企业可信IP」白名单。
//   - GET  URL 验证：验签 + 解密 echostr，把明文原样回给企微 = 验证通过
//   - POST 事件回调：本系统不消费企微事件，回空 200 即可（企微视为无需回复）
//  依赖：WECOM_CALLBACK_TOKEN + WECOM_CALLBACK_AES_KEY
//        （在企微「自建应用 → 接收消息 → API 接收消息」里点「随机获取」生成）
// ============================================================
import crypto from 'node:crypto';
import { config } from './config.js';

export const callbackEnabled = !!(config.wecom.callbackToken && config.wecom.callbackAesKey);

// EncodingAESKey(43 位) 补一个 '=' 后 Base64 解出 32 字节 AESKey；IV = AESKey 前 16 字节
function aesKeyBuf() {
  return Buffer.from(config.wecom.callbackAesKey + '=', 'base64');
}

// 企微签名：SHA1( sort(token, timestamp, nonce, encrypt).join('') )
function sign(...parts) {
  return crypto.createHash('sha1').update(parts.sort().join('')).digest('hex');
}

// 解密企微密文：AES-256-CBC / 无自动填充；明文 = 16 随机字节 + 4 字节网络序长度 + msg + receiveId + PKCS7
function decrypt(encrypted) {
  const key = aesKeyBuf();
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let buf = Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()]);
  buf = buf.subarray(0, buf.length - buf[buf.length - 1]); // 去 PKCS7 padding
  const msgLen = buf.readUInt32BE(16);
  return {
    msg: buf.subarray(20, 20 + msgLen).toString('utf8'),
    receiveId: buf.subarray(20 + msgLen).toString('utf8'),
  };
}

/**
 * URL 验证（企微保存「接收消息服务器URL」时发起的 GET）。
 * 成功返回解密后的明文 echostr（原样回给企微即验证通过）；任何不匹配都抛错。
 */
export function verifyUrl({ msgSignature, timestamp, nonce, echostr }) {
  if (!callbackEnabled) {
    throw new Error('企微回调未配置（需 WECOM_CALLBACK_TOKEN + WECOM_CALLBACK_AES_KEY）');
  }
  if (sign(config.wecom.callbackToken, timestamp, nonce, echostr) !== msgSignature) {
    throw new Error('签名不匹配（检查 Token 是否与企微一致）');
  }
  const { msg, receiveId } = decrypt(echostr);
  if (config.wecom.corpid && receiveId && receiveId !== config.wecom.corpid) {
    throw new Error(`receiveId(${receiveId}) 与 corpid 不一致（检查 WECOM_CORPID）`);
  }
  return msg;
}

export default { callbackEnabled, verifyUrl };
