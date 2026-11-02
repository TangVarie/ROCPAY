App({
  globalData: {
    // 开屏挂在冷启动上：onLaunch 置 true，页面的 <splash/> 用 consumeSplash() 取走，只亮一次。
    // 热启动（切后台不到约 5 分钟回来）只走 onShow，不置位，所以不亮——阈值就是微信自己的销毁机制
    splashPending: false,
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低，请使用 2.2.3 以上的基础库');
      // 没有云能力所有请求都发不出去，页面会停在加载态——弹窗说清原因，别让用户干等
      wx.showModal({
        title: '微信版本过低',
        content: '当前微信版本过低，无法使用本小程序，请升级微信后重试。',
        showCancel: false,
      });
      return;
    }
    this.globalData.splashPending = true;
    const { CLOUD_ENV } = require('./config.js');
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
  },
  /** 取走本次冷启动的开屏（只给第一个问的页面） */
  consumeSplash() {
    const v = this.globalData.splashPending;
    this.globalData.splashPending = false;
    return v;
  },
});
