const { call } = require('../../api.js');

Page({
  data: {
    openid: '',
    isAdmin: false,
    amountYuan: '',
    remark: '',
    name: '',
    reward: null,
    loading: false,
    error: '',
    records: [], // 最近发放记录（需后端开库）
    stats: null, // 汇总
  },

  onLoad() {
    call('/api/me', 'GET')
      .then((me) => {
        this.setData({ openid: me.openid || '', isAdmin: !!me.isAdmin });
        if (me.isAdmin) this.loadRecords();
      })
      .catch((e) => this.setData({ error: '无法连接后端：' + (e.errMsg || e.message || '') }));
  },

  // 拉最近发放记录；未开库(503)时静默忽略
  loadRecords() {
    call('/api/rewards?limit=30', 'GET')
      .then((res) => {
        if (res && res.list) {
          const records = res.list.map((r) => ({
            rid: r.rid,
            yuan: (r.amount_fen / 100).toFixed(2),
            remark: r.remark || '',
            status: r.transfer_state || r.status || 'CREATED',
            createdAt: (r.created_at || '').replace('T', ' ').slice(5, 16),
          }));
          this.setData({ records, stats: res.stats || null });
        }
      })
      .catch(() => {}); // 未开库或无权限：不显示记录区
  },

  onAmount(e) { this.setData({ amountYuan: e.detail.value }); },
  onRemark(e) { this.setData({ remark: e.detail.value }); },
  onName(e) { this.setData({ name: e.detail.value }); },

  copyOpenid() {
    if (this.data.openid) wx.setClipboardData({ data: this.data.openid });
  },

  onGenerate() {
    const yuan = Number(this.data.amountYuan);
    if (!(yuan > 0)) {
      this.setData({ error: '请输入正确金额' });
      return;
    }
    this.setData({ loading: true, error: '', reward: null });
    call('/api/rewards', 'POST', {
      amountYuan: yuan,
      remark: this.data.remark,
      name: this.data.name,
    })
      .then((res) => {
        this.setData({ loading: false });
        if (res && res.error) {
          this.setData({ error: res.error });
          return;
        }
        this.setData({ reward: res });
        this.loadRecords(); // 刷新记录
      })
      .catch((e) =>
        this.setData({ loading: false, error: '网络错误：' + (e.errMsg || e.message || '') })
      );
  },

  onShareAppMessage() {
    const r = this.data.reward || {};
    const amt = r.amountYuan || '';
    const remark = r.remark || '';
    const token = r.token || '';
    return {
      title: `请领取 ¥${amt} 奖励`,
      path: `/pages/claim/claim?token=${encodeURIComponent(token)}&amt=${amt}&remark=${encodeURIComponent(remark)}`,
    };
  },
});
