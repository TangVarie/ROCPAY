const { call } = require('../../api.js');

Page({
  data: {
    // 模式：loading(识别中) | token(链接领取) | mine(定向领取) | empty(无奖励) | error(连不上后端)
    mode: 'loading',
    // 链接领取（token）
    token: '',
    amtText: '--',
    remark: '',
    tokenGone: '', // 非空 = 令牌已终结（过期/已领/已撤回），显示终态而不是可点的领取块
    // 定向领取（身份识别）
    mineAmt: '',
    mineRemark: '',
    minePendCount: 0, // 名下待领笔数（大额拆单后 > 1）
    minePendYuan: '', // 名下待领合计（两位小数字符串）
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
      // 链接进入：令牌流程。金额/备注以后端校验接口返回为准——URL 的 amt 任何人都能改，
      // 只当作校验接口不可达时的兜底展示，防"改链接把 ¥1 显示成 ¥10000"的伪造
      this._urlAmt = options.amt || '';
      this.setData({
        mode: 'token',
        token,
        amtText: '--',
        remark: options.remark ? decodeURIComponent(options.remark) : '',
      });
      this.checkToken();
      this.refreshProfile(); // 顺带拉合作档案（等级卡）
      return;
    }
    // 直接打开：识别身份，看有没有属于我的定向奖励
    this.checkMine();
  },

  // 领取前置校验（只读）：进入即验 token，已过期/已领/已撤回直接给终态界面，
  // 不再"先渲染领取块、点了才报错"；有效时金额以后端为准（两位小数，BYWOOD 规范）
  checkToken() {
    call(`/api/claim/status?token=${encodeURIComponent(this.data.token)}`, 'GET')
      .then((res) => {
        if (!res || !res.state) return this._tokenFallback();
        if (res.state === 'VALID') {
          this.setData({
            amtText: Number(res.amountYuan) > 0 ? Number(res.amountYuan).toFixed(2) : '--',
            remark: res.remark || this.data.remark,
          });
          return;
        }
        const map = {
          EXPIRED: '这条领取链接已过期，请联系发放员重新发送',
          CANCELLED: '这笔奖励已被发放方撤回',
          SUCCESS: '这笔奖励已被领取过了',
          TARGETED: '这是定向奖励，请从员工发来的小程序卡片打开领取',
          INVALID: '领取链接无效，请联系发放员重新发送',
        };
        this.setData({ tokenGone: map[res.state] || '该奖励当前不可领取' });
      })
      .catch(() => this._tokenFallback());
  },
  // 校验接口不可达（冷启动/网络抖动）：退回 URL 金额兜底展示；点领取仍有后端强校验把关
  _tokenFallback() {
    const n = Number(this._urlAmt);
    this.setData({ amtText: n > 0 ? n.toFixed(2) : '--' });
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
      call('/api/claim/mine', 'GET').catch((e) => ({ _err: e })),
    ]).then(([me, mine]) => {
      // /api/me 都拿不到 openid = 后端连不上/没部署好，明确报错而不是装作"没奖励"
      if (!me || me._err || !me.openid) {
        const detail = me && me._err ? (me._err.errMsg || me._err.message || '') : '后端无响应';
        this.setData({ mode: 'error', message: detail });
        return;
      }
      // 奖励查询失败 ≠ 没有奖励：定向发了钱、客户却看到"暂时没有你的奖励"是最伤的误导，
      // 这里必须走错误态 + 重试，而不是空态
      if (!mine || mine._err || mine.error) {
        const detail =
          (mine && mine._err && (mine._err.errMsg || mine._err.message)) ||
          (mine && mine.error) ||
          '奖励查询失败';
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
          minePendCount: (mine.pending && mine.pending.count) || 1,
          minePendYuan: mine.pending ? Number(mine.pending.totalYuan).toFixed(2) : '',
          status: 'idle',
          message: '',
        });
      } else {
        // 把"为什么没有奖励"讲清楚：身份没认出来（unionid 桥断了）和"确实没有待领"是两回事，
        // 不区分的话，定向发了钱、客户却以为没发（后端返回的 reason 以前被直接丢弃）
        const reasonText =
          mine && mine.reason === 'not_a_customer'
            ? '未匹配到你的客户档案：请先添加员工的企业微信为好友，或联系发放员工核对'
            : mine && mine.reason === 'no_unionid'
              ? '暂未能识别你的身份，请从员工发来的小程序卡片重新打开一次'
              : '';
        this.setData({ ...base, mode: 'empty', emptyReason: reasonText });
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
            minePendCount: (mine.pending && mine.pending.count) || 1,
            minePendYuan: mine.pending ? Number(mine.pending.totalYuan).toFixed(2) : '',
            status: 'idle',
            message: '',
            celebrate: false, // 新的一笔回到领取态
          });
        } else {
          this.setData({ minePendCount: 0, minePendYuan: '' }); // 全部领完
        }
      })
      .catch(() => {});
  },
});
