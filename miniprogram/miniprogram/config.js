// 云托管连接配置（在微信云托管控制台可查到）
module.exports = {
  CLOUD_ENV: 'YOUR_CLOUD_ENV_ID', // 云托管「环境ID」
  SERVICE: 'YOUR_SERVICE_NAME', // 云托管「服务名称」
  // 数字不加载网络字体（BYWOOD v5.8 规则：小程序不加载网络字体），统一走 app.wxss 的系统数字字体栈
};
