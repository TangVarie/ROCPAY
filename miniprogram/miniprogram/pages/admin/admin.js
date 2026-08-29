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
    lastSyncText: '', // 客户档案上次从企微同步的时间（''=未同步过）
    custOffset: 0,
    custHasMore: false,
    custLoading: false,
    syncing: false,
    // 手动添加直连客户（openid + 备注）表单：添加后即出现在统一名单里
    dAddOpen: false,
    dNewOpenid: '',
    dNewRemark: '',
    dAdding: false,
    // 统一名单一人一行：key = external_userid(企微客户) 或 openid(纯直连)，kind 决定提交时
    // 走哪个定向字段。同一人两边都有档案时只出企微行（openid 桥去重），操作员无需知道来源
    selected: [], // [{key, kind:'eu'|'oid', external_userid, openid, label, amountYuan, note}]
    selectedMap: {}, // key -> true（wxml 勾选态）
    fillAmount: '',
    fillNote: '',
    errIdx: -1, // 批量校验失败的行下标：行内高亮 + 滚动定位，不让运营自己翻着找
    batchResult: null, // {createdCount, errors:[], targets:[]}
    notifyText: '',
    notifying: false,
    notifyDone: false,
    notifyResult: null, // {lines:[], failCount} 群发任务派发结果（派给谁、几人失败）
    subMiniOn: false, // 订阅消息直达通知是否可用（后端已配置模板）
    miniNotifying: false,
    miniNotify: null, // {sent, lines:[], failedCount} 直达通知结果（几人直达、几人要走兜底及原因）
    miniDone: false, // 本批直达已跑完：按钮转为"重试失败"或禁用，防止手滑重发耗授权
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
    // batch 非空 = 批次视图；q = 关键词（备注/客户名/金额/单号）；month 与 days 互斥（按月对账用）
    recFilter: { status: 'all', days: 0, target: '', targetOpenid: '', targetLabel: '', batch: '', q: '', month: '' },
    recQ: '', // 关键词输入框的即时值（回车/点搜索才生效到 recFilter.q）
    recOffset: 0,
    recHasMore: false,
    recLoading: false,
    failAlert: 0, // 转账失败/被关闭（不含主动撤回）的笔数：记录 Tab 红点，对钱的异常不能靠"想起来去看"
    quotaPanel: null, // 充值/校准输入面板 {mode:'add'|'set', value}；null=收起
    quotaSaving: false,

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
    editingOpenid: '', // 非空 = 表单在编辑该员工（保存即覆盖），而不是新增
    staffMsg: '',
    staffLoading: false,
    staffListErr: false, // 员工列表加载失败提示（loadAdmins 不许静默失败）
  },

  onLoad(options) {
    // 带参直达（如操作端主页"异常警示"跳转 ?tab=records&status=failed）
    const o = options || {};
    if (o.tab === 'records') {
      this.setData({
        tab: 'records',
        recFilter: Object.assign({}, this.data.recFilter, { status: o.status || 'all' }),
      });
    }
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
          subMiniOn: !!me.subscribeTmplId, // 后端配置了订阅消息模板才显示"小程序直达通知"
        });
        if (me.isAdmin) {
          this.loadCustomers();
          this.loadRecords();
          this.loadPeriod();
          this.loadAlerts();
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
    if (t === 'records') { this.loadRecords(); this.loadPeriod(); this.loadAlerts(); }
    else if (t === 'rank') this.loadRank();
    else if (t === 'staff') this.loadAdmins();
    else if (this.data.step === 'pick') this.loadCustomers();
  },

  // 32 位十六进制随机串：批量发放/快发/充值的幂等键。同一意图（含失败后的重试）复用同一键，
  // 服务端据此保证绝不重复建单/重复记账
  _newKey() {
    let s = '';
    for (let i = 0; i < 32; i++) s += '0123456789abcdef'[(Math.random() * 16) | 0];
    return s;
  },

  // 'YYYY-MM-DD HH:MM:SS' → 当年省年份（'MM-DD HH:MM'）、跨年补年份（'YYYY-MM-DD HH:MM'），对账不产生歧义
  _fmtTime(s) {
    const full = String(s || '').replace('T', ' ');
    if (!full) return '';
    const nowYear = String(new Date().getFullYear());
    return full.slice(0, 4) === nowYear ? full.slice(5, 16) : full.slice(0, 16);
  },

  // 异常笔数：只统计「知悉水位」之后新出现的失败/关闭单（后端 /api/alerts 口径）。
  // 处理完点"标记已处理"即清零，之后的新失败重新提醒。静默失败：角标是提醒不是数据源
  loadAlerts() {
    call('/api/alerts', 'GET')
      .then((res) => {
        if (!res || res.error || typeof res.count !== 'number') return;
        this.setData({ failAlert: res.count });
      })
      .catch(() => {});
  },
  // 标记异常为已处理：记知悉水位 → 角标与主页警示清零；历史失败单在「失败/撤回」筛选里仍可查
  ackAlerts() {
    if (this._acking) return;
    wx.showModal({
      title: '标记为已处理',
      content: `将 ${this.data.failAlert} 笔异常标记为已处理：角标与主页警示清零，之后新出现的失败会重新提醒。历史失败单仍可在「失败/撤回」筛选里随时查看。`,
      confirmText: '标记',
      success: (r) => {
        if (!r.confirm) return;
        this._acking = true;
        call('/api/alerts/ack', 'POST', {})
          .then((res) => {
            this._acking = false;
            if (res && res.error) return wx.showToast({ title: res.error, icon: 'none' });
            this.setData({ failAlert: 0 });
            wx.showToast({ title: '已标记', icon: 'success' });
          })
          .catch(() => {
            this._acking = false;
            wx.showToast({ title: '网络错误', icon: 'none' });
          });
      },
    });
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
    this.setData({ custList: [], custLoaded: false, custError: false, custOffset: 0, custHasMore: false });
    this.loadCustomers();
  },
  // 统一选人名单（企微客户 + 直连客户一人一行，后端 openid 桥去重）。
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
    call(`/api/pick-customers?limit=${LIMIT}&offset=${offset}&q=${encodeURIComponent(q)}`, 'GET')
      .then((res) => {
        if (seq !== this._custSeq) return; // 条件已切换：旧响应作废
        if (!res || !res.list) return this.setData({ custLoading: false, custLoaded: true, custError: true });
        const page = res.list.map((c) => ({
          kind: c.kind, // eu=企微身份定向 | oid=openid 直连定向（拆企微后老档案自动转 oid）
          key: c.k,
          label: c.label,
          // 副行：企微行显示昵称（与备注不同才显），直连行显示 openid
          sub: c.kind === 'oid' ? c.sub : c.sub && c.sub !== c.label ? c.sub : '',
          active: !!c.active, // eu=开过小程序 | oid=领过奖励
          removable: !!c.removable, // 只有真在直连名单里的行可移除（转换来的企微档案行不可）
        }));
        this.setData({
          custList: isMore ? this.data.custList.concat(page) : page,
          custOffset: offset + page.length,
          custHasMore: res.hasMore || false,
          custLoaded: true,
          custLoading: false,
          lastSyncText: this._fmtTime(res.lastSyncAt), // 企微档案陈旧与否，运营一眼可判
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
    // uidStartAt：后端各员工同步的起始水位（清理已转走跟进关系用），partial 续传时原样带回
    const step = (startIndex, cursor, uidStartAt, acc) =>
      call('/api/customers/sync', 'POST', { startIndex, cursor, uidStartAt }).then((res) => {
        if (res && res.error) throw new Error(res.error);
        const total = acc + (res.synced || 0);
        if (res.partial) return step(res.nextIndex, res.nextCursor || '', res.uidStartAt || '', total);
        return total;
      });
    step(0, '', '', 0)
      .then((total) => {
        this.setData({ syncing: false });
        wx.showToast({ title: `已同步 ${total} 位客户`, icon: 'success' });
        this.loadCustomers();
      })
      .catch((e) => this.setData({ syncing: false, sendErr: '同步失败：' + (e.message || e.errMsg || '') }));
  },

  // ---- 直连客户手动管理（统一名单内的行级动作）----
  toggleDirectAdd() { this.setData({ dAddOpen: !this.data.dAddOpen, sendErr: '' }); },
  onDNewOpenid(e) { this.setData({ dNewOpenid: e.detail.value }); },
  onDNewRemark(e) { this.setData({ dNewRemark: e.detail.value }); },
  // 手动入池（同 openid 再保存 = 改备注）。openid 让客户打开小程序领取页复制发来；
  // 填错顶多"发出去没人能领"（过期自动回流），不会错发给别人——openid 查询条件即身份校验
  addDirect() {
    if (this.data.dAdding) return;
    const openid = (this.data.dNewOpenid || '').trim();
    const remark = (this.data.dNewRemark || '').trim();
    if (!openid) return this.setData({ sendErr: '请填写客户的 openid（客户打开小程序领取页可复制）' });
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(openid)) return this.setData({ sendErr: 'openid 格式不对：应为 6-64 位字母/数字/-_' });
    this.setData({ dAdding: true, sendErr: '' });
    call('/api/direct-customers', 'POST', { openid, remark })
      .then((res) => {
        this.setData({ dAdding: false });
        if (res && res.error) return this.setData({ sendErr: res.error });
        this.setData({ dNewOpenid: '', dNewRemark: '', dAddOpen: false });
        wx.showToast({ title: '已保存', icon: 'success' });
        this.searchCustomers(); // 重查统一名单：新加的人立即可见可选
      })
      .catch((e) => this.setData({ dAdding: false, sendErr: '保存失败：' + (e.errMsg || e.message || '') }));
  },
  // 移出名单：只删名单不动历史台账；若已勾选一并取消，防止对着刚移除的人发放
  removeDirect(e) {
    const { oid, label } = e.currentTarget.dataset;
    if (!oid) return;
    wx.showModal({
      title: '移除客户',
      content: `将「${label}」移出直连客户名单。历史发放记录不受影响；客户再次领取会自动回到名单。`,
      confirmText: '移除',
      confirmColor: '#d92b3c',
      success: (r) => {
        if (!r.confirm) return;
        call('/api/direct-customers/remove', 'POST', { openid: oid })
          .then((res) => {
            if (res && res.error) return wx.showToast({ title: res.error, icon: 'none' });
            const selected = this.data.selected.filter((s) => s.key !== oid);
            const map = Object.assign({}, this.data.selectedMap);
            delete map[oid];
            const nextList = this.data.custList.filter((c) => c.key !== oid);
            this.setData({
              custList: nextList,
              // 删一行 = 库里结果集整体前移一位：分页游标同步回退，否则下一页会跳过一位客户
              custOffset: Math.max(this.data.custOffset - (this.data.custList.length - nextList.length), 0),
              selected,
              selectedMap: map,
            });
            wx.showToast({ title: '已移除', icon: 'success' });
          })
          .catch(() => wx.showToast({ title: '网络错误，请重试', icon: 'none' }));
      },
    });
  },

  toggleCust(e) {
    // 双来源统一勾选：key = external_userid(企微行) 或 openid(直连行)，kind 由行上带下来
    const { key, kind, label } = e.currentTarget.dataset;
    const selected = this.data.selected.slice();
    const map = Object.assign({}, this.data.selectedMap);
    const idx = selected.findIndex((s) => s.key === key);
    if (idx >= 0) {
      selected.splice(idx, 1);
      delete map[key];
    } else {
      selected.push({
        key,
        kind, // 提交时 eu 走 externalUserid、oid 走 openid，各走各的定向字段绝不混填
        external_userid: kind === 'eu' ? key : '',
        openid: kind === 'oid' ? key : '',
        label,
        amountYuan: '',
        note: '',
      });
      map[key] = true;
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
    delete map[selected[i].key];
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
      confirmColor: '#1c4f62', // v5 藏青主色（系统弹窗吃不到 CSS token，只能写值）
      success: (r) => { if (r.confirm) this._doSubmitBatch(); },
    });
  },
  _doSubmitBatch() {
    const { selected } = this.data;
    // 幂等键：本次发放意图首次提交时生成，失败重试复用——服务端命中已建批次会回放原结果而不是再建一批
    if (!this._batchKey) this._batchKey = this._newKey();
    this.setData({ sendErr: '', loading: true });
    // 双身份：企微客户带 externalUserid、直连客户带 openid，后端二选一校验（两个都带会被拒）
    const items = selected.map((s) =>
      s.kind === 'oid'
        ? { openid: s.openid, amountYuan: Number(s.amountYuan), remark: s.note || '' }
        : { externalUserid: s.external_userid, amountYuan: Number(s.amountYuan), remark: s.note || '' }
    );
    call('/api/rewards/batch', 'POST', { items, clientKey: this._batchKey })
      .then((res) => {
        this.setData({ loading: false });
        if (res && res.error) return this.setData({ sendErr: res.error });
        this._batchKey = null; // 本批已确认落地，下一批换新键
        this._notifyKey = null; // 新批结果 = 新的群发意图：绝不复用上一批的群发防重键（会命中旧缓存导致本批不建任务）
        this._notifySeq = (this._notifySeq || 0) + 1; // 群发代际+1：上一批仍在飞行的群发回调作废
        // 拆单后同一客户出现多笔 → 通知名单去重，每人只发一张卡片；企微/直连分列（各走各的通知通道）
        const created = res.created || [];
        const targets = [...new Set(created.filter((c) => c.externalUserid).map((c) => c.externalUserid))];
        const targetOpenids = [...new Set(created.filter((c) => c.openid).map((c) => c.openid))];
        const labelOf = {};
        selected.forEach((s) => (labelOf[s.key] = s.label)); // key 对企微是 eu、对直连是 openid，errors[].target 两种都能对上
        this.setData({
          step: 'result',
          batchResult: {
            createdCount: res.createdCount, // 拆单后的总笔数
            peopleCount: res.peopleCount || targets.length + targetOpenids.length,
            batchId: res.batchId || '', // 批次号：结果页可直达"本批台账"
            duplicate: !!res.duplicate, // 重试命中已建批次：展示原结果，未重复创建
            errors: (res.errors || []).map((er) => ({ ...er, label: labelOf[er.target] || er.target || '' })),
            targets,
            targetOpenids,
          },
          notifyText: '你有一笔奖励待领取，打开【梨响ROC】小程序即可领取～',
          notifyDone: false,
        });
        this.loadRecords();
      })
      .catch((e) =>
        this.setData({
          loading: false,
          sendErr: '网络错误：' + (e.errMsg || e.message || '') + '（可放心重试，同一批不会重复创建）',
        })
      );
  },

  // 小程序直达通知：后端直接给客户微信推「服务通知」（订阅消息），点开直达领取页，
  // 员工零操作。只覆盖开过小程序且点过「允许提醒」的客户；其余按原因列出，走企微/转发兜底。
  // 大批量：后端 8s 期限内发不完会返回 remaining，这里自动续传直到发完；
  // 每一步带幂等键，网络错误重点按钮续传同一步（服务端回放，绝不给同一客户发第二条）；
  // 跑完后按钮只剩"重试失败名单"，防手滑重发白耗客户授权
  sendMiniNotify() {
    const r = this.data.batchResult;
    const allEus = (r && r.targets) || [];
    const allOids = (r && r.targetOpenids) || []; // 直连客户：openid 即身份，同一接口同一防重键一起发
    if ((!allEus.length && !allOids.length) || this.data.miniNotifying) return;
    // 目标名单：网络中断的续传名单 > 已完成后的失败重试名单 > 整批（企微/直连两组并行分列）
    let targets = { eus: allEus, oids: allOids };
    let acc = { sent: 0, noQuota: [], noOpenid: [], noPending: [], failed: [] };
    const rem = this._miniRemaining;
    if (rem && (rem.eus.length || rem.oids.length)) {
      targets = rem;
      acc = this._miniAcc || acc;
    } else if (this.data.miniDone) {
      const retry = this._miniFailedList || { eus: [], oids: [] };
      if (!retry.eus.length && !retry.oids.length) return; // 全部处理完且无失败：按钮本应禁用
      targets = retry; // 重试失败名单：结果按本次重试重算
    }
    const seq = (this._notifySeq = this._notifySeq || 0); // 与群发共用代际：换批后旧回调作废
    this.setData({ miniNotifying: true, sendErr: '' });
    const labelOf = {};
    this.data.selected.forEach((s) => (labelOf[s.key] = s.label)); // key 双身份通吃：结果名单两种 id 都能对回备注名
    const nm = (l) => (l || []).map((id) => labelOf[id] || id).join('、');
    const step = (list) => {
      if (!this._miniKey) this._miniKey = this._newKey(); // 每步一键；同步重试复用同键=服务端回放
      call('/api/notify-mini', 'POST', { externalUserids: list.eus, openids: list.oids, clientKey: this._miniKey })
        .then((res) => {
          if ((this._notifySeq || 0) !== seq) return;
          if (res && res.error) return this.setData({ miniNotifying: false, sendErr: res.error });
          this._miniKey = null; // 本步已 settle：下一步换新键
          acc.sent += res.sent || 0;
          acc.noQuota.push(...(res.noQuota || []));
          acc.noOpenid.push(...(res.noOpenid || []));
          acc.noPending.push(...(res.noPending || []));
          acc.failed.push(...(res.failed || []));
          const nextEus = res.remaining || [];
          const nextOids = res.remainingOpenids || [];
          if (res.partial && (nextEus.length || nextOids.length)) {
            this._miniAcc = acc;
            this._miniRemaining = { eus: nextEus, oids: nextOids };
            return step(this._miniRemaining); // 自动续传下一片
          }
          this._miniAcc = null;
          this._miniRemaining = null;
          // 失败名单按身份分列存：重试时各回各的请求字段
          this._miniFailedList = {
            eus: acc.failed.filter((f) => f.eu).map((f) => f.eu),
            oids: acc.failed.filter((f) => f.openid).map((f) => f.openid),
          };
          const lines = [`已直达 ${acc.sent} 人（微信服务通知，点开即到领取页）`];
          if (acc.noQuota.length) lines.push(`未订阅提醒 ${acc.noQuota.length} 人：${nm(acc.noQuota)}——请用${allEus.length ? '企微群发或' : ''}转发补发`);
          if (acc.noOpenid.length) lines.push(`没开过小程序 ${acc.noOpenid.length} 人：${nm(acc.noOpenid)}——首次需企微群发或转发引导打开`);
          if (acc.noPending.length) lines.push(`已无待领 ${acc.noPending.length} 人（已领完/已撤回），未打扰`);
          if (acc.failed.length) lines.push(`发送失败 ${acc.failed.length} 人（授权已退回，可重试）：${acc.failed.map((f) => (labelOf[f.eu || f.openid] || f.eu || f.openid) + '（' + f.error + '）').join('；')}`);
          this.setData({ miniNotifying: false, miniDone: true, miniNotify: { sent: acc.sent, lines, failedCount: acc.failed.length } });
          wx.showModal({ title: '直达通知结果', content: lines.join('\n'), showCancel: false });
        })
        .catch((e) => {
          if ((this._notifySeq || 0) !== seq) return;
          // 网络错误：保留本步幂等键与续传名单，重点按钮从这一步继续（服务端按键回放不重发）
          this._miniAcc = acc;
          this._miniRemaining = list;
          this.setData({ miniNotifying: false, sendErr: '直达通知网络错误：' + (e.errMsg || e.message || '') + '（可放心重试，已发送的不会重复）' });
        });
    };
    step(targets);
  },

  onNotifyText(e) { this.setData({ notifyText: e.detail.value }); },
  sendNotify() {
    const r = this.data.batchResult;
    if (!r || !r.targets.length || this.data.notifying) return;
    // 已创建过且有失败名单：本次只重发失败的那批，成功的客户不收第二条
    const prevFail = (this.data.notifyDone && this.data.notifyResult && this.data.notifyResult.failList) || [];
    const targets = prevFail.length ? prevFail : r.targets;
    // 幂等键：多组派发偶尔超 15s 超时，重点一次时服务端直接回放已建任务（客户不收第二条）；
    // 拿到响应后清键，下次点击（重发失败名单）是新意图
    if (!this._notifyKey) this._notifyKey = this._newKey();
    // 代际守卫：回调回来时若批次已切换（点了"再发一批"/新批已创建），整体作废——
    // 否则旧回调会把 notifyDone/notifyResult/清键动作砸在新批次的状态上
    const seq = (this._notifySeq = this._notifySeq || 0);
    this.setData({ notifying: true, sendErr: '' });
    call('/api/deliver', 'POST', { externalUserids: targets, text: this.data.notifyText, clientKey: this._notifyKey })
      .then((res) => {
        if ((this._notifySeq || 0) !== seq) return; // 批次已换代：丢弃过期回调
        this.setData({ notifying: false });
        if (res && res.error) return this.setData({ sendErr: res.error });
        this._notifyKey = null;
        // 任务按客户跟进人分组派发（企微规则：谁跟进谁发）。把"派给了谁"讲清楚，
        // 不然任务落在别的员工那里，发起人以为群发没生效
        const lines = [];
        (res.tasks || []).forEach((t) => {
          const okCount = t.count - (t.failCount || 0);
          const who = t.senderSelf ? '你' : t.sender ? '员工 ' + t.sender : '按企微默认跟进人（可能派给最近聊天的员工，请留意）';
          lines.push(who + '：' + okCount + ' 位客户' + (t.failCount ? '（' + t.failCount + ' 位未能创建）' : ''));
        });
        (res.errors || []).forEach((er) => {
          lines.push(
            (er.sender ? '员工 ' + er.sender : '默认组') + '：创建失败——' + er.error +
            (er.indeterminate ? '（提交结果未知，可能已创建：请先到企微「客户联系」确认，确认没有再用转发补发）' : '')
          );
        });
        this.setData({
          notifyDone: true,
          notifyResult: { lines, failCount: res.failCount || 0, failList: res.failList || [] },
        });
        wx.showModal({
          title: '群发任务已创建',
          content:
            (lines.length ? lines.join('\n') + '\n\n' : '') +
            '任务派给了对应跟进员工：请让他们留意企微「消息-客户联系」的提醒（或打开 工作台-群发助手），点一次【发送】即可送达客户。',
          showCancel: false,
        });
      })
      .catch((e) => {
        if ((this._notifySeq || 0) !== seq) return; // 批次已换代：丢弃过期回调
        this.setData({ notifying: false, sendErr: '通知失败：' + (e.errMsg || e.message || '') + '（可放心重试，已创建的任务不会重复）' });
      });
  },

  newBatch() {
    this._batchKey = null; // 新一批 = 新意图，换新幂等键
    this._notifyKey = null; // 弃掉未完成的群发重试意图，防止新批复用旧键命中旧缓存
    this._notifySeq = (this._notifySeq || 0) + 1; // 群发代际+1：飞行中的旧群发回调对新批作废
    // notifying/miniNotify 一并复位：被弃批次的请求即使还在飞行，也不该锁住新批的按钮
    this._miniKey = null;
    this._miniAcc = null;
    this._miniRemaining = null;
    this._miniFailedList = null;
    this.setData({ step: 'pick', selected: [], selectedMap: {}, batchResult: null, sendErr: '', errIdx: -1, notifying: false, notifyDone: false, notifyResult: null, miniNotifying: false, miniNotify: null, miniDone: false });
  },

  // ============ 链接快发（副） ============
  // 输入一变即换新幂等键：改过金额/备注再提交是新意图，不该命中旧单
  onAmount(e) { this._quickKey = null; this.setData({ amountYuan: e.detail.value }); },
  onRemark(e) { this._quickKey = null; this.setData({ remark: e.detail.value }); },
  onName(e) { this._quickKey = null; this.setData({ name: e.detail.value }); },
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
    // 幂等键：重试复用同一键，服务端派生同一单号，不会产生"界面拿不到 token 的孤儿单"白占额度
    if (!this._quickKey) this._quickKey = this._newKey();
    this.setData({ loading: true, error: '', reward: null });
    call('/api/rewards', 'POST', { amountYuan: yuan, remark: this.data.remark, name: this.data.name, clientKey: this._quickKey })
      .then((res) => {
        this.setData({ loading: false });
        if (res && res.error) return this.setData({ error: res.error });
        this._quickKey = null; // 已成功拿到 token，下一单换新键
        this.setData({ reward: res });
        this.loadRecords();
      })
      .catch((e) => this.setData({ loading: false, error: '网络错误：' + (e.errMsg || e.message || '') + '（可放心重试，不会重复生成）' }));
  },

  onShareAppMessage() {
    const r = this.data.reward;
    if (this.data.sendMode === 'quick' && r && r.token) {
      return {
        title: `请领取 ¥${r.amountYuan} 奖励`,
        path: `/pages/claim/claim?token=${encodeURIComponent(r.token)}&amt=${r.amountYuan}&remark=${encodeURIComponent(r.remark || '')}`,
      };
    }
    // 定向发放：分享领取入口即可（客户按身份识别，无需令牌）。标题带品牌名增强信任
    return { title: '梨响 ROC · 你的奖励到啦，点开领取', path: '/pages/claim/claim' };
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
  // 充值（累加，携带上期结余）/ 校准（把剩余设为账户实际余额）。
  // 用页面内自绘输入面板而不是 wx.showModal editable：桌面端（Windows/Mac）小程序
  // 不支持 editable，弹窗里根本不显示输入框——"电脑上点充值看不到输入框"的根因
  openQuotaPanel(e) {
    const mode = e.currentTarget.dataset.mode === 'set' ? 'set' : 'add';
    this.setData({ quotaPanel: { mode, value: '' } });
  },
  onQuotaInput(e) { this.setData({ 'quotaPanel.value': e.detail.value }); },
  cancelQuotaPanel() { this.setData({ quotaPanel: null }); },
  confirmQuotaPanel() {
    if (!this.data.quotaPanel || this.data.quotaSaving) return;
    const { mode, value } = this.data.quotaPanel;
    const isSet = mode === 'set';
    const raw = String(value || '').trim(); // 空/纯空格不能当 0 静默提交
    if (raw === '') return wx.showToast({ title: '请输入金额', icon: 'none' });
    const yuan = Number(raw);
    if (Number.isNaN(yuan) || yuan < 0 || (!isSet && yuan <= 0)) {
      return wx.showToast({ title: '请输入正确金额', icon: 'none' });
    }
    this.setData({ quotaSaving: true });
    // opKey：这次确认的幂等键。响应丢失后的重复提交只会记一次账
    call('/api/period/adjust', 'POST', { mode, yuan, opKey: this._newKey() })
      .then((res) => {
        this.setData({ quotaSaving: false });
        if (res && res.error) return wx.showToast({ title: res.error, icon: 'none' });
        this.setData({ quotaPanel: null });
        wx.showToast({ title: isSet ? '已校准' : '已充值', icon: 'success' });
        this.applyPeriod(res);
      })
      .catch(() => {
        this.setData({ quotaSaving: false });
        wx.showToast({ title: '网络错误，请刷新核对剩余后再试', icon: 'none' });
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
      `/api/rewards?limit=${LIMIT}&offset=${offset}&status=${f.status}&days=${f.days}&target=${encodeURIComponent(f.target)}` +
        `&targetOpenid=${encodeURIComponent(f.targetOpenid || '')}` +
        `&batch=${encodeURIComponent(f.batch || '')}&q=${encodeURIComponent(f.q || '')}&month=${encodeURIComponent(f.month || '')}`,
      'GET'
    )
      .then((res) => {
        if (seq !== this._recSeq) return; // 筛选已切换：旧响应作废
        if (!res || !res.list) return this.setData({ recLoading: false, recLoaded: true, recError: true });
        const map = { SUCCESS: '已到账', WAIT_USER_CONFIRM: '待确认', FAIL: '失败', CLOSED: '已关闭', CANCELLED: '已撤回', CANCELING: '撤销中', CREATED: '待领取', CLAIMED: '待确认' };
        const records = res.list.map((r) => {
          const st = r.transfer_state || r.status || 'CREATED';
          // 过期未领（后端按 expires_at 判定）：链接已不可领、钱没动过、额度已回流——
          // 灰标"已过期"，和还能领的"待领取"分开，免得看着像钱悬在外面
          const expired = st === 'CREATED' && !!r.is_expired;
          const by = r.created_by_name || '';
          const full = (r.created_at || '').replace('T', ' ');
          return {
            rid: r.rid,
            yuan: (r.amount_fen / 100).toFixed(2),
            // 副行：备注 + 谁发的（多发放员团队对账/追责要看这个）
            sub: (r.remark || '客户奖励') + (by ? ' · ' + by + ' 发放' : ''),
            // 定向对象：企微客户显备注/名字；直连客户显名单备注 > 借企微备注（openid 桥）> openid 尾号
            who:
              r.target_remark || r.target_name ||
              (r.target_external_userid
                ? '定向客户'
                : r.target_openid
                  ? r.target_direct_remark || r.target_bridge_remark || '客户' + String(r.target_openid).slice(-4)
                  : ''),
            eu: r.target_external_userid || '',
            oid: r.target_openid || '',
            statusText: expired ? '已过期' : map[st] || st,
            cls: expired
              ? 'muted'
              : st === 'SUCCESS'
                ? 'ok'
                : st === 'FAIL' || st === 'CLOSED' || st === 'CANCELLED' || st === 'CANCELING'
                ? 'fail'
                : 'warn',
            // 只有还没到账的能撤：未领取直接作废；已领待确认向微信撤销资金回流
            canRevoke: r.status === 'CREATED' || r.status === 'CLAIMED',
            createdAt: this._fmtTime(full), // 当年省年份、跨年补年份
            createdFull: full, // 详情层用完整时间
            updatedFull: (r.transfer_updated_at || '').replace('T', ' '), // 转账状态最后更新时间
            billNo: r.transfer_bill_no || '', // 微信转账单号：与商户平台逐笔勾稽的凭据
            batchId: r.batch_id || '', // 批次号：非空说明来自一次批量发放，可整批查看/撤回
            // 微信侧失败原因：只在当前确为失败/关闭时展示——乱序回调把 FAIL 纠正为 SUCCESS 后
            // 库里可能残留旧原因（后端 SUCCESS 写入已清，此处再兜一层），不给到账单贴失败标签
            failReason: st === 'FAIL' || st === 'CLOSED' ? r.fail_reason || '' : '',
            revokedAt: (r.revoked_at || '').replace('T', ' '), // 撤回审计：谁在什么时候撤的
            revokedBy: r.revoked_by_name || (r.revoked_by ? '（已移除的员工）' : ''),
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
    if (k === 'days') { f.days = Number(v) || 0; f.month = ''; } // 天数窗与月份互斥
    else f.status = v;
    this.setData({ recFilter: f });
    this._resetRecords();
    this.loadRecords();
  },
  // ---- 台账关键词搜索（备注/客户名/金额/单号）与月份筛选（按月对账） ----
  onRecQ(e) { this.setData({ recQ: e.detail.value }); },
  searchRecords() {
    const q = (this.data.recQ || '').trim();
    this.setData({ recFilter: Object.assign({}, this.data.recFilter, { q }) });
    this._resetRecords();
    this.loadRecords();
  },
  clearRecQ() {
    this.setData({ recQ: '', recFilter: Object.assign({}, this.data.recFilter, { q: '' }) });
    this._resetRecords();
    this.loadRecords();
  },
  pickRecMonth(e) {
    this.setData({ recFilter: Object.assign({}, this.data.recFilter, { month: e.detail.value || '', days: 0 }) });
    this._resetRecords();
    this.loadRecords();
  },
  clearRecMonth() {
    this.setData({ recFilter: Object.assign({}, this.data.recFilter, { month: '' }) });
    this._resetRecords();
    this.loadRecords();
  },
  // 点记录里的客户名 → 只看这个人的资金往来（stats 同步变成单人汇总）。
  // 企微客户按 external_userid 筛、直连客户按 openid 筛，二者互斥（一次只看一个人）
  filterByCustomer(e) {
    const { eu, oid, label } = e.currentTarget.dataset;
    if (!eu && !oid) return;
    const patch = eu
      ? { target: eu, targetOpenid: '', targetLabel: label || '该客户' }
      : { target: '', targetOpenid: oid, targetLabel: label || '该客户' };
    this.setData({ recFilter: Object.assign({}, this.data.recFilter, patch) });
    this._resetRecords();
    this.loadRecords();
  },
  clearCustomerFilter() {
    this.setData({ recFilter: Object.assign({}, this.data.recFilter, { target: '', targetOpenid: '', targetLabel: '' }) });
    this._resetRecords();
    this.loadRecords();
  },
  // ---- 批次视图：一次批量发放的 N 笔按批聚合回看（汇总同口径），并支持整批撤回 ----
  filterByBatch(e) {
    const batch = e.currentTarget.dataset.batch;
    if (batch) this._enterBatchView(batch);
  },
  viewBatchLedger() {
    const r = this.data.batchResult;
    if (r && r.batchId) this._enterBatchView(r.batchId);
  },
  _enterBatchView(batch) {
    // 进批次视图时清掉时间/单人/关键词筛选：这一批可能跨越筛选窗边界，混着筛会看不全
    this.setData({
      tab: 'records',
      recQ: '',
      recFilter: { status: 'all', days: 0, target: '', targetOpenid: '', targetLabel: '', batch, q: '', month: '' },
    });
    this._resetRecords();
    this.loadRecords();
    this.loadPeriod();
  },
  clearBatchFilter() {
    this.setData({ recFilter: Object.assign({}, this.data.recFilter, { batch: '' }) });
    this._resetRecords();
    this.loadRecords();
  },
  // 整批撤回未到账：发错一批不用 30 次逐条点。已到账的不动，未领取作废、待确认向微信撤销
  revokeBatch() {
    const batch = this.data.recFilter.batch;
    if (!batch || this._batchRevoking) return;
    const s = this.data.stats;
    // 只有"全部"筛选下 stats 才是整批口径，其他筛选下不引用具体数字，避免说错
    const exact = this.data.recFilter.status === 'all' && s;
    const content = exact
      ? `将撤回本批 ${s.pending_count} 笔未到账：未领取直接作废；已领待确认向微信撤销，资金退回商户余额。` +
        (s.success_count ? `\n已到账 ${s.success_count} 笔不受影响。` : '')
      : '将撤回本批所有未到账：未领取直接作废；已领待确认向微信撤销，资金退回商户余额。已到账的不受影响。';
    wx.showModal({
      title: '撤回本批未到账',
      content,
      confirmText: '全部撤回',
      confirmColor: '#d92b3c',
      success: (r) => {
        if (!r.confirm) return;
        this._batchRevoking = true;
        wx.showLoading({ title: '撤回中…', mask: true });
        call('/api/rewards/batch/revoke', 'POST', { batchId: batch })
          .then((res) => {
            this._batchRevoking = false;
            wx.hideLoading();
            if (res && res.error) return wx.showToast({ title: res.error, icon: 'none' });
            const parts = [];
            if (res.revoked) parts.push(`作废未领取 ${res.revoked} 笔`);
            if (res.canceled) parts.push(`撤销待确认转账 ${res.canceled} 笔`);
            if (res.skipped) parts.push(`跳过 ${res.skipped} 笔（已到账/已终结）`);
            if ((res.errors || []).length) parts.push(`失败 ${res.errors.length} 笔，可再点一次重试`);
            wx.showModal({ title: '本批撤回完成', content: parts.join('\n') || '本批没有可撤回的笔', showCancel: false });
            this._resetRecords();
            this.loadRecords();
            this.loadPeriod();
          })
          .catch(() => {
            this._batchRevoking = false;
            wx.hideLoading();
            wx.showToast({ title: '网络错误', icon: 'none' });
          });
      },
    });
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
      r.updatedFull && r.updatedFull !== r.createdFull ? `状态更新：${r.updatedFull}` : '',
      r.failReason ? `失败原因：${r.failReason}` : '',
      r.revokedAt ? `撤回：${r.revokedAt}${r.revokedBy ? ' · ' + r.revokedBy : ''}` : '',
      `商户单号：${r.rid}`,
      `微信单号：${r.billNo || '—（转账发起后生成）'}`,
      r.batchId ? `批次号：${r.batchId}` : '',
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
      confirmColor: '#d92b3c',
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
            enabled: a.enabled !== false, // 停用的员工保留在列表里（可恢复），只是失去权限
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
        const wasEdit = !!this.data.editingOpenid;
        this.setData({ newOpenid: '', newName: '', newRole: 'operator', newWecomUserid: '', editingOpenid: '', staffMsg: '' });
        wx.showToast({ title: wasEdit ? '已保存' : '已添加', icon: 'success' });
        this.loadAdmins();
      })
      .catch((e) => this.setData({ staffLoading: false, staffMsg: '网络错误：' + (e.errMsg || e.message || '') }));
  },
  // 就地编辑：把该员工资料填回表单，保存即覆盖（改名/改企微账号/改角色不再需要删了重加）
  editStaff(e) {
    const openid = e.currentTarget.dataset.openid;
    const a = this.data.admins.find((x) => x.openid === openid);
    if (!a) return;
    this.setData({
      editingOpenid: openid,
      newOpenid: openid,
      newName: a.name === '（未命名）' ? '' : a.name,
      newRole: a.isSuper ? 'super' : 'operator',
      newWecomUserid: a.wecomUserid || '',
      staffMsg: '',
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  cancelEditStaff() {
    this.setData({ editingOpenid: '', newOpenid: '', newName: '', newRole: 'operator', newWecomUserid: '', staffMsg: '' });
  },
  // 停用/启用：停用立即失权但保留资料与企微映射，可随时恢复；最后一个超管后端会拦
  toggleStaffEnabled(e) {
    const { openid, enabled } = e.currentTarget.dataset; // enabled = 当前状态
    const next = !enabled;
    const doIt = () =>
      call('/api/admins/enable', 'POST', { openid, enabled: next })
        .then((res) => {
          if (res && res.error) return wx.showToast({ title: res.error, icon: 'none' });
          wx.showToast({ title: next ? '已启用' : '已停用', icon: 'success' });
          this.loadAdmins();
        })
        .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }));
    if (next) return doIt();
    wx.showModal({
      title: '停用员工',
      content: '停用后立即失去发放权限；资料与企微配置保留，可随时重新启用。',
      confirmText: '停用',
      confirmColor: '#d92b3c',
      success: (r) => { if (r.confirm) doIt(); },
    });
  },
  removeStaff(e) {
    const openid = e.currentTarget.dataset.openid;
    wx.showModal({
      title: '移除员工',
      content: '确定移除该员工的发放权限？',
      confirmColor: '#d92b3c', // 与撤回等危险操作同用 --danger（v5 语义色 #d92b3c），不许第二种红散落
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
