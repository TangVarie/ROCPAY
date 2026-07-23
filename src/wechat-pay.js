// ============================================================
//  微信支付 V3 内核
//  - 请求签名（Authorization 头）
//  - 平台证书自动下载 + APIv3 密钥解密（AES-256-GCM）
//  - 敏感字段加密（RSA-OAEP，如 user_name）
//  - 回调/响应验签
//  参考：微信支付V3 接口规则、商家转账
// ============================================================
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from './config.js';

const BASE_URL = 'https://api.mch.weixin.qq.com';

// 商户私钥（apiclient_key.pem，用于给请求签名）：优先环境变量 PEM，否则读文件
let merchantPrivateKey;
try {
  merchantPrivateKey = crypto.createPrivateKey(
    config.wechatpay.privateKeyPem || readFileSync(config.wechatpay.privateKeyPath, 'utf8')
  );
} catch (e) {
  throw new Error(
    `[配置错误] 商户私钥解析失败：${e.message}\n` +
      `  多半是 WECHATPAY_PRIVATE_KEY 的换行没弄对（PEM 的 BEGIN/正文/END 之间必须有换行）。\n` +
      `  最稳妥办法：改用 WECHATPAY_PRIVATE_KEY_BASE64 —— 把整个私钥文件 base64 后填入：\n` +
      `      base64 -w0 apiclient_key.pem      （macOS: base64 apiclient_key.pem | tr -d '\\n'）\n` +
      `  并确认填的是【商户私钥 apiclient_key.pem】，不是证书 apiclient_cert.pem。`
  );
}

// 平台公钥缓存：serial -> publicKeyObject（用于验签/加密）
const platformKeys = new Map();

// 若配置了「微信支付公钥」模式，直接载入（PEM 环境变量或文件）
if (config.wechatpay.publicKeyId && (config.wechatpay.publicKeyPem || config.wechatpay.publicKeyPath)) {
  const pem = config.wechatpay.publicKeyPem || readFileSync(config.wechatpay.publicKeyPath, 'utf8');
  platformKeys.set(config.wechatpay.publicKeyId, crypto.createPublicKey(pem));
}

// ---------------- 工具 ----------------
const nonceStr = () => crypto.randomBytes(16).toString('hex').toUpperCase();
const nowTs = () => Math.floor(Date.now() / 1000).toString();

