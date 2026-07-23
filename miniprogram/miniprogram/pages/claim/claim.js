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
    celebrate: false, // 到账仪式（画勾 + 呼吸 + 数字滚动）
    profile: null, // 合作档案 { lv, name, count, totalYuan, nextText }
    roleLabel: '', // 管理员角色名（操作端主页用）
    adminHome: null, // 操作端主页仪表 { hasQuota, remainingYuan, low, todayCount, todayYuan }
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
      this.refreshProfile(); // 顺带拉合作档案（等级卡）
      return;
    }
    // 直接打开：识别身份，看有没有属于我的定向奖励
    this.checkMine();
  },

  // 合作档案（等级）：/api/me 里带回，静默失败不打扰主流程
  _profileOf(me) {
    const p = me && me.profile;
    if (!p) return null;
    const lv = p.level || { lv: 0, name: '初识', next: null };
    let nextText = '';
    if (lv.next && lv.next.needYuan > 0) {
      nextText = `再领 ¥${Number(lv.next.needYuan).toFixed(2)} 升级${lv.next.name}`;
    }
    return {
      lv: lv.lv,
      name: lv.name,
      count: p.count || 0,
      totalYuan: Number(p.totalYuan || 0).toFixed(2),
      nextText,
    };
  },
  refreshProfile() {
    call('/api/me', 'GET')
      .then((me) => {
        if (me && me.openid) {
          this.setData({ openid: me.openid, isAdmin: !!me.isAdmin, profile: this._profileOf(me) });
        }
      })
      .catch(() => {});
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
      const base = {
        isAdmin: !!me.isAdmin,
        openid: me.openid || '',
        profile: this._profileOf(me),
        roleLabel: me.role === 'super' ? '超级管理员' : me.role === 'operator' ? '发放员' : '',
      };
      if (me.isAdmin) this.loadAdminHome(); // 管理员进门：拉仪表数据（额度剩余 + 近24h发放）
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

  // 操作端主页仪表：剩余额度 + 近24小时发放（静默失败不影响进工作台）
  loadAdminHome() {
    call('/api/period', 'GET')
      .then((p) => {
        if (!p || p.error) return;
        const rem = Number(p.remainingYuan) || 0;
        this.setData({
          adminHome: Object.assign({}, this.data.adminHome, {
            hasQuota: !!p.hasQuota,
            remainingYuan: rem.toFixed(2),
            low: p.hasQuota && rem <= 0,
          }),
        });
      })
      .catch(() => {});
    call('/api/rewards?limit=1&days=1', 'GET')
      .then((r) => {
        if (!r || !r.stats) return;
        this.setData({
          adminHome: Object.assign({ hasQuota: false }, this.data.adminHome, {
            todayCount: r.stats.total || 0,
            todayYuan: ((r.stats.paid_fen || 0) / 100).toFixed(2),
          }),
        });
      })
      .catch(() => {});
    // 累计发放（大字报用，千分位整数）
    call('/api/rewards?limit=1', 'GET')
      .then((r) => {
        if (!r || !r.stats) return;
        const total = Math.round((r.stats.total_fen || 0) / 100);
        this.setData({
          adminHome: Object.assign({ hasQuota: false }, this.data.adminHome, {
            totalAllYuan: String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
          }),
        });
      })
      .catch(() => {});
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

  // 到账仪式：画勾+色块呼吸（CSS）+ 金额数字滚动到位（JS 更新展示值）
  _celebrate(amtKey) {
    const target = Number(this.data[amtKey]) || 0;
    this.setData({ celebrate: true });
    if (!(target > 0)) return;
    if (this._countTimer) clearInterval(this._countTimer);
    const t0 = Date.now();
    const DUR = 700;
    this._countTimer = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / DUR);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out
      this.setData({ [amtKey]: (target * eased).toFixed(2) });
      if (p >= 1) clearInterval(this._countTimer);
    }, 33);
  },
  _tokenOk() {
    this._pendingTransfer = null;
    this.setData({ status: 'ok', message: '已到账微信零钱' });
    this._celebrate('amtText');
    setTimeout(() => this.refreshProfile(), 1200); // 到账后档案(合作次数/累计)自动 +1
  },

  // 链接领取（令牌）
  onClaimToken() {
    if (!this.data.token || this.data.status === 'loading') return;
    // 确认页被手滑关掉后再点：直接重开确认，别再 POST（转账已发起，重开即可）
    if (this._pendingTransfer) {
      this.setData({ status: 'loading', message: '' });
      return this._confirmTransfer(this._pendingTransfer, () => this._tokenOk());
    }
    this.setData({ status: 'loading', message: '' });
    call('/api/claim', 'POST', { token: this.data.token })
      .then((res) => {
        if (res && res.error) return this.setData({ status: 'fail', message: res.error });
        this._pendingTransfer = res;
        this._confirmTransfer(res, () => this._tokenOk());
      })
      .catch((e) =>
        this.setData({ status: 'fail', message: '网络错误：' + (e.errMsg || e.message || '') })
      );
  },

  // 定向领取（身份识别，无需链接）
  onClaimMine() {
    if (this.data.status === 'loading') return;
    // 确认页被手滑关掉后再点：直接重开确认（那笔已 CLAIMED，再 POST 会 404）
    if (this._pendingTransfer) {
      this.setData({ status: 'loading', message: '' });
      return this._confirmTransfer(this._pendingTransfer, () => this._afterMineOk());
    }
    this.setData({ status: 'loading', message: '' });
    call('/api/claim/mine', 'POST', {})
      .then((res) => {
        if (res && res.error) return this.setData({ status: 'fail', message: res.error });
        this._pendingTransfer = res;
        this._confirmTransfer(res, () => this._afterMineOk());
      })
      .catch((e) =>
        this.setData({ status: 'fail', message: '网络错误：' + (e.errMsg || e.message || '') })
      );
  },

  _afterMineOk() {
    this._pendingTransfer = null;
    const n = this.data.claimedCount + 1;
    this.setData({ status: 'ok', message: '已到账微信零钱', claimedCount: n });
    this._celebrate('mineAmt');
    // 可能还有下一笔：安静地查，绝不用 loading/empty 盖掉"已到账"画面；档案也顺带刷新
    setTimeout(() => {
      this.checkMineQuiet();
      this.refreshProfile();
    }, 1500);
  },

  // 安静查下一笔：只有真的还有奖励才切回领取态，否则保持"已到账"提示不动
  checkMineQuiet() {
    call('/api/claim/mine', 'GET')
      .then((mine) => {
        if (mine && mine.reward) {
          this.setData({
            mode: 'mine',
            mineAmt: Number(mine.reward.amountYuan).toFixed(2),
            mineRemark: mine.reward.remark || '',
            status: 'idle',
            message: '',
            celebrate: false, // 新的一笔回到领取态
          });
        }
      })
      .catch(() => {});
  },
});
