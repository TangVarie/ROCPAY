const { call } = require('../../api.js');

Page({
  data: {
    ready: false, // /api/me 返回前不渲染任何角色内容，避免管理员打开先闪"你还不是发放员"
    loadFailed: false, // /api/me 拉取失败：专门的错误态，不能把真管理员误判成"你还不是发放员"
    openid: '',
    isAdmin: false,
    isSuper: false,
    roleLabel: '',
    wecomOn: false,
    tab: 'send', // send | records | staff
    minAmountYuan: 0.1,
    maxAmountYuan: 5000,

    // ---- 发放 · 定向批量（主）----
    sendMode: 'target', // target | quick
    step: 'pick', // pick | fill | result
    custQ: '',
    custList: [],
    custLoaded: false,
    custError: false, // 加载失败态：与"真没有客户/搜索无结果"严格区分
    custOffset: 0,
    custHasMore: false,
    custCapped: false,
    custLoading: false,
    syncing: false,
    selected: [], // [{external_userid, label, amountYuan, note}]
    selectedMap: {}, // eu -> true（wxml 勾选态）
    fillAmount: '',
    fillNote: '',
    errIdx: -1, // 批量校验失败的行下标：行内高亮 + 滚动定位，不让运营自己翻着找
    batchResult: null, // {createdCount, errors:[], targets:[]}
    notifyText: '',
    notifying: false,
    notifyDone: false,
    notifyResult: null, // {lines:[], failCount} 群发任务派发结果（派给谁、几人失败）
    myWecomUserid: '', // 本人企微账号映射（''=未配置，群发任务派给客户跟进人）
    sendErr: '',

    // ---- 发放 · 链接快发（副）----
    amountYuan: '',
    remark: '',
    name: '',
    reward: null,
    loading: false,
    error: '',

    // ---- 记录（台账）----
    records: [],
    recLoaded: false, // 首次加载完成前显示加载态，不闪"还没有发放记录"空态
    recError: false, // 加载失败态：断网时不许用空态说谎
    stats: null,
    statsPaidYuan: '0.00',
    recFilter: { status: 'all', days: 0, target: '', targetLabel: '' },
    recOffset: 0,
    recHasMore: false,
    recLoading: false,

    // ---- 客户榜 ----
    rank: [],
    rankLoaded: false,
    rankError: false,
    rankDist: [], // 各等级人数分布
    rankTotal: 0,
    rankLv: null, // 当前筛选的等级（null=全部）
    rankOffset: 0,
    rankHasMore: false,
    rankLoading: false,
    period: null, // 可发额度（运行式余额）{ hasQuota, remainingYuan, paidSinceYuan, low }

    // ---- 限额（/api/me 下发，兜底默认）----
    splitCapYuan: 200, // 微信单笔转账限额，超过自动拆单
    perUserCapYuan: 2000, // 微信单日向单用户上限（拆单也绕不过）

    // ---- 员工 ----
    admins: [],
    newOpenid: '',
    newName: '',
    newRole: 'operator',
    newWecomUserid: '', // 员工企微userid（配置后其群发任务派给本人）
    staffMsg: '',
    staffLoading: false,
    staffListErr: false, // 员工列表加载失败提示（loadAdmins 不许静默失败）
  },

  onLoad() {
    this.init();
  },
  init() {
    call('/api/me', 'GET')
      .then((me) => {
        const isSuper = !!me.isSuper;
        this.setData({
          ready: true,
          openid: me.openid || '',
          isAdmin: !!me.isAdmin,
          isSuper,
          wecomOn: !!me.wecom,
          roleLabel: me.role === 'super' ? '超级管理员' : me.role === 'operator' ? '发放员' : '',
          minAmountYuan: me.minAmountYuan || 0.1,
          maxAmountYuan: me.maxAmountYuan || 5000,
          splitCapYuan: me.splitCapYuan || 200,
          perUserCapYuan: me.perUserDailyCapYuan || 2000,
          myWecomUserid: me.wecomUserid || '',
        });
        if (me.isAdmin) {
          this.loadCustomers();
          this.loadRecords();
          this.loadPeriod();
        }
        if (isSuper) this.loadAdmins();
      })
      .catch((e) =>
        this.setData({ ready: true, loadFailed: true, error: '无法连接后端：' + (e.errMsg || e.message || '') })
      );
  },
  retryInit() {
    this.setData({ ready: false, loadFailed: false, error: '' });
    this.init();
  },

  // 回到前台/从其他页面返回：静默重拉当前 Tab（后台每 10 分钟自动对账，"待确认"可能已变"已到账"，
  // 不刷新的话界面永远停在旧状态）。首次进入时 /api/me 未返回、ready=false，天然跳过不会重复拉
  onShow() {
    if (!this.data.ready || !this.data.isAdmin || this.data.loadFailed) return;
    this._refreshTab();
  },
  onPullDownRefresh() {
    if (this.data.ready && this.data.isAdmin) this._refreshTab();
    wx.stopPullDownRefresh();
  },
  _refreshTab() {
    const t = this.data.tab;
    if (t === 'records') { this.loadRecords(); this.loadPeriod(); }
    else if (t === 'rank') this.loadRank();
    else if (t === 'staff') this.loadAdmins();
    else if (this.data.step === 'pick') this.loadCustomers();
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
    if (tab === 'records') { this.loadRecords(); this.loadPeriod(); }
    if (tab === 'rank') this.loadRank();
    if (tab === 'staff') this.loadAdmins();
  },
  switchSendMode(e) {
    this.setData({ sendMode: e.currentTarget.dataset.m, sendErr: '', error: '' });
  },

  // ============ 定向批量 ============
  onCustQ(e) { this.setData({ custQ: e.detail.value }); },
  // 新搜索条件立即清掉旧列表：宁可短暂加载态，也不许"旧结果 + 新关键词"同框
  searchCustomers() {
    this.setData({ custList: [], custLoaded: false, custError: false, custOffset: 0, custHasMore: false, custCapped: false });
    this.loadCustomers();
  },
  // more=true 追加下一页；否则按当前搜索词重查。分页避免一次塞几千客户。
  // 序号守卫：新查询总是放行（不再被飞行中的旧请求整个吞掉），过期响应直接丢弃；追加时防重复点击
  loadCustomers(more) {
    const isMore = more === true;
    if (isMore && this.data.custLoading) return;
    const seq = (this._custSeq = (this._custSeq || 0) + 1);
    const LIMIT = 60;
    const q = (this.data.custQ || '').trim();
    const offset = isMore ? this.data.custOffset : 0;
    this.setData({ custLoading: true, custError: false });
    call(`/api/customers?limit=${LIMIT}&offset=${offset}&q=${encodeURIComponent(q)}`, 'GET')
      .then((res) => {
        if (seq !== this._custSeq) return; // 条件已切换：旧响应作废
        if (!res || !res.list) return this.setData({ custLoading: false, custLoaded: true, custError: true });
        const page = res.list.map((c) => ({
          external_userid: c.external_userid,
          label: c.remark || c.name || c.external_userid,
          sub: c.remark && c.name && c.remark !== c.name ? c.name : '',
          opened: !!c.opened,
        }));
        this.setData({
          custList: isMore ? this.data.custList.concat(page) : page,
          custOffset: offset + page.length,
          custHasMore: res.hasMore || false,
          custCapped: res.capped || false,
          custLoaded: true,
          custLoading: false,
        });
      })
      .catch(() => {
        if (seq !== this._custSeq) return;
        if (isMore) {
          this.setData({ custLoading: false });
          return wx.showToast({ title: '加载失败，请重试', icon: 'none' });
        }
        this.setData({ custLoading: false, custLoaded: true, custError: true });
      });
  },
  loadMoreCustomers() { this.loadCustomers(true); },

  // 同步客户：后端单次最多跑 ~10s，客户多时返回 partial，这里自动带回进度续传直到跑完
  syncCustomers() {
    if (this.data.syncing) return;
    this.setData({ syncing: true, sendErr: '' });
    const step = (startIndex, cursor, acc) =>
      call('/api/customers/sync', 'POST', { startIndex, cursor }).then((res) => {
        if (res && res.error) throw new Error(res.error);
        const total = acc + (res.synced || 0);
        if (res.partial) return step(res.nextIndex, res.nextCursor || '', total);
        return total;
      });
    step(0, '', 0)
      .then((total) => {
        this.setData({ syncing: false });
        wx.showToast({ title: `已同步 ${total} 位客户`, icon: 'success' });
        this.loadCustomers();
      })
      .catch((e) => this.setData({ syncing: false, sendErr: '同步失败：' + (e.message || e.errMsg || '') }));
  },

  toggleCust(e) {
    const eu = e.currentTarget.dataset.eu;
    const label = e.currentTarget.dataset.label;
    const selected = this.data.selected.slice();
    const map = Object.assign({}, this.data.selectedMap);
    const idx = selected.findIndex((s) => s.external_userid === eu);
    if (idx >= 0) {
      selected.splice(idx, 1);
      delete map[eu];
    } else {
      selected.push({ external_userid: eu, label, amountYuan: '', note: '' });
      map[eu] = true;
    }
    this.setData({ selected, selectedMap: map });
  },

  clearSelected() { this.setData({ selected: [], selectedMap: {} }); },
  goFill() {
    if (!this.data.selected.length) return this.setData({ sendErr: '先勾选要发放的客户' });
    this.setData({ step: 'fill', sendErr: '', errIdx: -1 });
  },
  backPick() { this.setData({ step: 'pick', sendErr: '', errIdx: -1 }); },

  onRowAmount(e) {
    const i = e.currentTarget.dataset.i;
    const patch = { [`selected[${i}].amountYuan`]: e.detail.value };
    if (this.data.errIdx === i) { patch.errIdx = -1; patch.sendErr = ''; } // 改过就撤掉高亮
    this.setData(patch);
  },
  onRowNote(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ [`selected[${i}].note`]: e.detail.value });
  },
  removeRow(e) {
    const i = e.currentTarget.dataset.i;
    const selected = this.data.selected.slice();
    const map = Object.assign({}, this.data.selectedMap);
    delete map[selected[i].external_userid];
    selected.splice(i, 1);
    this.setData({ selected, selectedMap: map, step: selected.length ? 'fill' : 'pick', errIdx: -1 });
  },
  onFillAmount(e) { this.setData({ fillAmount: e.detail.value }); },
  onFillNote(e) { this.setData({ fillNote: e.detail.value }); },
  applyFill() {
    const a = this.data.fillAmount;
    const n = this.data.fillNote;
    const selected = this.data.selected.map((s) => ({
      ...s,
      amountYuan: a !== '' ? a : s.amountYuan,
      note: n !== '' ? n : s.note,
    }));
    this.setData({ selected });
  },

  // 大额自动拆单（镜像后端逻辑，仅用于预览笔数）：总额按单笔限额拆，余数不够起付就并入最后一笔对半
  _splitBillsCount(totalFen, capFen, minFen) {
    if (totalFen <= capFen) return 1;
    const k = Math.floor(totalFen / capFen);
    const r = totalFen - k * capFen;
    if (r === 0) return k;
    return k + 1; // r ≥ min 追加一笔；r < min 时最后一整笔+余数对半，同样是 k+1 笔
  },

  // 校验失败：报错 + 高亮该行 + 滚动定位（选 30 人时不让运营自己翻着找哪行错了）
  _rowErr(i, msg) {
    this.setData({ sendErr: msg, errIdx: i }, () => {
      try {
        wx.pageScrollTo({ selector: '.frow-err', offsetTop: -160, duration: 200, fail: () => {} });
      } catch (_) { /* 低版本基础库不支持 selector 定位，只高亮不滚动 */ }
    });
  },
  submitBatch() {
    if (this.data.loading) return; // 防连点：重复提交会生成重复奖励（重复打款）
    const { selected, minAmountYuan, perUserCapYuan, splitCapYuan, period } = this.data;
    // 最多两位小数：后端按 Math.round(元*100) 落分，1.234 会被静默按 1.23 发出去，必须在输入侧拦住
    const AMT_RE = /^\d+(\.\d{1,2})?$/;
    for (let i = 0; i < selected.length; i++) {
      const raw = String(selected[i].amountYuan == null ? '' : selected[i].amountYuan).trim();
      const yuan = Number(raw);
      if (!(yuan > 0)) return this._rowErr(i, `「${selected[i].label}」还没填金额`);
      if (!AMT_RE.test(raw)) return this._rowErr(i, `「${selected[i].label}」金额最多两位小数`);
      if (yuan < minAmountYuan) return this._rowErr(i, `「${selected[i].label}」金额不能小于 ${minAmountYuan} 元`);
      if (yuan > perUserCapYuan) return this._rowErr(i, `「${selected[i].label}」单人不能超过 ${perUserCapYuan} 元（微信单日向单用户上限，拆单也绕不过）`);
    }
    this.setData({ errIdx: -1, sendErr: '' });
    // 真金白银出账前必须过目一次汇总：人数、拆单后笔数、合计、最大单人；额度不够再多一句硬提醒
    const capFen = Math.round(splitCapYuan * 100);
    const minFen = Math.round(minAmountYuan * 100);
    let totalFen = 0;
    let maxFen = 0;
    let totalBills = 0;
    selected.forEach((s) => {
      const f = Math.round(Number(s.amountYuan) * 100);
      totalFen += f;
      if (f > maxFen) maxFen = f;
      totalBills += this._splitBillsCount(f, capFen, minFen);
    });
    const totalYuan = (totalFen / 100).toFixed(2);
    let content = `共 ${selected.length} 人`;
    if (totalBills > selected.length) content += ` · 拆成 ${totalBills} 笔（单笔≤¥${splitCapYuan}，客户逐笔确认）`;
    content += `\n合计 ¥${totalYuan}\n最大单人 ¥${(maxFen / 100).toFixed(2)}`;
    if (period && period.hasQuota && Number(period.remainingYuan) < totalFen / 100) {
      content += `\n\n注意：可发额度仅剩 ¥${period.remainingYuan}，本次将超出，请先确认商户余额充足。`;
    }
    wx.showModal({
      title: '确认发放',
      content,
      confirmText: '确认发放',
      confirmColor: '#235e8e',
      success: (r) => { if (r.confirm) this._doSubmitBatch(); },
    });
  },
  _doSubmitBatch() {
    const { selected } = this.data;
    this.setData({ sendErr: '', loading: true });
    const items = selected.map((s) => ({
      externalUserid: s.external_userid,
      amountYuan: Number(s.amountYuan),
      remark: s.note || '',
    }));
    call('/api/rewards/batch', 'POST', { items })
      .then((res) => {
        this.setData({ loading: false });
        if (res && res.error) return this.setData({ sendErr: res.error });
        // 拆单后同一客户出现多笔 → 通知名单去重，每人只发一张卡片
        const targets = [...new Set((res.created || []).map((c) => c.externalUserid))];
        const labelOf = {};
        selected.forEach((s) => (labelOf[s.external_userid] = s.label));
        this.setData({
          step: 'result',
          batchResult: {
            createdCount: res.createdCount, // 拆单后的总笔数
            peopleCount: res.peopleCount || targets.length,
            errors: (res.errors || []).map((er) => ({ ...er, label: labelOf[er.target] || er.target || '' })),
            targets,
          },
          notifyText: '你有一笔奖励待领取，打开【梨响ROC】小程序即可领取～',
          notifyDone: false,
        });
        this.loadRecords();
      })
      .catch((e) => this.setData({ loading: false, sendErr: '网络错误：' + (e.errMsg || e.message || '') }));
  },

  onNotifyText(e) { this.setData({ notifyText: e.detail.value }); },
  sendNotify() {
    const r = this.data.batchResult;
    if (!r || !r.targets.length || this.data.notifying) return;
    this.setData({ notifying: true, sendErr: '' });
    call('/api/deliver', 'POST', { externalUserids: r.targets, text: this.data.notifyText })
      .then((res) => {
        this.setData({ notifying: false });
        if (res && res.error) return this.setData({ sendErr: res.error });
        // 任务按客户跟进人分组派发（企微规则：谁跟进谁发）。把"派给了谁"讲清楚，
        // 不然任务落在别的员工那里，发起人以为群发没生效
        const lines = [];
        (res.tasks || []).forEach((t) => {
          const okCount = t.count - (t.failCount || 0);
          const who = t.senderSelf ? '你' : t.sender ? '员工 ' + t.sender : '按企微默认跟进人';
          lines.push(who + '：' + okCount + ' 位客户' + (t.failCount ? '（' + t.failCount + ' 位未能创建）' : ''));
        });
        (res.errors || []).forEach((er) => {
          lines.push((er.sender ? '员工 ' + er.sender : '默认组') + '：创建失败——' + er.error);
        });
        this.setData({
          notifyDone: true,
          notifyResult: { lines, failCount: res.failCount || 0 },
        });
        wx.showModal({
          title: '群发任务已创建',
          content:
            (lines.length ? lines.join('\n') + '\n\n' : '') +
            '任务派给了对应跟进员工：请让他们留意企微「消息-客户联系」的提醒（或打开 工作台-群发助手），点一次【发送】即可送达客户。',
          showCancel: false,
        });
      })
      .catch((e) => this.setData({ notifying: false, sendErr: '通知失败：' + (e.errMsg || e.message || '') }));
  },

  newBatch() {
    this.setData({ step: 'pick', selected: [], selectedMap: {}, batchResult: null, sendErr: '', errIdx: -1, notifyDone: false, notifyResult: null });
  },

  // ============ 链接快发（副） ============
  onAmount(e) { this.setData({ amountYuan: e.detail.value }); },
  onRemark(e) { this.setData({ remark: e.detail.value }); },
  onName(e) { this.setData({ name: e.detail.value }); },
  onGenerate() {
    if (this.data.loading) return; // 防连点
    const raw = String(this.data.amountYuan == null ? '' : this.data.amountYuan).trim();
    const yuan = Number(raw);
    if (!(yuan > 0)) return this.setData({ error: '请输入正确金额' });
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return this.setData({ error: '金额最多两位小数' });
    if (yuan < this.data.minAmountYuan)
      return this.setData({ error: `金额不能小于 ${this.data.minAmountYuan} 元` });
    if (yuan > this.data.splitCapYuan)
      return this.setData({ error: `链接快发是单笔转账，限额 ¥${this.data.splitCapYuan}；大额请用「定向发放」（自动拆成多笔）` });
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
    const r = this.data.reward;
    if (this.data.sendMode === 'quick' && r && r.token) {
      return {
        title: `请领取 ¥${r.amountYuan} 奖励`,
        path: `/pages/claim/claim?token=${encodeURIComponent(r.token)}&amt=${r.amountYuan}&remark=${encodeURIComponent(r.remark || '')}`,
      };
    }
    // 定向发放：分享领取入口即可（客户按身份识别，无需令牌）
    return { title: '你的奖励到啦，点开领取', path: '/pages/claim/claim' };
  },

  // ============ 记录 ============
  // 可发额度（运行式余额）：剩余 + 自上次充值已发放
  loadPeriod() {
    call('/api/period', 'GET')
      .then((res) => this.applyPeriod(res))
      .catch(() => this.setData({ period: null }));
  },
  applyPeriod(res) {
    if (!res || res.error || typeof res.hasQuota !== 'boolean') return this.setData({ period: null });
    if (!res.hasQuota) return this.setData({ period: { hasQuota: false } });
    const rem = Number(res.remainingYuan) || 0;
    this.setData({
      period: {
        hasQuota: true,
        remainingYuan: rem.toFixed(2),
        paidSinceYuan: (Number(res.paidSinceYuan) || 0).toFixed(2),
        low: rem <= 0, // 剩余告罄/超支
      },
    });
  },
  // 充值（累加，携带上期结余）/ 校准（把剩余设为账户实际余额）
  adjustQuota(e) {
    const mode = e.currentTarget.dataset.mode === 'set' ? 'set' : 'add';
    const isSet = mode === 'set';
    wx.showModal({
      title: isSet ? '校准余额' : '充值',
      editable: true,
      content: '',
      placeholderText: isSet ? '账户实际剩余(元)' : '本次充值金额(元)',
      confirmText: isSet ? '设为剩余' : '加进额度',
      success: (r) => {
        if (!r.confirm) return;
        const raw = (r.content || '').trim(); // 空/纯空格不能当 0 静默提交
        if (raw === '') return wx.showToast({ title: '请输入金额', icon: 'none' });
        const yuan = Number(raw);
        if (Number.isNaN(yuan) || yuan < 0 || (!isSet && yuan <= 0)) {
          return wx.showToast({ title: '请输入正确金额', icon: 'none' });
        }
        call('/api/period/adjust', 'POST', { mode, yuan })
          .then((res) => {
            if (res && res.error) return wx.showToast({ title: res.error, icon: 'none' });
            wx.showToast({ title: isSet ? '已校准' : '已充值', icon: 'success' });
            this.applyPeriod(res);
          })
          .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }));
      },
    });
  },

  // 台账：more=true 追加下一页，否则按当前筛选重查。列表与汇总同口径（stats 即筛选范围的消耗）。
  // 序号守卫：切筛选时新查询总是放行（不再被飞行中的旧请求吞掉造成"chip 是新条件、数据是旧结果"），
  // 过期响应直接丢弃；追加时防重复点击
  loadRecords(more) {
    const isMore = more === true;
    if (isMore && this.data.recLoading) return;
    const seq = (this._recSeq = (this._recSeq || 0) + 1);
    const LIMIT = 40;
    const offset = isMore ? this.data.recOffset : 0;
    const f = this.data.recFilter;
    this.setData({ recLoading: true, recError: false });
    call(
      `/api/rewards?limit=${LIMIT}&offset=${offset}&status=${f.status}&days=${f.days}&target=${encodeURIComponent(f.target)}`,
      'GET'
    )
      .then((res) => {
        if (seq !== this._recSeq) return; // 筛选已切换：旧响应作废
        if (!res || !res.list) return this.setData({ recLoading: false, recLoaded: true, recError: true });
        const map = { SUCCESS: '已到账', WAIT_USER_CONFIRM: '待确认', FAIL: '失败', CLOSED: '已关闭', CANCELLED: '已撤回', CANCELING: '撤销中', CREATED: '待领取', CLAIMED: '待确认' };
        const records = res.list.map((r) => {
          const st = r.transfer_state || r.status || 'CREATED';
          const by = r.created_by_name || '';
          return {
            rid: r.rid,
            yuan: (r.amount_fen / 100).toFixed(2),
            // 副行：备注 + 谁发的（多发放员团队对账/追责要看这个）
            sub: (r.remark || '客户奖励') + (by ? ' · ' + by + ' 发放' : ''),
            who: r.target_remark || r.target_name || (r.target_external_userid ? '定向客户' : ''),
            eu: r.target_external_userid || '',
            statusText: map[st] || st,
            cls:
              st === 'SUCCESS'
                ? 'ok'
                : st === 'FAIL' || st === 'CLOSED' || st === 'CANCELLED' || st === 'CANCELING'
                ? 'fail'
                : 'warn',
            // 只有还没到账的能撤：未领取直接作废；已领待确认向微信撤销资金回流
            canRevoke: r.status === 'CREATED' || r.status === 'CLAIMED',
            createdAt: (r.created_at || '').replace('T', ' ').slice(5, 16),
            createdFull: (r.created_at || '').replace('T', ' '), // 详情层用完整时间（跨年对账不丢年份）
            billNo: r.transfer_bill_no || '', // 微信转账单号：与商户平台逐笔勾稽的凭据
          };
        });
        const all = isMore ? this.data.records.concat(records) : records;
        const total = res.stats ? Number(res.stats.total) : NaN;
        this.setData({
          records: all,
          recOffset: offset + records.length,
          // stats.total 与列表同筛选口径，用它判定还有没有下一页（总数恰为 40 整数倍时不再多出空页）
          recHasMore: Number.isFinite(total) ? all.length < total : records.length === LIMIT,
          recLoaded: true,
          recLoading: false,
          stats: res.stats || null,
          statsTotalYuan: res.stats ? (res.stats.total_fen / 100).toFixed(2) : '0.00',
          statsPaidYuan: res.stats ? ((res.stats.paid_fen || 0) / 100).toFixed(2) : '0.00',
        });
      })
      .catch(() => {
        if (seq !== this._recSeq) return;
        if (isMore) {
          this.setData({ recLoading: false });
          return wx.showToast({ title: '加载失败，请重试', icon: 'none' });
        }
        this.setData({ recLoading: false, recLoaded: true, recError: true });
      });
  },
  loadMoreRecords() { this.loadRecords(true); },
  reloadRecords() { this.loadRecords(); },
  // 筛选条件变了：立即清掉旧列表换加载态，绝不允许"旧数据 + 新条件"同框
  _resetRecords() {
    this.setData({ records: [], recLoaded: false, recError: false, recOffset: 0, recHasMore: false, stats: null });
  },
  pickRecFilter(e) {
    const { k, v } = e.currentTarget.dataset;
    const f = Object.assign({}, this.data.recFilter);
    if (k === 'days') f.days = Number(v) || 0;
    else f.status = v;
    this.setData({ recFilter: f });
    this._resetRecords();
    this.loadRecords();
  },
  // 点记录里的客户名 → 只看这个人的资金往来（stats 同步变成单人汇总）
  filterByCustomer(e) {
    const { eu, label } = e.currentTarget.dataset;
    if (!eu) return;
    this.setData({ recFilter: Object.assign({}, this.data.recFilter, { target: eu, targetLabel: label || '该客户' }) });
    this._resetRecords();
    this.loadRecords();
  },
  clearCustomerFilter() {
    this.setData({ recFilter: Object.assign({}, this.data.recFilter, { target: '', targetLabel: '' }) });
    this._resetRecords();
    this.loadRecords();
  },
  // 记录详情：对账取证用——完整时间 / 商户单号 rid / 微信转账单号，一键复制
  showRecDetail(e) {
    const r = this.data.records[e.currentTarget.dataset.i];
    if (!r) return;
    const lines = [
      `¥${r.yuan} · ${r.statusText}`,
      r.who ? `客户：${r.who}` : '',
      `备注：${r.sub}`,
      `创建：${r.createdFull}`,
      `商户单号：${r.rid}`,
      `微信单号：${r.billNo || '—（转账发起后生成）'}`,
    ].filter(Boolean);
    const copyVal = r.billNo || r.rid;
    wx.showModal({
      title: '记录详情',
      content: lines.join('\n'),
      confirmText: '复制单号', // 有微信单号复制微信单号，否则复制商户单号
      cancelText: '关闭',
      success: (res) => {
        if (res.confirm && copyVal) {
          wx.setClipboardData({ data: copyVal, success: () => wx.showToast({ title: '已复制', icon: 'success' }) });
        }
      },
    });
  },
  // ============ 客户榜（等级总榜 + 分布 + 筛选 + 分页） ============
  // more=true 追加下一页；否则重查。分布 dist/total 只在第一页返回，不覆盖翻页。
  // 序号守卫同 loadRecords：切等级筛选不被飞行中的旧请求吞掉，过期响应丢弃
  loadRank(more) {
    const isMore = more === true;
    if (isMore && this.data.rankLoading) return;
    const seq = (this._rankSeq = (this._rankSeq || 0) + 1);
    const lv = this.data.rankLv;
    const offset = isMore ? this.data.rankOffset : 0;
    this.setData({ rankLoading: true, rankError: false });
    call(`/api/leaderboard?offset=${offset}` + (lv != null ? '&lv=' + lv : ''), 'GET')
      .then((res) => {
        if (seq !== this._rankSeq) return; // 筛选已切换：旧响应作废
        if (!res || !res.list) return this.setData({ rankLoading: false, rankLoaded: true, rankError: true });
        const page = res.list.map((r) => Object.assign({}, r, { totalYuanText: (Number(r.totalYuan) || 0).toFixed(2) }));
        const patch = {
          rank: isMore ? this.data.rank.concat(page) : page,
          rankOffset: offset + page.length,
          rankHasMore: res.hasMore || false,
          rankLoaded: true,
          rankLoading: false,
        };
        if (res.dist) { patch.rankDist = res.dist; patch.rankTotal = res.total || 0; }
        this.setData(patch);
      })
      .catch(() => {
        if (seq !== this._rankSeq) return;
        if (isMore) {
          this.setData({ rankLoading: false });
          return wx.showToast({ title: '加载失败，请重试', icon: 'none' });
        }
        this.setData({ rankLoading: false, rankLoaded: true, rankError: true });
      });
  },
  loadMoreRank() { this.loadRank(true); },
  reloadRank() { this.loadRank(); },
  pickRankLv(e) {
    const v = e.currentTarget.dataset.lv;
    const lv = v === '' || v == null ? null : Number(v);
    // 再点一次取消；换条件即清旧列表（分布 chip 的人数保留，不闪）
    this.setData({
      rankLv: this.data.rankLv === lv ? null : lv,
      rank: [],
      rankLoaded: false,
      rankError: false,
      rankOffset: 0,
      rankHasMore: false,
    });
    this.loadRank();
  },
  // 点榜单行 → 跳到记录页只看该客户的资金往来（单人台账）
  goCustomerLedger(e) {
    const { eu, label } = e.currentTarget.dataset;
    if (!eu) return wx.showToast({ title: '该客户不在企微档案，暂无法跳转', icon: 'none' });
    this.setData({
      tab: 'records',
      recFilter: Object.assign({}, this.data.recFilter, { target: eu, targetLabel: label || '该客户' }),
    });
    this._resetRecords();
    this.loadRecords();
    this.loadPeriod();
  },

  // 撤回：未领取→作废；已领待确认→向微信撤销转账，冻结资金退回商户余额
  revokeReward(e) {
    const { rid, yuan, who } = e.currentTarget.dataset;
    wx.showModal({
      title: '撤回这笔奖励',
      content: `¥${yuan}${who ? ' · ' + who : ''}\n撤回后客户不可再领取；已发起待确认的转账将向微信撤销，资金退回商户余额。`,
      confirmText: '撤回',
      confirmColor: '#b8293c',
      success: (r) => {
        if (!r.confirm) return;
        call('/api/rewards/revoke', 'POST', { rid })
          .then((res) => {
            if (res && res.error) return wx.showToast({ title: res.error, icon: 'none' });
            wx.showToast({ title: '已撤回', icon: 'success' });
            this.loadRecords();
            this.loadPeriod();
          })
          .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }));
      },
    });
  },

  // ============ 员工 ============
  loadAdmins() {
    this.setData({ staffListErr: false });
    call('/api/admins', 'GET')
      .then((res) => {
        if (res && res.list) {
          const admins = res.list.map((a) => ({
            openid: a.openid,
            name: a.name || '（未命名）',
            roleText: a.role === 'super' ? '超管' : '发放员',
            isSuper: a.role === 'super',
            isMe: a.openid === this.data.openid,
            wecomUserid: a.wecom_userid || '',
          }));
          this.setData({ admins });
        } else {
          this.setData({ staffListErr: true }); // 失败不许无感知：给可点重试的提示
        }
      })
      .catch(() => this.setData({ staffListErr: true }));
  },
  onNewOpenid(e) { this.setData({ newOpenid: e.detail.value }); },
  onNewName(e) { this.setData({ newName: e.detail.value }); },
  onNewWecomUserid(e) { this.setData({ newWecomUserid: e.detail.value }); },
  pickRole(e) { this.setData({ newRole: e.currentTarget.dataset.role }); },
  addStaff() {
    const openid = (this.data.newOpenid || '').trim();
    if (!openid) return this.setData({ staffMsg: '请粘贴员工的 openid' });
    this.setData({ staffLoading: true, staffMsg: '' });
    call('/api/admins', 'POST', {
      openid,
      name: this.data.newName,
      role: this.data.newRole,
      wecomUserid: (this.data.newWecomUserid || '').trim(),
    })
      .then((res) => {
        this.setData({ staffLoading: false });
        if (res && res.error) return this.setData({ staffMsg: res.error });
        this.setData({ newOpenid: '', newName: '', newRole: 'operator', newWecomUserid: '', staffMsg: '' });
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
      confirmColor: '#b3402a',
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
