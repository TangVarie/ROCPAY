// 统一封装对云托管后端的调用（会自动带上微信身份 x-wx-openid）
// 两道保护：
//  1) 全局串行队列：callContainer 在冷启动时并发首调会话未就绪，会被云端拒
//     （errCode -501000 Invalid request）。串行化后彻底规避。
//  2) 失败自动重试一次（间隔 400ms）：兜底冷启动/网络抖动的偶发失败。
const { CLOUD_ENV, SERVICE } = require('./config.js');

function rawCall(path, method, data) {
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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let queue = Promise.resolve();

function call(path, method, data) {
  const task = queue.then(() =>
    rawCall(path, method, data).catch(() => sleep(400).then(() => rawCall(path, method, data)))
  );
  // 队列只关心"轮到下一个"，不吞真实结果/错误
  queue = task.catch(() => {});
  return task;
}

module.exports = { call };
