// 云托管连接配置（在微信云托管控制台可查到）
module.exports = {
  CLOUD_ENV: 'YOUR_CLOUD_ENV_ID', // 云托管「环境ID」
  SERVICE: 'YOUR_SERVICE_NAME', // 云托管「服务名称」
  // 数字字体文件 URL（可选，留空则用系统字体栈兜底）。
  // 配置后全局注册为 'ROC Num'，金额/余额/汇总等大数字在所有安卓机型上质感一致。
  // 建议：开源等宽数字字体只子集化「0-9 ¥ . , —」的 woff2（可压到 <20KB），
  // 放到 HTTPS CDN（域名需加入小程序 downloadFile 合法域名）。
  NUM_FONT_URL: '',
};
