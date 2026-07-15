const { call } = require('../../api.js');

Page({
  data: {
    openid: '',
    isAdmin: false,
    isSuper: false,
    roleLabel: '',
    tab: 'send', // send | records | staff

    // 发放
    amountYuan: '',
    remark: '',
    name: '',
    reward: null,
    loading: false,
    error: '',
    minAmountYuan: 0.1,
    maxAmountYuan: 5000,

    // 记录
    records: [],
    stats: null,

    // 员工
    admins: [],
    newOpenid: '',
    newName: '',
    newRole: 'operator',
    staffMsg: '',
    staffLoading: false,
  },

  onLoad() {
    call('/api/me', 'GET')
      .then((me) => {
        const isSuper = !!me.isSuper;
        this.setData({
          openid: me.openid || '',
          isAdmin: !!me.isAdmin,
          isSuper,
          roleLabel: me.role === 'super' ? '超级管理员' : me.role === 'operator' ? '发放员' : '',
          minAmountYuan: me.minAmountYuan || 0.1,
          maxAmountYuan: me.maxAmountYuan || 5000,
        });
        if (me.isAdmin) this.loadRecords();
        if (isSuper) this.loadAdmins();
      })
      .catch((e) => this.setData({ error: '无法连接后端：' + (e.errMsg || e.message || '') }));
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
    if (tab === 'records') this.loadRecords();
    if (tab === 'staff') this.loadAdmins();
  },

  // ---------- 发放 ----------
  onAmount(e) { this.setData({ amountYuan: e.detail.value }); },
  onRemark(e) { this.setData({ remark: e.detail.value }); },
  onName(e) { this.setData({ name: e.detail.value }); },

  onGenerate() {
    const yuan = Number(this.data.amountYuan);
    if (!(yuan > 0)) return this.setData({ error: '请输入正确金额' });
    if (yuan < this.data.minAmountYuan)
      return this.setData({ error: `金额不能小于 ${this.data.minAmountYuan} 元（微信有最低单笔限额）` });
    if (yuan > this.data.maxAmountYuan)
      return this.setData({ error: `金额不能大于 ${this.data.maxAmountYuan} 元` });

    this.setData({ loading: true, error: '', reward: null });
    call('/api/rewards', 'POST', { amountYuan: yuan, remark: this.data.remark, name: this.data.name })
      .then((res) => {
        this.setData({ loading: false });
        if (res && res.error) return this.setData({ error: res.error });
        this.setData({ reward: res });
        this.loadRecords();
      })
      .catch((e) => this.setData({ loading: false, error: '网络错误：' + (e.errMsg || e.message || '') }));
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

  // ---------- 记录 ----------
  loadRecords() {
    call('/api/rewards?limit=40', 'GET')
      .then((res) => {
        if (res && res.list) {
          const map = { SUCCESS: '已到账', WAIT_USER_CONFIRM: '待确认', FAIL: '失败', CLOSED: '已关闭', CREATED: '待领取', CLAIMED: '待确认' };
          const records = res.list.map((r) => {
            const st = r.transfer_state || r.status || 'CREATED';
            return {
              rid: r.rid,
              yuan: (r.amount_fen / 100).toFixed(2),
              remark: r.remark || '',
              status: st,
              statusText: map[st] || st,
              cls: st === 'SUCCESS' ? 'ok' : st === 'FAIL' || st === 'CLOSED' ? 'fail' : 'warn',
              createdAt: (r.created_at || '').replace('T', ' ').slice(5, 16),
            };
          });
          this.setData({ records, stats: res.stats || null });
        }
      })
      .catch(() => {});
  },

  // ---------- 员工 ----------
  loadAdmins() {
    call('/api/admins', 'GET')
      .then((res) => {
        if (res && res.list) {
          const admins = res.list.map((a) => ({
            openid: a.openid,
            name: a.name || '（未命名）',
            roleText: a.role === 'super' ? '超管' : '发放员',
            isSuper: a.role === 'super',
            isMe: a.openid === this.data.openid,
          }));
          this.setData({ admins });
        }
      })
      .catch(() => {});
  },
  onNewOpenid(e) { this.setData({ newOpenid: e.detail.value }); },
  onNewName(e) { this.setData({ newName: e.detail.value }); },
  pickRole(e) { this.setData({ newRole: e.currentTarget.dataset.role }); },

  addStaff() {
    const openid = (this.data.newOpenid || '').trim();
    if (!openid) return this.setData({ staffMsg: '请粘贴员工的 openid' });
    this.setData({ staffLoading: true, staffMsg: '' });
    call('/api/admins', 'POST', { openid, name: this.data.newName, role: this.data.newRole })
      .then((res) => {
        this.setData({ staffLoading: false });
        if (res && res.error) return this.setData({ staffMsg: res.error });
        this.setData({ newOpenid: '', newName: '', newRole: 'operator', staffMsg: '' });
        wx.showToast({ title: '已添加', icon: 'success' });
        this.loadAdmins();
      })
      .catch((e) => this.setData({ staffLoading: false, staffMsg: '网络错误：' + (e.errMsg || e.message || '') }));
  },

  removeStaff(e) {
    const openid = e.currentTarget.dataset.openid;
    wx.showModal({
      title: '移除员工',
      content: '确定移除该员工的发放权限？',
      confirmColor: '#fa5151',
      success: (r) => {
        if (!r.confirm) return;
        call('/api/admins/remove', 'POST', { openid })
          .then((res) => {
            if (res && res.error) return wx.showToast({ title: res.error, icon: 'none' });
            wx.showToast({ title: '已移除', icon: 'success' });
            this.loadAdmins();
          })
          .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }));
      },
    });
  },

  copyText(e) {
    const v = e.currentTarget.dataset.v;
    if (v) wx.setClipboardData({ data: v, success: () => wx.showToast({ title: '已复制', icon: 'success' }) });
  },
});
