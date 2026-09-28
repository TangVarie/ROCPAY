// ============================================================
//  校准前核实「待领取」
//  校准时要从可用余额里扣掉待领取（钱还在账户里、但已计入占用）。前提是这些 CREATED
//  行真没发起过转账。发起成功而 recordClaim 两次落库都失败时，钱已被微信冻结、行却还是
//  CREATED 且没有 transfers 行（评审发现）；不核实就会把冻结的钱再扣一遍，剩余被低估。
//  做法：逐笔向微信按商户单号查。查不到 = 真没领；查到了就按微信实况补写台账。
//  任何一笔查询出错都整体失败，调用方据此拒绝校准——宁可让运营稍后重试，不拿不准的数记账。
// ============================================================

const isNotFound = (e) => !!e && (e.status === 404 || (e.data && e.data.code === 'NOT_FOUND'));

/**
 * @param {object} deps
 * @param {object} deps.db    需要 listUnlinkedPendingRids / updateTransferState / markClaimedIfCreated
 * @param {(rid:string)=>Promise<object>} deps.query  按商户单号查微信转账单（404 表示不存在）
 * @param {number} [deps.concurrency]
 * @returns {Promise<{checked:number, healed:number}>}
 */
export async function verifyPendingRewards({ db, query, concurrency = 6 }) {
  const rids = await db.listUnlinkedPendingRids();
  let healed = 0;
  let next = 0;
  const worker = async () => {
    while (next < rids.length) {
      const rid = rids[next++];
      let data;
      try {
        data = await query(rid);
      } catch (e) {
        if (isNotFound(e)) continue; // 微信没有这张单：确实没领，留在待领取
        const err = new Error(`向微信核实待领取失败（${rid}）：${e.message}`);
        err.status = 503;
        throw err;
      }
      await db.updateTransferState({
        outBillNo: data.out_bill_no || rid,
        state: data.state,
        transferBillNo: data.transfer_bill_no,
        failReason: data.fail_reason,
        claimerOpenid: data.openid,
        amountFen: data.transfer_amount,
      });
      await db.markClaimedIfCreated(rid); // 终态已由上一步回写，这里只处理仍在途的
      healed++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rids.length) }, worker));
  return { checked: rids.length, healed };
}
