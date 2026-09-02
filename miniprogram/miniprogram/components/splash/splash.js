// 开屏组件：只管"亮多久"。亮不亮挂在冷启动上——App.onLaunch 置位，组件 attached 时取走。
// 顺序：onLaunch → onShow → 页面 onLoad → 组件 attached，所以冷启动时 attached 一定能取到；
// 热启动不重跑 onLaunch，取不到，自然不亮。
const SHOW_MS = 1000; // 停留
const LEAVE_MS = 240; // 淡出（与 wxss splashOut 一致）

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
  data: { visible: false, leaving: false },
  lifetimes: {
    attached() {
      const app = getApp();
      if (!app || typeof app.consumeSplash !== 'function' || !app.consumeSplash()) return;
      this.setData({ visible: true, leaving: false });
      try { wx.setNavigationBarColor(NAV_FIELD); } catch (e) { /* 老基础库没有也无妨 */ }
      this._t1 = setTimeout(() => this.dismiss(), SHOW_MS);
    },
    detached() {
      this.clearTimers();
      if (this.data.visible) this.restoreNav();
    },
  },
  methods: {
    skip() { this.dismiss(); },
    dismiss() {
      if (!this.data.visible || this.data.leaving) return;
      this.clearTimers();
      this.setData({ leaving: true });
      // 导航栏等淡出结束再还原：提前还原会在青面还没退干净时先冒出一条白/黑，
      // 正是把导航栏刷成青面要避免的那种割裂
      this._t2 = setTimeout(() => {
        this.setData({ visible: false, leaving: false });
        this.restoreNav();
      }, LEAVE_MS);
    },
    restoreNav() {
      try { wx.setNavigationBarColor(currentTheme() === 'dark' ? NAV_DARK : NAV_LIGHT); } catch (e) { /* 同上 */ }
    },
    clearTimers() {
      clearTimeout(this._t1);
      clearTimeout(this._t2);
    },
  },
});
