// 截图用的页面状态（假数据）。每条 = 一张要看的画面：{ name, page, data }。
// data 会盖在页面 data 的初始值上（由 mp-shots.cjs 从页面源码里读出），所以这里只写和初始值不同的键。
// 页面改了字段名，这里要跟着改——跑脚本时如果某张图不对，先看这里的键还对不对。

// ---------------- 领取页 ----------------
const profile = { lv: 3, name: '银牌伙伴', count: 7, totalYuan: '486.00', nextText: '再领 ¥314.00 升级金牌伙伴' };
const token = {
  mode: 'token', entryReady: true, token: 'demo', amtText: '88.00', remark: '10月探店视频奖励', issuer: '小王',
  status: 'idle', profile, openid: 'oDemoCustomer',
};
const mine = {
  mode: 'mine', entryReady: true, mineAmt: '200.00', mineRemark: '渠道推荐奖励（大额已拆单）', issuer: '小林',
  minePendCount: 3, minePendYuan: '500.00', status: 'idle', profile, openid: 'oDemoCustomer',
};
const RID = 'r1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6';
const adminHome = { hasQuota: true, remainingYuan: '3,268.00', low: false, failCount: 2, todayCount: 14, todayYuan: '1,126.00', totalAllYuan: '48,210' };

const claim = [
  ['claim-loading', { mode: 'loading' }],
  ['claim-error', { mode: 'error', entryReady: true, message: 'request:fail timeout' }],
  ['claim-idle', { ...token }],
  ['claim-unverified', { ...token, amtText: '--', remark: '', issuer: '', amtUnverified: true }],
  ['claim-resume', { ...token, status: 'fail', resume: true, message: '还没确认收款，点上方按钮继续确认' }],
  ['claim-fail', { ...token, status: 'fail', message: '网络错误：request:fail timeout' }],
  ['claim-multi', { ...mine, claimedCount: 1, claimedFen: 20000, claimedYuan: '200.00', minePendCount: 2 }],
  ['claim-confirming', { ...token, status: 'confirming', message: '已确认收款，正在等待到账' }],
  ['claim-arriving', { ...token, status: 'arriving', message: '微信正在入账，通常几秒到几分钟。稍后下拉页面或点上方按钮刷新结果' }],
  ['claim-nextfail', { ...mine, claimedCount: 1, claimedYuan: '200.00', minePendCount: 2, status: 'nextfail', message: '已到账 1 笔，下一笔暂时没查到，点上方按钮再试' }],
  ['claim-ok', { ...token, status: 'ok', subOn: true, receipt: { time: '2026-11-11 14:20', rid: RID, all: RID, count: 1 } }],
  ['claim-ok-sub-on', { ...token, status: 'ok', subOn: true, subState: 'on', subAlways: true, receipt: { time: '2026-11-11 14:20', rid: RID, all: RID, count: 1 } }],
  ['claim-ok-sub-off', { ...token, status: 'ok', subOn: true, subState: 'off', receipt: { time: '', rid: RID, all: RID, count: 1 } }],
  ['claim-ok-multi', {
    ...mine, mineAmt: '500.00', claimedCount: 3, claimedYuan: '500.00', minePendCount: 0, status: 'ok', isAdmin: true,
    message: '共 3 笔已全部到账微信零钱', receipt: { time: '2026-11-11 14:22', rid: RID, all: RID, count: 3 },
  }],
  ['claim-dead-fail', { ...token, status: 'dead', deadTitle: '没有到账', message: '原因：你今天收到的转账已达微信上限。钱没有转出，请联系给你发奖励的员工重新发放' }],
  ['claim-dead-revoked', { ...token, status: 'dead', deadTitle: '已被撤回', message: '这笔奖励已被发放方撤回，钱没有转出' }],
  ['claim-gone', { ...token, tokenGone: '这笔奖励已过期，请联系给你发奖励的员工重新发放' }],
  ['claim-empty', { mode: 'empty', entryReady: true, openid: 'oDemoCustomer', profile, subOn: true }],
  ['claim-empty-first', { mode: 'empty', entryReady: true, openid: 'oDemoCustomer' }],
  ['claim-admin-home', { mode: 'empty', entryReady: true, isAdmin: true, roleLabel: '超级管理员', adminHome }],
].map(([name, data]) => ({ name, page: 'claim', data }));

