// 统一封装对云托管后端的调用（会自动带上微信身份 x-wx-openid）
const { CLOUD_ENV, SERVICE } = require('./config.js');

function call(path, method, data) {
  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: { env: CLOUD_ENV },
      path,
      method: method || 'GET',
      header: { 'X-WX-SERVICE': SERVICE, 'content-type': 'application/json' },
      data: data || {},
      success: (r) => resolve(r.data),
      fail: reject,
    });
  });
}

module.exports = { call };
