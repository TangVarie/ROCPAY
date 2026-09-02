// 开屏组件。亮不亮挂在冷启动上——App.onLaunch 置位，组件 attached 时取走；
// 顺序：onLaunch → onShow → 页面 onLoad → 组件 attached，冷启动时 attached 一定能取到；热启动不重跑 onLaunch，取不到，不亮。
//
// 停多久：开屏是接收层的仪式，不是加载态，先保证看得清（SHOW_MIN）；
// 然后看页面数据到了没（属性 ready，由页面绑定自己的加载状态）——没到就继续停并亮出「正在加载…」，
// 到了再淡出。这样用户只经历一屏：不会开屏刚走、页面自己的加载态又来一遍。
// SHOW_MAX 兜底：网络再慢也不能把人困在青面后面，到点淡出，页面自己的加载/出错态接手。
const SHOW_MIN = 1800; // 最短停留
const SHOW_MAX = 4000; // 最长停留（等数据的上限）
const LEAVE_MS = 240;  // 淡出（与 wxss splashOut 一致）

// 青面期间把原生导航栏也刷成青面（不然顶上一条白/黑，青面像张卡片不像启动页）。
// 系统 API 吃不到 CSS token，只能写值：与 palette.json screen.fieldBrand / theme.json 一致
const NAV_FIELD = { frontColor: '#000000', backgroundColor: '#7ed1cd' }; // ok: 品牌面色作导航栏底
const NAV_LIGHT = { frontColor: '#000000', backgroundColor: '#ffffff' };
const NAV_DARK = { frontColor: '#ffffff', backgroundColor: '#1b222b' };

function currentTheme() {
  try {
    const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
    return info && info.theme === 'dark' ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}

Component({
  properties: {
    // 页面数据是否已到（领取页：mode!=='loading'；工作台：ready）。出错态也算「到了」——错误要让人看见
    ready: { type: Boolean, value: false },
  },
  data: { visible: false, leaving: false, waiting: false },
  observers: {
    ready(v) { if (v) this.check(); },
  },
  lifetimes: {
    attached() {
      const app = getApp();
      if (!app || typeof app.consumeSplash !== 'function' || !app.consumeSplash()) return;
      this._minDone = false;
      this.setData({ visible: true, leaving: false, waiting: false });
      try { wx.setNavigationBarColor(NAV_FIELD); } catch (e) { /* 老基础库没有也无妨 */ }
      this._tMin = setTimeout(() => { this._minDone = true; this.check(); }, SHOW_MIN);
      this._tMax = setTimeout(() => this.dismiss(), SHOW_MAX);
    },
    detached() {
      this.clearTimers();
      if (this.data.visible) this.restoreNav();
    },
  },
  methods: {
    /** 最短停留已过 × 数据已到 → 走；已过但没到 → 亮「正在加载…」继续等 */
    check() {
      if (!this.data.visible || this.data.leaving || !this._minDone) return;
      if (this.properties.ready) this.dismiss();
      else if (!this.data.waiting) this.setData({ waiting: true });
    },
    skip() { this.dismiss(); },
    dismiss() {
      if (!this.data.visible || this.data.leaving) return;
      this.clearTimers();
      this.setData({ leaving: true });
      // 导航栏等淡出结束再还原：提前还原会在青面还没退干净时先冒出一条白/黑（scenarios/04 自检）
      this._tLeave = setTimeout(() => {
        this.setData({ visible: false, leaving: false, waiting: false });
        this.restoreNav();
      }, LEAVE_MS);
    },
    restoreNav() {
      try { wx.setNavigationBarColor(currentTheme() === 'dark' ? NAV_DARK : NAV_LIGHT); } catch (e) { /* 同上 */ }
    },
    clearTimers() {
      clearTimeout(this._tMin);
      clearTimeout(this._tMax);
      clearTimeout(this._tLeave);
    },
  },
});
