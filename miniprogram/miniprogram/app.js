App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低，请使用 2.2.3 以上的基础库');
      return;
    }
    const { CLOUD_ENV } = require('./config.js');
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
  },
});
