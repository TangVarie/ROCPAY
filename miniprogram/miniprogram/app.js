App({
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
    const { CLOUD_ENV, NUM_FONT_URL } = require('./config.js');
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
    // 数字字体（可选）：配置了 NUM_FONT_URL 才加载，失败静默回退系统字体栈（--font-num 兜底）
    if (NUM_FONT_URL) {
      wx.loadFontFace({
        global: true,
        family: 'ROC Num',
        source: `url("${NUM_FONT_URL}")`,
        scopes: ['webview', 'native'],
        fail: (e) => console.warn('数字字体加载失败，回退系统字体栈：', e && e.status),
      });
    }
  },
});
