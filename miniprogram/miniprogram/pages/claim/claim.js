const { call } = require('../../api.js');

Page({
  data: {
    token: '',
    amt: '',
    remark: '',
    hasToken: false,
    isAdmin: false,
    openid: '',
    status: 'idle', // idle | loading | ok | fail
    message: '',
  },

  onLoad(options) {
    const token = options.token ? decodeURIComponent(options.token) : '';
    const amt = options.amt || '';
    const remark = options.remark ? decodeURIComponent(options.remark) : '';
    this.setData({ token, amt, remark, hasToken: !!token });
    // 无 token：看是不是管理员 + 拿到自己的 openid（供"想成为发放员"复制）
    if (!token) {
      call('/api/me', 'GET')
        .then((me) => this.setData({ isAdmin: !!(me && me.isAdmin), openid: (me && me.openid) || '' }))
        .catch(() => {});
    }
  },

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

  onClaim() {
    if (!this.data.token || this.data.status === 'loading') return;
    this.setData({ status: 'loading', message: '' });
    call('/api/claim', 'POST', { token: this.data.token })
      .then((res) => {
        if (res && res.error) {
          this.setData({ status: 'fail', message: res.error });
          return;
        }
        wx.requestMerchantTransfer({
          mchId: res.mchId,
          appId: res.appId,
          package: res.package_info,
          success: () => this.setData({ status: 'ok', message: '领取成功，已到账到微信零钱' }),
          fail: (e) =>
            this.setData({ status: 'fail', message: '未完成确认收款：' + (e.errMsg || '') }),
        });
      })
      .catch((e) =>
        this.setData({ status: 'fail', message: '网络错误：' + (e.errMsg || e.message || '') })
      );
  },
});
