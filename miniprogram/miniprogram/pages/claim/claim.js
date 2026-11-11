const { call } = require('../../api.js');
const { yuan, num } = require('../../money.js');

// 到账时间：后端给的是微信的 RFC3339 时间（带时区），按手机本地时间显示到分钟；给的不是合法时间就不显示
function fmtArrived(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
    // 「有新奖励时提醒我」：后端配了订阅模板才显示；只在到账后和空态由用户主动点，领取前不弹
    subOn: false,
    subState: '', // '' 未开 | saving 落库中 | on 已开启 | off 拒绝了（给去设置打开的说明，不再出按钮）
    // 到账凭证（到账后才有）：{ time 到账时间（可能为空）, rid 展示的单号（多笔时是第一笔）, all 复制用（多笔一行一个）, count 笔数 }
    receipt: null,
    subAlways: false, // 客户在订阅面板勾过「总是保持以上选择」并选了允许：以后不弹窗，每次领取自动续上
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
    call('/api/me', 'GET')
      .then((me) => {
        if (me && me.openid) {
          this._subTmplId = me.subscribeTmplId || ''; // 订阅消息模板（''=后端未配置，静默关闭）
          this.setData({
            openid: me.openid,
            isAdmin: !!me.isAdmin,
            profile: this._profileOf(me),
            subOn: !!this._subTmplId && !this._subBanned, // 到账后刷新档案也走这里，被封禁的模板别再冒出来
          });
          this._readSubSetting();
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
        subOn: !!this._subTmplId && !this._subBanned, // "有新奖励时提醒我"的开关（空态、到账后）
      };
      this._readSubSetting();
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
    // 客户可能刚去「设置 › 通知管理」改过提醒开关，回来按新设置显示
    if (this._subTmplId) this._readSubSetting();
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
          this.setData({ status: 'fail', resume: true, message: '还没确认收款，点上方按钮继续确认' });
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
          if (st === 'SUCCESS') {
            this._noteArrival(rid, r.arrivedAt);
            return onArrived();
          }
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
    this.setData({ status: 'arriving', message: '微信正在入账，通常几秒到几分钟。稍后下拉页面或点上方按钮刷新结果' });
  },
  refreshArrival() {
    if (this.data.status !== 'arriving') return;
    this._waitArrival(this._arrRid, this._arrOnArrived);
  },
  onUnload() {
    this._arrSeq = (this._arrSeq || 0) + 1; // 离开页面：停掉查单轮询
  },

  // 下拉刷新：只在「等结果 / 出错了」的状态下有事可做，其余状态松手即回弹，不打断正在进行的领取
  onPullDownRefresh() {
    const d = this.data;
    if (d.mode === 'error' || d.mode === 'empty') this.checkMine(); // 连不上重试；空态看看有没有新奖励
    else if (d.mode === 'token' && d.amtUnverified) {
      if (!d.verifying) this.retryToken();
    } else if (d.status === 'arriving') this.refreshArrival();
    else if (d.status === 'nextfail') this.retryNext();
    wx.stopPullDownRefresh(); // 结果都落在页面自己的状态上，下拉的三个点不用一直转
  },

  // ---- 到账凭证 ----
  // 每笔查到 SUCCESS 时记一条（单号 + 微信给的到账时间）；整批到账时汇成一张凭证放进收款单：
  // 客户被问「到了没」截一张图就行，员工拿单号在台账里一搜就到这笔
  _noteArrival(rid, arrivedAt) {
    if (!rid) return;
    const list = this._arrivals || (this._arrivals = []);
    if (!list.some((x) => x.rid === rid)) list.push({ rid, at: arrivedAt || '' });
  },
  _receiptOf() {
    const list = this._arrivals || [];
    if (!list.length) return null;
    const n = list.length;
    return {
      time: fmtArrived(list[n - 1].at), // 多笔取最后一笔的到账时间
      rid: list[0].rid,
      all: list.map((x) => x.rid).join('\n'),
      count: n,
    };
  },
  copyReceipt() {
    const r = this.data.receipt;
    if (!r || !r.all) return;
    // 复制成功微信自带「内容已复制」提示，不再叠一个；失败（如隐私指引没声明剪贴板）给长按的退路
    wx.setClipboardData({
      data: r.all,
      fail: () => wx.showToast({ title: '复制失败，请长按单号复制', icon: 'none' }),
    });
  },
  // 到账那一下轻震一次（只在整批到账时，中间几笔不震）。机型不支持或被系统关掉都无所谓
  _buzz() {
    if (typeof wx.vibrateShort !== 'function') return;
    try {
      wx.vibrateShort({ type: 'light', fail() {} });
    } catch (e) {
      /* 老基础库不认 type 参数 */
    }
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
    this.setData({ status: 'ok', message: '', receipt: this._receiptOf() }); // 标题已是"已到账微信零钱"，提示行不再重复
    this._buzz();
    this._celebrate('amtText');
    setTimeout(() => this.refreshProfile(), 1200); // 到账后档案(合作次数/累计)自动 +1
  },

  // 「有新奖励时提醒我」：只在用户主动点时弹系统授权——领取前不打扰（那一刻客户只想领钱，
  // 授权窗还会和微信「确认收款」半屏抢位置），到账后和空态各给一个入口。
  // 按钮上方先说清为什么要（场景 04：先说为什么，再弹授权）；拒绝了就给去设置里打开的说明，
  // 本次不再出按钮，不反复弹。一次授权 = 之后一条服务通知，所以文案写「开一次提醒一次」。
  // 例外：勾过「总是允许」的客户不会再看到弹窗，领取时静默续（见 _withSilentRenew）
  askSubscribe() {
    const id = this._subTmplId;
    if (!id || this.data.subState === 'saving') return;
    if (typeof wx.requestSubscribeMessage !== 'function') {
      return wx.showToast({ title: '当前微信版本过低', icon: 'none' });
    }
    wx.requestSubscribeMessage({
      tmplIds: [id],
      success: (r) => {
        const v = r && r[id];
        if (v === 'accept') return this._saveGrant();
        // ban / filter：模板被封禁或被过滤，是后台的问题，客户怎么点都没用——收起入口
        if (v === 'ban' || v === 'filter') {
          this._subBanned = true;
          return this.setData({ subOn: false });
        }
        this._subRejected = true; // 这次会话里拒绝过：重读设置时也不再把按钮放回来（不反复问）
        this.setData({ subState: 'off' }); // reject：这次拒绝，或勾过「总是保持以上选择」
      },
      fail: (e) => {
        // 20004：客户在设置里关了「接收通知」总开关，和拒绝一样引导去设置
        if (e && e.errCode === 20004) return this.setData({ subState: 'off' });
        wx.showToast({ title: '没能打开提醒，请再点一次', icon: 'none' });
      },
    });
  },
  // 授权落库：微信侧已实际消耗一次授权，落库失败 = 白丢。失败自动重试一次；仍失败退回未开启，
  // 让客户再点（勾过「总是保持」的客户再点不弹窗，等于纯重试落库）。万一本地多记：
  // 发送时微信回 43101 会把本地配额对齐清零，能自愈。只有后端确认成功才显示「已开启」。
  // silent：领取时静默续的那一次，失败不打扰客户（下次领取再续）
  _saveGrant(retried, silent) {
    if (!silent) this.setData({ subState: 'saving' });
    call('/api/subscribe/grant', 'POST', {})
      .then((res) => {
        if (res && res.error) throw new Error(res.error);
        this.setData({ subState: 'on' });
        // 客户这次在面板里勾了「总是保持以上选择」的话，提示换成「每次领取自动续上」
        if (!silent) this._readSubSetting();
      })
      .catch(() => {
        if (!retried) return setTimeout(() => this._saveGrant(true, silent), 1000);
        if (silent) return;
        this.setData({ subState: '' });
        wx.showToast({ title: '网络错误，提醒没开成，请再点一次', icon: 'none' });
      });
  },

  // 读客户在微信里对这个提醒「记住的选择」。只有在订阅面板里勾过「总是保持以上选择，不再询问」才有记录，
  // 之后再请求授权微信都不弹窗、直接按记住的选择处理——客户会觉得「点了没反应」：
  //   accept → 不用再问：点领取时顺手静默续一次（_withSilentRenew），到账后提示「每次领取自动续上」
  //   reject，或微信「接收通知」总开关关着 → 请求也不弹窗、直接算拒绝：不放按钮，直接给去设置打开的说明
  //   ban / filter → 模板被封禁或被过滤，收起入口
  //   没有记录（没勾过）→ 照旧：到账后由客户自己点「有新奖励时提醒我」
  // 基础库太老读不到（没有 withSubscriptions）或读失败：当作没有记录，不影响别的
  _readSubSetting() {
    if (!this._subTmplId || typeof wx.getSetting !== 'function') return;
    wx.getSetting({
      withSubscriptions: true,
      success: (res) => this._applySubSetting(res && res.subscriptionsSetting),
      fail: () => this._applySubSetting(null),
    });
  },
  _applySubSetting(ss) {
    const id = this._subTmplId;
    if (!id) return;
    if (!ss) {
      // 读不到（失败，或基础库没有订阅设置）：当作没有记录。之前读到的「总是允许」不能再当依据——
      // 客户可能刚在设置里改过，沿用旧记录静默续，下次点领取就可能真弹出授权窗
      this._subAlways = '';
      return this.setData({ subAlways: false });
    }
    const item = ss.itemSettings ? ss.itemSettings[id] : undefined;
    if (item === 'ban' || item === 'filter') {
      this._subBanned = true;
      this._subAlways = '';
      return this.setData({ subOn: false, subAlways: false });
    }
    const always = ss.mainSwitch === false || item === 'reject' ? 'reject' : item === 'accept' ? 'accept' : '';
    this._subAlways = always;
    const patch = { subAlways: always === 'accept' };
    const cur = this.data.subState;
    if (always === 'reject') {
      // 明确的拒绝、或通知总开关关着：连「已开启」也要覆盖——客户刚去设置关掉，再说「微信会通知你」就不对了。
      // 正在落库的不动：手动开启落库成功后会再读一次设置，按那时的结果校正
      if (cur !== 'saving') patch.subState = 'off';
    } else if (cur === 'off' && !this._subRejected) {
      // 设置里已经不是拒绝了（客户刚去打开过）：把按钮放回来；这次会话里亲手拒绝过的除外
      patch.subState = '';
    }
    this.setData(patch);
  },
  // 勾过「总是允许」的客户：点领取时顺手续一次提醒授权。这时微信不弹窗，不会和「确认收款」半屏抢位置；
  // 必须在点击手势里同步调起（微信规定），所以放在领取按钮的处理函数开头。每次打开页面最多续一次。
  // 串行：授权调用结束（complete）再走领取——万一设置刚被改过、微信还是弹了窗，也不会和确认页叠在一起。
  // 续没续上都不影响领取；没续上的到账后还有按钮可点
  _withSilentRenew(next) {
    const id = this._subTmplId;
    if (this._subAlways !== 'accept' || !id || this._subRenewed || typeof wx.requestSubscribeMessage !== 'function') {
      return next();
    }
    this._subRenewed = true;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      next();
    };
    wx.requestSubscribeMessage({
      tmplIds: [id],
      success: (r) => {
        const v = r && r[id];
        if (v === 'accept') return this._saveGrant(false, true);
        if (v === 'ban' || v === 'filter') {
          this._subBanned = true;
          this._subAlways = '';
          return this.setData({ subOn: false, subAlways: false });
        }
        if (v === 'reject') {
          // 设置刚被改过、这次真弹了窗被客户拒绝：和亲手点按钮拒绝一样记下来，本次不再问
          this._subRejected = true;
          this._subAlways = '';
          this.setData({ subState: 'off', subAlways: false });
        }
        this._readSubSetting(); // 记住的选择变了：重读，界面跟着变
      },
      fail: (e) => {
        // 「本页已续过」不撤：失败也不在下一笔领取时再请求一次
        if (e && e.errCode === 20004) {
          // 通知总开关刚被关掉：和读到总开关关着一样，给去设置的说明
          this._subAlways = 'reject';
          return this.setData({ subState: 'off', subAlways: false });
        }
        this._readSubSetting();
      },
      complete: go,
    });
  },

  // 链接领取（令牌）
  onClaimToken() {
    if (!this.data.token || this.data.status === 'loading') return;
    // 确认页被手滑关掉后再点：直接重开确认，别再 POST（转账已发起，重开即可）
    if (this._pendingTransfer) {
      this.setData({ status: 'loading', message: '' });
      return this._withSilentRenew(() => this._confirmTransfer(this._pendingTransfer, () => this._tokenOk()));
    }
    if (this.data.amtUnverified) return; // 金额没核验不许领（按钮本就不渲染，这里兜底）
    this.setData({ status: 'loading', message: '' });
    this._withSilentRenew(() => this._doClaimToken());
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
      return this._withSilentRenew(() => this._confirmTransfer(this._pendingTransfer, () => this._afterMineOk()));
    }
    this.setData({ status: 'loading', message: '' });
    this._withSilentRenew(() => this._doClaimMine());
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
    const patch = { status: 'ok', message: n > 1 ? `共 ${n} 笔已全部到账微信零钱` : '', receipt: this._receiptOf() };
    if (n > 1) patch.mineAmt = this.data.claimedYuan;
    this.setData(patch);
    this._buzz();
    this._celebrate('mineAmt');
    // 可能又来了新奖励：安静地查，绝不用 loading/empty 盖掉"已到账"画面；档案也顺带刷新
    setTimeout(() => {
      this.checkMineQuiet();
      this.refreshProfile();
    }, 1500);
  },

  // 查下一笔失败（接口报错/断网）不能当"领完了"——剩下的钱还挂着。停在"本笔已到账"，给重试
  _nextFailed() {
    this.setData({ status: 'nextfail', message: `已到账 ${this.data.claimedCount} 笔，下一笔暂时没查到，点上方按钮再试` });
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