// ---------------- 工作台 ----------------
const A = {
  ready: true, isAdmin: true, isSuper: true, roleLabel: '超管', openid: 'oDemoAdmin', wecomOn: true, subMiniOn: true,
  splitCapYuan: 200, perUserCapYuan: 2000, custLoaded: true, lastSyncText: '今天 09:12', myWecomUserid: 'xiaowang',
};
const cust = [
  { key: 'e1', kind: 'eu', label: '张姐 · 探店', sub: '张晓雯', active: true },
  { key: 'e2', kind: 'eu', label: '陈老板', sub: '陈建国', active: true },
  { key: 'o1', kind: 'oid', label: '李同学', sub: 'oX9k2_3fJd8Qm1vL7nPzR4', active: true, removable: true },
  { key: 'e3', kind: 'eu', label: '赵女士', sub: '赵敏', active: false },
  { key: 'e4', kind: 'eu', label: '王总', sub: '王建华', active: true },
];
const sel = [
  { key: 'e1', label: '张姐 · 探店', amountYuan: '500', note: '渠道推荐奖励' },
  { key: 'e2', label: '陈老板', amountYuan: '88', note: '' },
  { key: 'o1', label: '李同学', amountYuan: '50', note: '笔记置顶' },
];
const period = { hasQuota: true, remainingYuan: '3,268.00', paidSinceYuan: '1,126.00', neg: false, low: false, updatedAt: '14:20' };
const review = {
  people: 3, bills: 5, totalYuan: '638.00', maxYuan: '500.00', maxLabel: '张姐 · 探店',
  splits: ['张姐 · 探店：¥500.00 拆成 3 笔'], splitCap: 200, quotaText: '¥3,268.00', quotaNote: '14:21 刚刷新',
  over: false, doubt: '', confirmText: '确认发放',
  list: sel.map((s) => ({ key: s.key, label: s.label, yuan: Number(s.amountYuan).toFixed(2), note: s.note })),
};
const result = {
  ...A, step: 'result', selected: sel,
  batchResult: { createdCount: 5, peopleCount: 3, batchId: 'b1', errors: [], targets: ['e1', 'e2'], targetOpenids: ['o1'] },
  notifyText: '你有一笔奖励待领取，打开【梨响ROC】小程序即可领取～',
};
const records = [
  { rid: 'a', yuan: '88.00', who: '张姐 · 探店', eu: 'e1', sub: '10月探店视频奖励 · 小王 发放', statusText: '待领取', cls: 'warn', createdAt: '11-02 14:20', batchId: 'b1', canRevoke: true },
  { rid: 'b', yuan: '200.00', who: '陈老板', eu: 'e2', sub: '老客户回馈 · 小王 发放', statusText: '待确认', cls: 'warn', createdAt: '11-02 11:05', batchId: 'b1', canRevoke: true },
  { rid: 'c', yuan: '66.00', who: '李同学', oid: 'o1', sub: '笔记置顶奖励 · 小林 发放', statusText: '已到账', cls: 'ok', createdAt: '11-01 19:42' },
  { rid: 'd', yuan: '120.00', who: '', sub: '客户奖励 · 小林 发放', statusText: '已过期', cls: 'muted', createdAt: '10-26 16:30' },
  { rid: 'e', yuan: '50.00', who: '赵女士', eu: 'e3', sub: '复购奖励 · 小王 发放', statusText: '失败', cls: 'fail', createdAt: '10-25 10:12' },
  { rid: 'f', yuan: '300.00', who: '王总', eu: 'e4', sub: '渠道推荐奖励 · 小王 发放', statusText: '到账中', cls: 'warn', createdAt: '10-24 09:58' },
];
const recBase = {
  ...A, tab: 'records', failAlert: 2, records, recLoaded: true, period,
  stats: { total: 124, success_count: 98, cancelled_count: 3, unclaimedText: '4 笔', claimedText: '2 笔' },
  statsTotalYuan: '18,420.00', statsPaidYuan: '16,890.00',
};
const noFilter = { status: 'all', days: 0, target: '', targetOpenid: '', targetLabel: '', batch: '', q: '', month: '' };
const detail = {
  rid: RID, yuan: '88.00', statusText: '待领取', cls: 'warn', nextStep: '等客户打开小程序领取；72 小时没领会过期，额度自动回到可发',
  who: '张姐 · 探店', eu: 'e1', remark: '10月探店视频奖励', issuer: '小王', createdFull: '2026-11-02 14:20:11',
  batchId: 'b1', canRevoke: true, billNo: '',
};

