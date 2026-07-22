// ============================================================
//  企业微信「客户联系」客户端（P2）
//  - 拉客户列表 + 详情（含员工备注名 follow_info.remark、unionid）
//  - unionid → external_userid（定向身份桥）
//  - 企业群发 add_msg_template
//  设计：带开关（未配置 WECOM_* 时 wecomEnabled=false，方法抛清晰错误，调用方降级）。
//  ⚠️ 待真机联调：以下接口路径/参数依据企微「客户联系」文档实现；
//     正式联调时请对最新官方文档逐一核对（尤其 batch/get_by_user 返回结构、
//     unionid_to_external_userid 的必传字段）。
// ============================================================
import { config } from './config.js';

const BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
export const wecomEnabled = config.wecom.enabled;

let tokenCache = { token: '', exp: 0 };

/** 获取并缓存 access_token（提前 5 分钟过期） */
export async function getToken() {
  if (!wecomEnabled) throw new Error('企微未配置（需 WECOM_CORPID + WECOM_CONTACT_SECRET）');
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.exp) return tokenCache.token;
  const url = `${BASE}/gettoken?corpid=${encodeURIComponent(config.wecom.corpid)}&corpsecret=${encodeURIComponent(
    config.wecom.contactSecret
  )}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode) throw new Error(`企微 gettoken 失败：${data.errcode} ${data.errmsg}`);
  tokenCache = { token: data.access_token, exp: now + (Number(data.expires_in || 7200) - 300) * 1000 };
  return tokenCache.token;
}

async function call(method, path, { query = {}, body } = {}) {
  const token = await getToken();
  const qs = new URLSearchParams({ access_token: token, ...query }).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (data.errcode) {
    if (data.errcode === 42001 || data.errcode === 40014) tokenCache = { token: '', exp: 0 }; // token 失效，下次重取
    const err = new Error(`企微 ${path} 失败：${data.errcode} ${data.errmsg}`);
    err.errcode = data.errcode;
    throw err;
  }
  return data;
}

/** 获取所有配置了「客户联系」的员工 userid（同步客户时自动发现，不用手填） */
export async function getFollowUserList() {
  const d = await call('GET', '/externalcontact/get_follow_user_list');
  return d.follow_user || [];
}

/** 列出某员工名下客户的 external_userid */
export async function listExternalUserids(followUserid) {
  const d = await call('GET', '/externalcontact/list', { query: { userid: followUserid } });
  return d.external_userid || [];
}

/**
 * 批量取客户详情（含 follow_info.remark 备注名、external_contact.unionid）。
 * userids: 员工 userid 列表；企微按跟进员工维度返回。
 */
export async function batchGetByUser(userids, cursor = '', limit = 100) {
  return call('POST', '/externalcontact/batch/get_by_user', {
    body: { userid_list: userids, cursor, limit },
  });
}

/** 把当前商户主体下的 unionid 转成企微 external_userid（定向桥）。需同一开放平台主体。 */
export async function unionidToExternalUserid(unionid, openid) {
  const body = { unionid };
  if (openid) body.openid = openid;
  const d = await call('POST', '/externalcontact/unionid_to_external_userid', { body });
  return d.external_userid || null;
}

/** 企业群发（创建群发任务，员工需在企微「群发助手」点发送） */
export async function addMsgTemplate(template) {
  return call('POST', '/externalcontact/add_msg_template', { body: template });
}

/** 上传临时图片素材，返回 media_id（企微临时素材 3 天过期） */
export async function uploadImageMedia(buffer, filename = 'cover.png') {
  const token = await getToken();
  const form = new FormData();
  form.append('media', new Blob([buffer], { type: 'image/png' }), filename);
  const res = await fetch(`${BASE}/media/upload?access_token=${encodeURIComponent(token)}&type=image`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (data.errcode) throw new Error(`企微 media/upload 失败：${data.errcode} ${data.errmsg}`);
  return data.media_id;
}

// 卡片封面 media_id 缓存：临时素材 3 天过期，这里缓存 2 天留足余量，避免每次群发都重传
let coverCache = { mediaId: '', exp: 0 };
/** 取群发卡片封面的 media_id：缓存优先，过期则用传入的图片 buffer 重新上传 */
export async function getCardCoverMediaId(buffer) {
  const now = Date.now();
  if (coverCache.mediaId && now < coverCache.exp) return coverCache.mediaId;
  const mediaId = await uploadImageMedia(buffer, 'reward-cover.png');
  coverCache = { mediaId, exp: now + 2 * 24 * 3600 * 1000 };
  return mediaId;
}

/**
 * 把企微 batch/get_by_user 的一条记录规整成我们 customers 表的形状。
 * 输入：{ external_contact, follow_info }
 */
export function normalizeContact(item) {
  const ec = item.external_contact || {};
  const fi = item.follow_info || {};
  return {
    externalUserid: ec.external_userid,
    name: ec.name || '',
    avatar: ec.avatar || '',
    corpName: ec.corp_name || '',
    unionid: ec.unionid || null,
    remark: fi.remark || '',
    mobiles: fi.remark_mobiles || [],
    tags: (fi.tag_id || []).length ? fi.tag_id : fi.tags || [],
    followUserid: fi.userid || '',
  };
}

export const wecom = {
  wecomEnabled,
  getToken,
  getFollowUserList,
  listExternalUserids,
  batchGetByUser,
  unionidToExternalUserid,
  addMsgTemplate,
  uploadImageMedia,
  getCardCoverMediaId,
  normalizeContact,
};

export default wecom;
