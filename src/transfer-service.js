// ============================================================
//  商家转账业务逻辑（新版 transfer-bills · 需用户确认收款）
//  发起转账 → 返回 package_info 给小程序拉起确认页
//  查询转账单 → 对账/看状态
// ============================================================
import { config } from './config.js';
import { wechatpay } from './wechat-pay.js';

const TRANSFER_PATH = '/v3/fund-app/mch-transfer/transfer-bills';

/**
 * 发起一笔商家转账
 * @param {object} p
 * @param {string} p.outBillNo  商户单号（用奖励 rid，天然幂等：同单号重复调用不会重复付款）
 * @param {string} p.openid     收款人 openid（必须是本小程序 appid 下的 openid）
 * @param {number} p.amountFen  金额（分）
 * @param {string} p.remark     转账备注（用户可见，≤32字）
 * @param {string} [p.name]     收款人真实姓名（≥2000元必填；<0.3元不可填）
 * @param {Array}  [p.sceneReportInfos] 场景报备信息
 * @returns {Promise<{out_bill_no:string, transfer_bill_no:string, state:string, package_info:string, create_time:string}>}
 */
export async function createTransferBill({ outBillNo, openid, amountFen, remark, name, sceneReportInfos }) {
  amountFen = Math.round(Number(amountFen));
  if (!Number.isInteger(amountFen) || amountFen <= 0) {
    throw new Error('转账金额必须是大于0的整数（单位：分）');
  }
  if (amountFen > config.app.maxAmountYuan * 100) {
    throw new Error(`转账金额超过上限 ${config.app.maxAmountYuan} 元`);
  }
  if (!openid) throw new Error('缺少收款人 openid');

  const body = {
    appid: config.wechatpay.appid,
    out_bill_no: outBillNo,
    transfer_scene_id: config.wechatpay.transferSceneId,
    openid,
    transfer_amount: amountFen,
    transfer_remark: String(remark || '客户奖励').slice(0, 32),
    transfer_scene_report_infos:
      sceneReportInfos && sceneReportInfos.length
        ? sceneReportInfos
        : [
            { info_type: '活动名称', info_content: '客户奖励发放' },
            { info_type: '奖励说明', info_content: String(remark || '客户奖励').slice(0, 32) },
          ],
  };
  if (config.wechatpay.notifyUrl) body.notify_url = config.wechatpay.notifyUrl;

  const opts = {};
  // 姓名规则：金额≥2000元必须传真实姓名；金额<0.3元不允许传姓名
  if (name) {
    if (amountFen < 30) throw new Error('转账金额小于 0.3 元时不支持填写收款人姓名');
    const { serial, ciphertext } = await wechatpay.encryptSensitive(name);
    body.user_name = ciphertext;
    opts.serial = serial; // Wechatpay-Serial 头：声明加密所用证书/公钥
  } else if (amountFen >= 200000) {
    throw new Error('转账金额 ≥ 2000 元时必须填写收款人真实姓名');
  }

  const { status, data } = await wechatpay.request('POST', TRANSFER_PATH, body, opts);
  if (status !== 200) {
    const err = new Error(`发起转账失败: HTTP ${status} ${data.code || ''} ${data.message || ''}`);
    err.status = status;
    err.data = data;
    throw err;
  }
  return data; // { out_bill_no, transfer_bill_no, state, package_info, create_time }
}

/** 按商户单号查询转账单状态 */
export async function queryTransferByOutBillNo(outBillNo) {
  const path = `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(outBillNo)}`;
  const { status, data } = await wechatpay.request('GET', path);
  if (status !== 200) {
    const err = new Error(`查询转账单失败: HTTP ${status} ${data.code || ''} ${data.message || ''}`);
    err.status = status;
    err.data = data;
    throw err;
  }
  return data;
}
