// ============================================================
//  微信小程序服务端客户端（订阅消息直达通知）
//  作用：定向发放后不经企微群发，直接给客户的微信推「服务通知」，点开直达领取页。
//  前提（微信平台规则，绕不开）：订阅消息是小程序唯一的主动触达通道——
//  客户必须先在小程序内对该模板点过一次「允许」，一次授权=可发一条；
//  授权配额由本服务记账（subscribe_quota 表），微信侧也各自计数，以先耗尽者为准。
//  鉴权双模式：
//   · WECHAT_APPSECRET：标准 access_token 流（https://api.weixin.qq.com）
//   · WECHAT_CLOUDBASE_OPENAPI=true：微信云托管「开放接口服务」，容器内直连
//     http://api.weixin.qq.com 免 token（云托管自动注入身份）
// ============================================================
import { config } from './config.js';

export const subscribeEnabled = config.weixin.subscribeEnabled;

let tokenCache = { token: '', exp: 0 };
let tokenPromise = null;

// 微信接口统一超时（默认 6s）：不让通知链路拖死管理端请求
async function fetchWT(url, opts = {}, ms = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function parseResponse(res, action) {
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`微信 ${action} 返回了非 JSON 响应`); }
  if (!res.ok) throw new Error(`微信 ${action} HTTP ${res.status}：${data.errmsg || text.slice(0, 200)}`);
  return data;
}

/** 获取并缓存小程序 access_token（提前 5 分钟过期）。云托管开放接口模式不需要 token */
async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.exp) return tokenCache.token;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const url =
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(config.wechatpay.appid)}&secret=${encodeURIComponent(config.weixin.appSecret)}`;
    const data = await parseResponse(await fetchWT(url), 'token');
    if (data.errcode) throw new Error(`微信取 access_token 失败：${data.errcode} ${data.errmsg}`);
    if (!data.access_token) throw new Error('微信 token 接口返回缺少 access_token');
    const ttl = Math.max(Number(data.expires_in) || 7200, 301);
    tokenCache = { token: data.access_token, exp: Date.now() + (ttl - 300) * 1000 };
    return tokenCache.token;
  })();
  try { return await tokenPromise; } finally { tokenPromise = null; }
}

async function call(path, body) {
  let url;
  if (config.weixin.cloudbaseOpenapi) {
    // 云托管开放接口服务：容器内 http 直连，平台自动注入凭证，无需 access_token
    url = `http://api.weixin.qq.com${path}`;
  } else {
    const token = await getToken();
    url = `https://api.weixin.qq.com${path}?access_token=${encodeURIComponent(token)}`;
  }
  const data = await parseResponse(
    await fetchWT(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    path
  );
  // token 失效：清缓存，下次调用重取（本次仍抛错，由调用方决定是否重试）
  if ((data.errcode === 42001 || data.errcode === 40001) && !config.weixin.cloudbaseOpenapi) {
    tokenCache = { token: '', exp: 0 };
  }
  return data;
}

/**
 * 按模板字段映射填充占位符并按微信字段类型裁剪。
 * mapping: { "thing1": "{remark}", "amount2": "¥{amount}", ... }
 * vars:    { remark, amount, count, time }
 * 微信对字段值有硬性长度/格式校验（超长直接 47003 拒发）：
 *   thing* ≤20 字符 / phrase* ≤5 / character_string* ≤32 / name* ≤10
 */
function fillTemplateData(mapping, vars) {
  const out = {};
  for (const [k, tpl] of Object.entries(mapping)) {
    let v = String(tpl).replace(/\{(\w+)\}/g, (_, name) => (vars[name] != null ? String(vars[name]) : ''));
    if (/^thing/.test(k) && v.length > 20) v = v.slice(0, 17) + '...';
    else if (/^phrase/.test(k)) v = v.slice(0, 5);
    else if (/^character_string/.test(k)) v = v.slice(0, 32);
    else if (/^name/.test(k) && v.length > 10) v = v.slice(0, 10);
    out[k] = { value: v };
  }
  return out;
}

/**
 * 给一个 openid 发一条订阅消息（奖励待领取提醒）。
 * 返回 { ok:true } 或 { ok:false, errcode, error, quotaExhausted }
 *   quotaExhausted=true（errcode 43101）：该用户微信侧授权已用完/从未授权——
 *   调用方应把本地配额对齐清零，并把该客户归入"未订阅"名单走兜底通知。
 */
export async function sendRewardNotice({ openid, remark, amountYuan, count }) {
  if (!subscribeEnabled) return { ok: false, error: '订阅消息未配置' };
  const vars = {
    remark: remark || '客户奖励',
    amount: Number(amountYuan || 0).toFixed(2),
    count: Number(count || 1),
    // 北京时间（模板 time 字段要求本地可读时间；容器时钟为 UTC，显式 +8）
    time: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
  };
  let data;
  try {
    data = await call('/cgi-bin/message/subscribe/send', {
      touser: openid,
      template_id: config.weixin.subscribeTemplateId,
      page: config.weixin.subscribePage,
      data: fillTemplateData(config.weixin.subscribeData, vars),
      miniprogram_state: 'formal',
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!data.errcode) return { ok: true };
  return {
    ok: false,
    errcode: data.errcode,
    quotaExhausted: data.errcode === 43101, // 用户未订阅或授权次数已用完
    error:
      data.errcode === 43101
        ? '客户未订阅提醒或授权次数已用完'
        : data.errcode === 47003
          ? `模板字段不合法（检查 WECHAT_SUBSCRIBE_DATA 与模板字段是否一致）：${data.errmsg}`
          : `微信订阅消息发送失败：${data.errcode} ${data.errmsg}`,
  };
}

export const weixin = { subscribeEnabled, sendRewardNotice };
export default weixin;
