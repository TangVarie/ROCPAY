const { call } = require('../../api.js');

Page({
  data: {
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
    syncing: false,
    selected: [], // [{external_userid, label, amountYuan, note}]
    selectedMap: {}, // eu -> true（wxml 勾选态）
    fillAmount: '',
    fillNote: '',
    batchResult: null, // {createdCount, errors:[], targets:[]}
    notifyText: '',
    notifying: false,
    notifyDone: false,
    sendErr: '',

    // ---- 发放 · 链接快发（副）----
    amountYuan: '',
    remark: '',
    name: '',
    reward: null,
    loading: false,
    error: '',

    // ---- 记录 ----
    records: [],
    stats: null,
    balance: null, // { availableYuan, pendingYuan, hasPending }
    balanceErr: '',
    balanceLoading: false,
    period: null, // 可发额度（运行式余额）{ hasQuota, remainingYuan, paidSinceYuan, low }

    // ---- 员工 ----
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
          wecomOn: !!me.wecom,
          roleLabel: me.role === 'super' ? '超级管理员' : me.role === 'operator' ? '发放员' : '',
          minAmountYuan: me.minAmountYuan || 0.1,
          maxAmountYuan: me.maxAmountYuan || 5000,
        });
        if (me.isAdmin) {
          this.loadCustomers();
          this.loadRecords();
          this.loadBalance();
          this.loadPeriod();
        }
        if (isSuper) this.loadAdmins();
      })
      .catch((e) => this.setData({ error: '无法连接后端：' + (e.errMsg || e.message || '') }));
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
    if (tab === 'records') { this.loadRecords(); this.loadBalance(); this.loadPeriod(); }
    if (tab === 'staff') this.loadAdmins();
  },
  switchSendMode(e) {
    this.setData({ sendMode: e.currentTarget.dataset.m, sendErr: '', error: '' });
  },

  // ============ 定向批量 ============
  onCustQ(e) { this.setData({ custQ: e.detail.value }); },
  searchCustomers() { this.loadCustomers(); },
  loadCustomers() {
    const q = (this.data.custQ || '').trim();
    call('/api/customers?limit=100&q=' + encodeURIComponent(q), 'GET')
      .then((res) => {
        if (res && res.list) {
          const list = res.list.map((c) => ({
            external_userid: c.external_userid,
            label: c.remark || c.name || c.external_userid,
            sub: c.remark && c.name && c.remark !== c.name ? c.name : '',
            opened: !!c.opened,
          }));
          this.setData({ custList: list, custLoaded: true });
        }
      })
      .catch(() => this.setData({ custLoaded: true }));
  },

  syncCustomers() {
    if (this.data.syncing) return;
    this.setData({ syncing: true, sendErr: '' });
    call('/api/customers/sync', 'POST', {})
      .then((res) => {
        this.setData({ syncing: false });
        if (res && res.error) return this.setData({ sendErr: res.error });
        wx.showToast({ title: `已同步 ${res.synced} 位客户`, icon: 'success' });
        this.loadCustomers();
      })
      .catch((e) => this.setData({ syncing: false, sendErr: '同步失败：' + (e.errMsg || e.message || '') }));
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
    this.setData({ step: 'fill', sendErr: '' });
  },
  backPick() { this.setData({ step: 'pick', sendErr: '' }); },

  onRowAmount(e) {
    const i = e.currentTarget.dataset.i;
    this.setData({ [`selected[${i}].amountYuan`]: e.detail.value });
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
    this.setData({ selected, selectedMap: map, step: selected.length ? 'fill' : 'pick' });
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

  submitBatch() {
    if (this.data.loading) return; // 防连点：重复提交会生成重复奖励（重复打款）
    const { selected, minAmountYuan, maxAmountYuan } = this.data;
    for (let i = 0; i < selected.length; i++) {
      const yuan = Number(selected[i].amountYuan);
      if (!(yuan > 0)) return this.setData({ sendErr: `「${selected[i].label}」还没填金额` });
      if (yuan < minAmountYuan) return this.setData({ sendErr: `「${selected[i].label}」金额不能小于 ${minAmountYuan} 元` });
      if (yuan > maxAmountYuan) return this.setData({ sendErr: `「${selected[i].label}」金额不能大于 ${maxAmountYuan} 元` });
    }
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
        const targets = (res.created || []).map((c) => c.externalUserid);
        const labelOf = {};
        selected.forEach((s) => (labelOf[s.external_userid] = s.label));
        this.setData({
          step: 'result',
          batchResult: {
            createdCount: res.createdCount,
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
        this.setData({ notifyDone: true });
        wx.showModal({
          title: '通知已创建',
          content: '请相关员工打开企业微信「客户联系 → 群发助手」，点一次【发送】即可送达客户。',
          showCancel: false,
        });
      })
      .catch((e) => this.setData({ notifying: false, sendErr: '通知失败：' + (e.errMsg || e.message || '') }));
  },

  newBatch() {
    this.setData({ step: 'pick', selected: [], selectedMap: {}, batchResult: null, sendErr: '', notifyDone: false });
  },

  // ============ 链接快发（副） ============
  onAmount(e) { this.setData({ amountYuan: e.detail.value }); },
  onRemark(e) { this.setData({ remark: e.detail.value }); },
  onName(e) { this.setData({ name: e.detail.value }); },
  onGenerate() {
    if (this.data.loading) return; // 防连点
    const yuan = Number(this.data.amountYuan);
    if (!(yuan > 0)) return this.setData({ error: '请输入正确金额' });
    if (yuan < this.data.minAmountYuan)
      return this.setData({ error: `金额不能小于 ${this.data.minAmountYuan} 元` });
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
  loadBalance() {
    if (this.data.balanceLoading) return;
    this.setData({ balanceLoading: true });
    call('/api/balance', 'GET')
      .then((res) => {
        this.setData({ balanceLoading: false });
        if (!res || res.error || typeof res.availableYuan !== 'number') {
          return this.setData({ balance: null, balanceErr: (res && res.error) || '暂时取不到余额' });
        }
        const pending = Number(res.pendingYuan) || 0;
        this.setData({
          balance: {
            availableYuan: (Number(res.availableYuan) || 0).toFixed(2),
            pendingYuan: pending.toFixed(2),
            hasPending: pending > 0,
          },
          balanceErr: '',
        });
      })
      .catch((e) =>
        this.setData({ balanceLoading: false, balanceErr: '余额获取失败：' + (e.errMsg || e.message || '') })
      );
  },

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
              who: r.target_remark || r.target_name || (r.target_external_userid ? '定向客户' : ''),
              statusText: map[st] || st,
              cls: st === 'SUCCESS' ? 'ok' : st === 'FAIL' || st === 'CLOSED' ? 'fail' : 'warn',
              createdAt: (r.created_at || '').replace('T', ' ').slice(5, 16),
            };
          });
          this.setData({
            records,
            stats: res.stats || null,
            statsTotalYuan: res.stats ? (res.stats.total_fen / 100).toFixed(2) : '0.00',
          });
        }
      })
      .catch(() => {});
  },

  // ============ 员工 ============
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