// 生成请求签名的 Authorization 头
function buildAuthorization(method, urlPath, body) {
  const ts = nowTs();
  const nonce = nonceStr();
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`;
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(message, 'utf8'), merchantPrivateKey)
    .toString('base64');
  return (
    `WECHATPAY2-SHA256-RSA2048 ` +
    `mchid="${config.wechatpay.mchid}",` +
    `nonce_str="${nonce}",` +
    `timestamp="${ts}",` +
    `serial_no="${config.wechatpay.merchantSerial}",` +
    `signature="${signature}"`
  );
}

// AES-256-GCM 解密（平台证书下载、回调报文解密都用它）
export function decryptAesGcm({ ciphertext, nonce, associated_data }) {
  const key = Buffer.from(config.wechatpay.apiV3Key, 'utf8'); // 32 字节
  const buf = Buffer.from(ciphertext, 'base64');
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (associated_data) decipher.setAAD(Buffer.from(associated_data, 'utf8'));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * 发起一次已签名的 V3 请求
 * @param {'GET'|'POST'} method
 * @param {string} urlPath  形如 /v3/fund-app/mch-transfer/transfer-bills（含 query）
 * @param {object|null} body
 * @param {object} [opts] { serial } 需要传敏感信息时，serial=加密所用证书/公钥序列号
 * @returns {Promise<{status:number, data:any, headers:Headers}>}
 */
export async function request(method, urlPath, body = null, opts = {}) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = {
    Authorization: buildAuthorization(method, urlPath, bodyStr),
    Accept: 'application/json',
    // 微信支付只认简单的 Accept-Language（如 zh-CN），显式写死，
    // 覆盖运行时/代理可能注入的复杂值（否则报 HTTP 406 传入了不支持的 Accept-Language）
    'Accept-Language': 'zh-CN',
    'User-Agent': 'wecom-transfer/1.0 (+node)',
  };
  if (bodyStr) headers['Content-Type'] = 'application/json';
  // 请求里带了加密字段时，必须告诉微信用的是哪个证书/公钥
  if (opts.serial) headers['Wechatpay-Serial'] = opts.serial;

  // 加超时：微信支付/网络黑洞时，转账、查单、验签、余额等调用不会无限挂起（默认 10s）
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 10000);
  let res;
  try {
    res = await fetch(BASE_URL + urlPath, {
      method,
      headers,
      body: bodyStr || undefined,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  return { status: res.status, data, headers: res.headers };
}

// ---------------- 平台证书 ----------------

// 下载并缓存平台证书（用 APIv3 密钥解密）。返回 [{serial, publicKey}]
export async function refreshPlatformCerts() {
  const { status, data } = await request('GET', '/v3/certificates');
  if (status !== 200 || !data.data) {
    throw new Error(`下载平台证书失败：HTTP ${status} ${JSON.stringify(data)}`);
  }
  const result = [];
  for (const item of data.data) {
    const certPem = decryptAesGcm(item.encrypt_certificate);
    const pub = crypto.createPublicKey(certPem);
    platformKeys.set(item.serial_no, pub);
    result.push({ serial: item.serial_no, publicKey: pub, certPem });
  }
  return result;
}

// 取某个 serial 对应的验签/加密公钥；没有则尝试刷新
async function getPlatformKey(serial) {
  if (serial && platformKeys.has(serial)) return platformKeys.get(serial);
  await refreshPlatformCerts();
  if (serial && platformKeys.has(serial)) return platformKeys.get(serial);
  // 未指定 serial 时，返回任意一个可用公钥
  if (!serial && platformKeys.size) return [...platformKeys.values()][0];
  throw new Error(`找不到 serial=${serial} 对应的平台公钥`);
}

// 返回“用于加密/需要在 Wechatpay-Serial 头里声明”的序列号与公钥
async function getEncryptTarget() {
  // 微信支付公钥模式优先
  if (config.wechatpay.publicKeyId) {
    return { serial: config.wechatpay.publicKeyId, publicKey: platformKeys.get(config.wechatpay.publicKeyId) };
  }
  const certs = await refreshPlatformCerts();
  const latest = certs[certs.length - 1];
  return { serial: latest.serial, publicKey: latest.publicKey };
}

// 敏感字段加密（RSA-OAEP，SHA-1）。返回 base64 密文
export function rsaEncrypt(plaintext, publicKey) {
  return crypto
    .publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      Buffer.from(plaintext, 'utf8')
    )
    .toString('base64');
}

// 便捷：对一个明文做加密，并返回加密所需的 serial（供 Wechatpay-Serial 头）
export async function encryptSensitive(plaintext) {
  const { serial, publicKey } = await getEncryptTarget();
  return { serial, ciphertext: rsaEncrypt(plaintext, publicKey) };
}

// 验签：校验回调/响应的 Wechatpay-Signature
export async function verifySignature({ timestamp, nonce, body, signature, serial }) {
  // 回调可能被误触/探测（缺 Wechatpay-* 头）：直接判不通过，不能让 Buffer.from(undefined) 崩栈
  if (!timestamp || !nonce || !signature || !serial || body == null) return false;
  const publicKey = await getPlatformKey(serial);
  const message = `${timestamp}\n${nonce}\n${body}\n`;
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(message, 'utf8'),
    publicKey,
    Buffer.from(signature, 'base64')
  );
}

export const wechatpay = {
  request,
  refreshPlatformCerts,
  encryptSensitive,
  rsaEncrypt,
  decryptAesGcm,
  verifySignature,
};

export default wechatpay;
