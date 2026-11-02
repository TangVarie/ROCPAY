const { call } = require('../../api.js');
const { yuan, num } = require('../../money.js');

Page({
  data: {
    // 模式：loading(识别中) | token(链接领取) | mine(定向领取) | empty(无奖励) | error(连不上后端)
    mode: 'loading',
    // 链接领取（token）
    token: '',
    amtText: '--',
    amtUnverified: false, // 校验接口不可达：金额还没经后端核验，不上屏、不给领取，只给"重新连接"
    verifying: false, // 重新连接中：金额仍未核验，按钮转圈不可点
    remark: '',
    tokenGone: '', // 非空 = 令牌已终结（过期/已领/已撤回），显示终态而不是可点的领取块
    // 入口数据已到齐（开屏据此淡出）：令牌流程要等 /api/claim/status 回来（成功、终态或兜底都算），
    // 直接打开要等 checkMine 落定（mine/empty/error 都算）。不能用 mode 判——mode 在发请求前就已是 token
    entryReady: false,
    issuer: '', // 谁发的：发放员工备注名（可信收款单第一行；''=只显示品牌）
    resume: false, // 上次点了领取、没在微信里确认完：这笔是"待确认收款"而不是"待领取"
    deadTitle: '', // 终态失败的标题：没有到账 / 已被撤回
    // 定向领取（身份识别）
    mineAmt: '',
    mineRemark: '',
    minePendCount: 0, // 名下待领笔数（大额拆单后 > 1）
    minePendYuan: '', // 名下待领合计（两位小数字符串）
    // 通用
    isAdmin: false,
    openid: '',
    // idle | loading | fail(可重试) | confirming(已确认、查单中) | arriving(查单超时、仍在入账)
    // | between(多笔：本笔已到账、正在查下一笔) | nextfail(下一笔没查到，可重试)
    // | ok(查单 SUCCESS 才到这；多笔时是全部领完) | dead(转账失败/被撤回：终态，不再给领取按钮)
    status: 'idle',
    message: '',
    claimedCount: 0, // 本次会话已到账笔数（大额拆单一人多笔：第 N/M 笔）
    claimedFen: 0, //   本次会话已到账合计（分）
    claimedYuan: '', // 同上，展示串
    profile: null, // 合作档案 { lv, name, count, totalYuan, nextText }
    roleLabel: '', // 管理员角色名（操作端主页用）
    adminHome: null, // 操作端主页仪表 { hasQuota, remainingYuan, low, todayCount, todayYuan }
  },

  onLoad(options) {
    const token = options.token ? decodeURIComponent(options.token) : '';
    if (token) {
      // 链接进入：令牌流程。金额/备注只认后端校验接口返回的——URL 上的 amt/remark 任何人都能改，
      // 连兜底展示都不用（旧链接还带着这两个参数，一律忽略），防"改链接把 ¥1 显示成 ¥10000"
      this.setData({ mode: 'token', token, amtText: '--', amtUnverified: false, remark: '' });
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
            amtText: Number(res.amountYuan) > 0 ? yuan(res.amountYuan) : '--',
            amtUnverified: false,
            verifying: false,
            remark: res.remark || '',
            issuer: res.issuer || '',
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
        this.setData({ tokenGone: map[res.state] || '该奖励当前不可领取', verifying: false });
      })
      .catch(() => this._tokenFallback())
      .then(() => this.setData({ entryReady: true })); // 成功 / 终态 / 兜底三条路都算"到了"
  },
  // 校验接口不可达（冷启动/网络抖动）：金额没核验就不上屏，也不给领取按钮——
  // 只给"重新连接"。旧版这里拿 URL 的 amt 兜底，改过的链接能把任意金额显示出来
  _tokenFallback() {
    this.setData({ amtText: '--', amtUnverified: true, verifying: false });
  },
  // 重新连接：核验结果回来之前 amtUnverified 一直保持 true（领取按钮不出现），
  // 只有拿到 VALID 才放开——否则请求途中就能点领取、看不到核验过的金额
  retryToken() {
    if (this.data.verifying) return;
    this.setData({ verifying: true });
    this.checkToken();
  },

  // 合作档案（等级）：/api/me 里带回，静默失败不打扰主流程
  _profileOf(me) {
    const p = me && me.profile;
    if (!p) return null;
    const lv = p.level || { lv: 0, name: '初识', next: null };
    let nextText = '';
    if (lv.next && lv.next.needYuan > 0) {
      nextText = `再领 ¥${yuan(lv.next.needYuan)} 升级${lv.next.name}`;
    }
    return {
      lv: lv.lv,
      name: lv.name,
      count: p.count || 0,
      totalYuan: yuan(p.totalYuan),
      nextText,
    };
  },
  refreshProfile() {
    // 把请求存成 promise：链接冷启动时领取按钮先于 /api/me 返回可点，
    // _askSubscribe 会等这个 promise（最多 2 秒）再决定要不要弹订阅授权
    this._meLoading = call('/api/me', 'GET')
      .then((me) => {
        if (me && me.openid) {
          this._subTmplId = me.subscribeTmplId || ''; // 订阅消息模板（''=后端未配置，静默关闭）
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
      this._subTmplId = me.subscribeTmplId || ''; // 订阅消息模板（''=后端未配置，静默关闭）
      const base = {
        isAdmin: !!me.isAdmin,
        openid: me.openid || '',
        profile: this._profileOf(me),
        roleLabel: me.role === 'super' ? '超级管理员' : me.role === 'operator' ? '发放员' : '',
        subOn: !!this._subTmplId, // 空态"有新奖励时提醒我"按钮的开关
      };
      if (me.isAdmin) this.loadAdminHome(); // 管理员进门：拉仪表数据（额度剩余 + 近24h发放）
      if (mine && mine.reward) {
        // 在途单续办：上次转账已发起但确认页没走完，后端带回 package_info——
        // 预置成 _pendingTransfer，点领取直接重开微信确认页（不再 POST，POST 也会 404）
        this._pendingTransfer = mine.resume
          ? { mchId: mine.resume.mchId, appId: mine.resume.appId, package_info: mine.resume.package_info, out_bill_no: mine.reward.rid }
          : null;
        this.setData({
          ...base,
          mode: 'mine',
          mineAmt: yuan(mine.reward.amountYuan),
          mineRemark: mine.reward.remark || '',
          issuer: mine.reward.issuer || '',
          resume: !!mine.resume,
          minePendCount: (mine.pending && mine.pending.count) || 1,
          minePendYuan: mine.pending ? yuan(mine.pending.totalYuan) : '',
          status: 'idle',
          message: mine.resume ? '上次确认收款未完成，点击领取继续即可到账' : '',
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
    }).then(
      () => this.setData({ entryReady: true }),
      () => this.setData({ entryReady: true }) // 处理函数自身抛错也要放开屏走，页面停在 loading 态由用户重试
    );
  },

  retry() { this.checkMine(); },

  // 从工作台返回时刷新仪表：额度/异常角标可能已变（如刚点了"标记已处理"），
  // 本页在页面栈里被缓存，不刷新会一直显示旧警示。首次进入时 mode 还是 loading，天然跳过
  onShow() {
    if (this.data.isAdmin && this.data.mode === 'empty') this.loadAdminHome();
  },

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
            remainingYuan: yuan(Math.abs(rem)), // 符号单放（-¥12.00，不显示成 ¥-12.00）
            neg: rem < 0,
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
            todayYuan: yuan((r.stats.paid_fen || 0) / 100),
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
    // 异常警示：与工作台角标同口径（/api/alerts，「知悉水位」之后新出现的失败/关闭单）。
    // 对钱的异常，被动发现 = 事故，进门就要看见；处理完在工作台标记已处理即清零
    call('/api/alerts', 'GET')
      .then((r) => {
        if (!r || r.error || typeof r.count !== 'number') return;
        this.setData({
          adminHome: Object.assign({ hasQuota: false }, this.data.adminHome, { failCount: r.count }),
        });
      })
      .catch(() => {});
  },

  // 异常警示块 → 直达工作台记录 Tab 的失败筛选
  goFailed() {
    wx.navigateTo({ url: '/pages/admin/admin?tab=records&status=failed' });
  },

  // 拉起微信官方确认收款。success 只代表客户点了确认，不代表付款成功（微信官方说明）——
  // 先进"等待到账"，查单 SUCCESS 才回调 onOk（到账、庆祝）
  _confirmTransfer(res, onOk) {
    // 旧版微信没有 requestMerchantTransfer：不检测会直接 JS 报错，点领取毫无反应且无任何提示
    if (typeof wx.requestMerchantTransfer !== 'function') {
      this.setData({
        status: 'fail',
        message: '当前微信版本过低，无法拉起确认收款，请升级微信到最新版本后再来领取',
      });
      return;
    }
    wx.requestMerchantTransfer({
      mchId: res.mchId,
      appId: res.appId,
      package: res.package_info,
      success: () => {
        this._pendingTransfer = null; // 已确认过：这张凭证不能再开第二次
        this._waitArrival(res.out_bill_no, onOk);
      },
      fail: (e) => {
        const msg = e.errMsg || '';
        // 手滑取消（errMsg 带 cancel）：保留在途凭证，再点直接重开确认页（原设计）
        if (/cancel/i.test(msg)) {
          // 转账已发起、只是确认页被关掉：这笔从"待领取"变成"待确认收款"
          this.setData({ status: 'fail', resume: true, message: '还没确认收款，点下方按钮继续确认' });
          return;
        }
        // 定向领取的真失败（典型是「订单已失效」：凭证对应的转账已完成/关闭，只是确认
        // 回调还没同步到后端）：清凭证 + 重新对账——后端会以微信实况出下一笔或终态；
        // 不清的话每次点击都在重开同一张死凭证，客户被永久卡住
        if (this.data.mode === 'mine') {
          this._pendingTransfer = null;
          this.setData({ status: 'fail', resume: false, message: '确认收款未完成（' + msg + '），已刷新状态，请稍候再点一次领取' });
          setTimeout(() => this.checkMineQuiet(), 800);
          return;
        }
        // 链接领取：这张凭证是该笔在途转账唯一的重开入口——令牌可能已临期/过期，
        // 清掉后重新 POST 会被令牌校验拒绝，反而把还能确认的钱锁在外面（评审发现）。
        // 保留凭证让"再点一次"能重开；若真已失效，重新打开链接会看到明确的终态提示
        this.setData({ status: 'fail', resume: true, message: '未完成确认收款：' + msg + '，请再点一次' });
      },
    });
  },

  // 等到账：按退避间隔查单（共约 22 秒）。SUCCESS → onArrived；失败/关闭/撤回 → dead 终态 + 下一步；
  // 一直在途 → arriving，给"刷新到账结果"，绝不提前说到账。seq 防离开页面后旧轮询还在改界面
  _waitArrival(rid, onArrived) {
    const seq = (this._arrSeq = (this._arrSeq || 0) + 1);
    this._arrRid = rid;
    this._arrOnArrived = onArrived;
    if (!rid) return this._stillArriving(); // 拿不到单号查不了：如实说在入账，不装作到账
    this.setData({ status: 'confirming', message: '已确认收款，正在等待到账' });
    const delays = [800, 1500, 2000, 3000, 4000, 5000, 6000];
    let i = 0;
    const next = () => {
      if (seq !== this._arrSeq) return;
      if (i >= delays.length) return this._stillArriving();
      setTimeout(tick, delays[i++]);
    };
    const tick = () => {
      if (seq !== this._arrSeq) return;
      call(`/api/claim/result?rid=${encodeURIComponent(rid)}`, 'GET')
        .then((r) => {
          if (seq !== this._arrSeq) return;
          const st = r && r.state;
          if (st === 'SUCCESS') return onArrived();
          if (st === 'FAIL' || st === 'CLOSED') {
            return this.setData({
              status: 'dead',
              deadTitle: '没有到账',
              message: `原因：${r.failText || '微信没有说明具体原因'}。钱没有转出，请联系给你发奖励的员工重新发放`, // 标题已是「没有到账」
            });
          }
          if (st === 'CANCELLED' || st === 'CANCELING') {
            return this.setData({ status: 'dead', deadTitle: '已被撤回', message: '这笔奖励已被发放方撤回，钱没有转出' });
          }
          next(); // 处理中/待确认/查不到（极短窗口）/接口报错：继续等
        })
        .catch(() => next());
    };
    next();
  },
  _stillArriving() {
    this.setData({ status: 'arriving', message: '微信正在入账，通常几秒到几分钟。稍后点下方按钮刷新结果' });
  },
  refreshArrival() {
    if (this.data.status !== 'arriving') return;
    this._waitArrival(this._arrRid, this._arrOnArrived);
  },
  onUnload() {
    this._arrSeq = (this._arrSeq || 0) + 1; // 离开页面：停掉查单轮询
  },

  // 到账仪式：画勾淡入（CSS）+ 金额数字滚动到位（JS 更新展示值）。展示值带千分位，取数要 num() 还原
  _celebrate(amtKey) {
    const target = num(this.data[amtKey]);
    if (!(target > 0)) return;
    if (this._countTimer) clearInterval(this._countTimer);
    const t0 = Date.now();
    const DUR = 700;
    this._countTimer = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / DUR);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out
      this.setData({ [amtKey]: yuan(target * eased) });
      if (p >= 1) clearInterval(this._countTimer);
    }, 33);
  },
  _tokenOk() {
    this._pendingTransfer = null;
    this.setData({ status: 'ok', message: '' }); // 标题已是"已到账微信零钱"，提示行不再重复
    this._celebrate('amtText');
    setTimeout(() => this.refreshProfile(), 1200); // 到账后档案(合作次数/累计)自动 +1
  },

  // 领取动作顺带请求「奖励提醒」订阅授权：一次授权 = 之后新奖励可直达微信服务通知一条。
  // 必须在点击手势里同步调起（微信平台约束）；拒绝/失败都不影响领取；每次会话只弹一次
  // （客户勾了"总是保持以上选择"后微信不再弹窗、静默累计授权）。串行执行：授权弹窗
  // 处理完（complete）再走领取，避免与"确认收款"半屏叠在一起。
  // 链接冷启动时模板 ID 可能还在 /api/me 途中：最多等 2 秒再决定，拿不到就放行领取——
  // 订阅采集不许卡死领钱，但也不白白错过首笔（往往是唯一一笔）的授权机会
  _askSubscribe(next) {
    if (this._subAsked || typeof wx.requestSubscribeMessage !== 'function') return next();
    const go = () => {
      const id = this._subTmplId;
      if (!id || this._subAsked) return next();
      this._subAsked = true;
      wx.requestSubscribeMessage({
        tmplIds: [id],
        success: (r) => {
          if (r && r[id] === 'accept') this._saveGrant();
        },
        complete: () => next(),
      });
    };
    if (this._subTmplId === undefined && this._meLoading) {
      let done = false;
      const once = () => {
        if (done) return;
        done = true;
        go();
      };
      this._meLoading.then(once, once);
      setTimeout(once, 2000);
    } else {
      go();
    }
  },
  // 授权落库：微信侧已实际消耗一次授权，落库失败=白丢。失败自动重试一次；
  // 仍失败则放开 _subAsked，本会话下次领取再问（勾过"总是保持"的用户重问不弹窗，
  // 等于纯重试落库）。万一造成本地多记：发送时微信回 43101 会把本地配额对齐清零，能自愈
  _saveGrant(retried) {
    call('/api/subscribe/grant', 'POST', {})
      .then((res) => {
        if (res && res.error) throw new Error(res.error);
      })
      .catch(() => {
        if (!retried) return setTimeout(() => this._saveGrant(true), 1000);
        this._subAsked = false;
      });
  },
  // 空态"有新奖励时提醒我"：显式订阅入口（首次没有奖励也能先把提醒开起来）。
  // 只有后端确认落库成功才提示"已开启"，失败让用户再点一次（授权不静默丢）
  askSubscribe() {
    const id = this._subTmplId;
    if (!id) return;
    if (typeof wx.requestSubscribeMessage !== 'function') {
      return wx.showToast({ title: '当前微信版本过低', icon: 'none' });
    }
    wx.requestSubscribeMessage({
      tmplIds: [id],
      success: (r) => {
        if (!r || r[id] !== 'accept') return;
        call('/api/subscribe/grant', 'POST', {})
          .then((res) => {
            if (res && res.error) return wx.showToast({ title: res.error, icon: 'none' });
            wx.showToast({ title: '已开启提醒', icon: 'success' });
          })
          .catch(() => wx.showToast({ title: '网络错误，请再点一次', icon: 'none' }));
      },
    });
  },

  // 链接领取（令牌）
  onClaimToken() {
    if (!this.data.token || this.data.status === 'loading') return;
    // 确认页被手滑关掉后再点：直接重开确认，别再 POST（转账已发起，重开即可）
    if (this._pendingTransfer) {
      this.setData({ status: 'loading', message: '' });
      return this._confirmTransfer(this._pendingTransfer, () => this._tokenOk());
    }
    if (this.data.amtUnverified) return; // 金额没核验不许领（按钮本就不渲染，这里兜底）
    this.setData({ status: 'loading', message: '' });
    this._askSubscribe(() => this._doClaimToken());
  },
  _doClaimToken() {
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
    this._askSubscribe(() => this._doClaimMine());
  },
  _doClaimMine() {
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

  // 大额拆单一人多笔：中间几笔到账只记账、接着出下一笔，不庆祝；最后一笔（或唯一一笔）
  // 到账才翻青面——每笔都放一次到账仪式，客户会以为领完了
  _afterMineOk() {
    this._pendingTransfer = null;
    const n = this.data.claimedCount + 1;
    const fen = this.data.claimedFen + Math.round(num(this.data.mineAmt) * 100);
    // 这笔已到账：剩余笔数同步减一（「第 N/M 笔」的 M = 已到账 + 剩余，不减会多算一笔）
    const left = Math.max(0, this.data.minePendCount - 1);
    this.setData({ claimedCount: n, claimedFen: fen, claimedYuan: yuan(fen / 100), resume: false, minePendCount: left });
    // 不管本地剩余计数是不是 0，都先向后端查一次下一笔再决定是否"全部到账"：
    // 后端的待领笔数只算当前池子（直连池服务期间不含企微池），本地数到 0 不代表真领完了
    this.setData({
      status: 'between',
      message: left > 0 ? `第 ${n} 笔已到账，正在准备下一笔` : '已到账，正在核对是否还有待领奖励',
    });
    setTimeout(() => this.checkMineQuiet(), 300);
  },
  // 整批完成：多笔时大数字换成本次累计，标题写清共几笔。只在后端明确"没有下一笔"时才到这
  _finishAll() {
    const n = this.data.claimedCount;
    const patch = { status: 'ok', message: n > 1 ? `共 ${n} 笔已全部到账微信零钱` : '' };
    if (n > 1) patch.mineAmt = this.data.claimedYuan;
    this.setData(patch);
    this._celebrate('mineAmt');
    // 可能又来了新奖励：安静地查，绝不用 loading/empty 盖掉"已到账"画面；档案也顺带刷新
    setTimeout(() => {
      this.checkMineQuiet();
      this.refreshProfile();
    }, 1500);
  },

  // 查下一笔失败（接口报错/断网）不能当"领完了"——剩下的钱还挂着。停在"本笔已到账"，给重试
  _nextFailed() {
    this.setData({ status: 'nextfail', message: `已到账 ${this.data.claimedCount} 笔，下一笔暂时没查到，点下方按钮再试` });
  },
  retryNext() {
    if (this.data.status !== 'nextfail') return;
    this.setData({ status: 'between', message: '正在查下一笔' });
    this.checkMineQuiet();
  },

  // 安静查下一笔：只有真的还有奖励才切回领取态，否则保持"已到账"提示不动
  checkMineQuiet() {
    call('/api/claim/mine', 'GET')
      .then((mine) => {
        if (mine && mine.reward) {
          this._pendingTransfer = mine.resume
            ? { mchId: mine.resume.mchId, appId: mine.resume.appId, package_info: mine.resume.package_info, out_bill_no: mine.reward.rid }
            : null;
          this.setData({
            mode: 'mine',
            mineAmt: yuan(mine.reward.amountYuan),
            mineRemark: mine.reward.remark || '',
            issuer: mine.reward.issuer || '',
            resume: !!mine.resume,
            minePendCount: (mine.pending && mine.pending.count) || 1,
            minePendYuan: mine.pending ? yuan(mine.pending.totalYuan) : '',
            status: 'idle',
            message: mine.resume ? '上次确认收款未完成，点击领取继续即可到账' : '',
          });
        } else if (mine && !mine.error) {
          // 后端明确说没有待领了（api.js 会把 HTTP 错误体也 resolve 回来，所以要先排除 error）
          this.setData({ minePendCount: 0, minePendYuan: '' });
          if (this.data.status === 'between') this._finishAll();
        } else if (this.data.status === 'between') {
          this._nextFailed(); // 查询报错 ≠ 领完了
        }
      })
      .catch(() => {
        if (this.data.status === 'between') this._nextFailed();
      });
  },
});
