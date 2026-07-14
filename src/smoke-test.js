// ============================================================
//  冒烟测试：验证微信支付商户配置是否全部有效
//  运行：cd server && node src/smoke-test.js
//  原理：用一个【已签名】的 GET /v3/certificates 请求下载平台证书。
//        能成功 = 签名链路 + APIv3密钥 + IP白名单 全部正确。
//        不动钱、不需要 openid。
// ============================================================
import { config } from './config.js';
import { refreshPlatformCerts } from './wechat-pay.js';

console.log('=== 微信支付 V3 冒烟测试 ===');
console.log('商户号   MCHID :', config.wechatpay.mchid);
console.log('商户证书 SERIAL:', config.wechatpay.merchantSerial);
console.log('转账用   APPID :', config.wechatpay.appid);
console.log('转账场景 SCENE :', config.wechatpay.transferSceneId);
console.log('\n正在用已签名请求下载平台证书（同时验证 签名/私钥/APIv3密钥/IP白名单）...\n');

try {
  const certs = await refreshPlatformCerts();
  console.log('✅ 成功！你的微信支付商户配置全部有效。');
  console.log('下载到的平台证书序列号：');
  for (const c of certs) console.log('   -', c.serial);
  console.log(
    '\n含义：能走到这一步，说明 商户号 / 商户证书序列号 / apiclient_key.pem 私钥 /' +
    ' APIv3密钥 / 服务器IP白名单 都是对的，签名与加密内核已打通。'
  );
} catch (e) {
  console.error('❌ 失败：', e.message);
  console.error('\n按报错对照排查：');
  console.error('  · 401 / sign error / 签名错误  → 商户证书序列号 或 私钥 apiclient_key.pem 不匹配');
  console.error('  · 平台证书解密失败 / bad decrypt → APIv3 密钥不对（必须是商户平台设置的那 32 位）');
  console.error('  · not in whitelist / 来源IP无权限 → 当前服务器公网IP未加入 商户平台→API安全→IP白名单');
  console.error('  · certificate/ssl 相关          → 私钥文件不完整或格式不对');
  process.exit(1);
}
