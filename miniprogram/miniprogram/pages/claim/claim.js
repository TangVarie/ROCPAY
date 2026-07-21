const { call } = require('../../api.js');

Page({
  data: {
    // 模式：loading(识别中) | token(链接领取) | mine(定向领取) | empty(无奖励)
    mode: 'loading',
    // 链接领取（token）
    token: '',
    amt: '',
    amtText: '--',
    remark: '',
    // 定向领取（身份识别）
    mineAmt: '',
    mineRemark: '',
    // 通用
    isAdmin: false,
    openid: '',
    status: 'idle', // idle | loading | ok | fail
    message: '',
    claimedCount: 0, // 本次会话已领取笔数（定向可能有多笔）
  },

  onLoad(options) {
    const token = options.token ? decodeURIComponent(options.token) : '';
    if (token) {
      // 链接进入：令牌流程。金额一律两位小数（BYWOOD 规范）
      const n = Number(options.amt);
      this.setData({
        mode: 'token',
        token,
        amt: options.amt || '',
        amtText: n > 0 ? n.toFixed(2) : '--',
        remark: options.remark ? decodeURIComponent(options.remark) : '',
      });
      return;
    }
    // 直接打开：识别身份，看有没有属于我的定向奖励
    this.checkMine();
  },

  checkMine() {
    this.setData({ mode: 'loading', status: 'idle', message: '' });
    Promise.all([
      call('/api/me', 'GET').catch((e) => ({ _err: e })),
      call('/api/claim/mine', 'GET').catch(() => ({})),
    ]).then(([me, mine]) => {
      // /api/me 都拿不到 openid = 后端连不上/没部署好，明确报错而不是装作"没奖励"
      if (!me || me._err || !me.openid) {
        const detail = me && me._err ? (me._err.errMsg || me._err.message || '') : '后端无响应';
        this.setData({ mode: 'error', message: detail });
        return;
      }
      const base = { isAdmin: !!me.isAdmin, openid: me.openid || '' };
      if (mine && mine.reward) {
        this.setData({
          ...base,
          mode: 'mine',
          mineAmt: Number(mine.reward.amountYuan).toFixed(2),
          mineRemark: mine.reward.remark || '',
          status: 'idle',
          message: '',
        });
      } else {
        this.setData({ ...base, mode: 'empty' });
      }
    });
  },

  retry() { this.checkMine(); },

  goAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  copyOpenid() {
    if (!this.data.openid) return;
    wx.setClipboardData({
      data: this.data.openid,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
  },

  // 拉起微信官方确认收款
  _confirmTransfer(res, onOk) {
    wx.requestMerchantTransfer({
      mchId: res.mchId,
      appId: res.appId,
      package: res.package_info,
      success: onOk,
      fail: (e) =>
        this.setData({ status: 'fail', message: '未完成确认收款：' + (e.errMsg || '') }),
    });
  },

  // 链接领取（令牌）
  onClaimToken() {
    if (!this.data.token || this.data.status === 'loading') return;
    this.setData({ status: 'loading', message: '' });
    call('/api/claim', 'POST', { token: this.data.token })
      .then((res) => {
        if (res && res.error) return this.setData({ status: 'fail', message: res.error });
        this._confirmTransfer(res, () =>
          this.setData({ status: 'ok', message: '已到账微信零钱' })
        );
      })
      .catch((e) =>
        this.setData({ status: 'fail', message: '网络错误：' + (e.errMsg || e.message || '') })
      );
  },

  // 定向领取（身份识别，无需链接）
  onClaimMine() {
    if (this.data.status === 'loading') return;
    this.setData({ status: 'loading', message: '' });
    call('/api/claim/mine', 'POST', {})
      .then((res) => {
        if (res && res.error) return this.setData({ status: 'fail', message: res.error });
        this._confirmTransfer(res, () => {
          const n = this.data.claimedCount + 1;
          this.setData({ status: 'ok', message: '已到账微信零钱', claimedCount: n });
          // 可能还有下一笔，稍后自动再查
          setTimeout(() => this.checkMine(), 1200);
        });
      })
      .catch((e) =>
        this.setData({ status: 'fail', message: '网络错误：' + (e.errMsg || e.message || '') })
      );
  },
});