const admin = [
  ['admin-loading', { ready: false }],
  ['admin-load-failed', { ready: true, loadFailed: true, error: '' }],
  ['admin-not-admin', { ready: true, isAdmin: false, openid: 'oX9k2_3fJd8Qm1vL7nPzR4tYbW' }],
  ['send-pick', { ...A, step: 'pick', custList: cust, selectedMap: { e1: true, e2: true, o1: true }, selected: sel }],
  ['send-pick-empty', { ...A, step: 'pick', custList: [], custQ: '不存在的人' }],
  ['send-fill', { ...A, step: 'fill', selected: sel, fillTotalYuan: '638.00', period }],
  ['send-fill-error', { ...A, step: 'fill', selected: sel, fillTotalYuan: '638.00', period, errIdx: 1, error: '陈老板 的金额不能小于 ¥0.1' }],
  ['send-review', { ...A, step: 'review', selected: sel, review }],
  ['send-review-over', { ...A, step: 'review', selected: sel, review: { ...review, over: true, quotaText: '¥200.00', quotaNote: '14:21 刚刷新 · 合计超出可发额度' } }],
  ['result-fresh', { ...result }],
  ['result-notified', {
    ...result, miniDone: true, notifyDone: true, miniNotify: { sent: 1, failedCount: 0 },
    notifyResult: { lines: ['你：2 位客户'], failCount: 0, failList: [] },
    notifySum: { direct: 1, directText: '李同学', wecom: 2, wecomText: '张姐 · 探店、陈老板', failed: 0, failedText: '', forward: 0, forwardText: '' },
  }],
  ['result-need-forward', {
    ...result, miniDone: true, notifyDone: true, myWecomUserid: '',
    batchResult: { createdCount: 1, peopleCount: 1, batchId: 'b1', errors: [], targets: ['e1'], targetOpenids: [] },
    notifyResult: { lines: [], failCount: 0, failList: [] },
    notifySum: { direct: 0, wecom: 0, failed: 0, forward: 1, forwardText: '张姐 · 探店' },
  }],
  ['result-partial', {
    ...result,
    batchResult: { createdCount: 3, peopleCount: 2, batchId: 'b1', targets: ['e1'], targetOpenids: ['o1'], errors: [{ i: 1, label: '陈老板', state: '未创建', error: '额度不足' }] },
  }],
  ['result-all-failed', { ...result, batchResult: { createdCount: 0, peopleCount: 0, errors: [{ i: 0, label: '张姐 · 探店', state: '未创建', error: '额度不足' }] } }],
  ['quick', { ...A, sendMode: 'quick', amountYuan: '88', remark: '探店奖励' }],
  ['quick-done', { ...A, sendMode: 'quick', amountYuan: '88', remark: '探店奖励', reward: { token: 't', amountYuan: 88, amountText: '88.00', remark: '探店奖励' } }],
  ['records', { ...recBase, recFilter: noFilter }],
  ['records-filtered', { ...recBase, records: records.slice(0, 2), recFilter: { ...noFilter, status: 'created', target: 'e1', targetLabel: '张姐 · 探店', month: '2026-10' } }],
  ['records-filtered-empty', { ...recBase, records: [], stats: null, recFilter: { ...noFilter, status: 'failed', days: 7 } }],
  ['records-empty', { ...recBase, records: [], stats: null, failAlert: 0, recFilter: noFilter }],
  ['records-error', { ...recBase, records: [], stats: null, recError: true, recFilter: noFilter }],
  ['records-quota-panel', { ...recBase, recFilter: noFilter, quotaPanel: { mode: 'set', value: '3500' } }],
  ['record-detail', { ...recBase, recFilter: noFilter, detail }],
  ['rank', {
    ...A, tab: 'rank', rankLoaded: true, rankTotal: 86, rankLv: null,
    rankDist: [{ lv: 1, name: '新伙伴', count: 41 }, { lv: 2, name: '铜牌伙伴', count: 22 }, { lv: 3, name: '银牌伙伴', count: 13 }, { lv: 4, name: '金牌伙伴', count: 7 }, { lv: 5, name: '钻石伙伴', count: 3 }],
    rank: [
      { rank: 1, name: '王总', lv: 5, lvName: '钻石伙伴', count: 23, totalYuanText: '3,860.00', eu: 'e4' },
      { rank: 2, name: '陈老板', lv: 4, lvName: '金牌伙伴', count: 15, totalYuanText: '1,420.00', eu: 'e2' },
      { rank: 3, name: '张姐 · 探店', lv: 4, lvName: '金牌伙伴', count: 12, totalYuanText: '968.00', eu: 'e1' },
      { rank: 4, name: '李同学', lv: 3, lvName: '银牌伙伴', count: 7, totalYuanText: '486.00', oid: 'o1' },
    ],
  }],
  ['staff', {
    ...A, tab: 'staff',
    admins: [
      { openid: 'oX1abcdefghijklmnopqrstuvw', name: '小王', roleText: '发放员', enabled: true, isMe: false, wecomUserid: 'xiaowang' },
      { openid: 'oX2abcdefghijklmnopqrstuvw', name: '小林', roleText: '超管', isSuper: true, enabled: true, isMe: true },
      { openid: 'oX3abcdefghijklmnopqrstuvw', name: '老赵', roleText: '发放员', enabled: false, isMe: false },
    ],
  }],
].map(([name, data]) => ({ name, page: 'admin', data }));

module.exports = [...claim, ...admin];
