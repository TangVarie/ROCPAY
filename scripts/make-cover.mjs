// ============================================================
//  生成分享卡封面（5:4，1000×800）
//  源文件是同目录的 share-cover.html（BYWOOD 闭合面：青面 + 一句话 + 墨版标识 + 轮印），
//  这里只负责用无头浏览器把它截成 PNG，写两份：
//    assets/reward-cover.png                        企微群发「小程序卡片」封面（/api/deliver 上传）
//    miniprogram/miniprogram/images/share-cover.png 小程序转发卡（onShareAppMessage 的 imageUrl）
//
//  运行：node scripts/make-cover.mjs
//  需要本机能 import playwright（不进 package.json：线上不跑这个脚本），没有就先
//    npm i --no-save playwright && npx playwright install chromium
//  字体从 Google Fonts 拉（Noto Sans SC / Noto Serif SC），生成时要能联网。
// ============================================================
import { mkdirSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, 'share-cover.html');
const OUT_WECOM = resolve(__dirname, '../assets/reward-cover.png');
const OUT_MP = resolve(__dirname, '../miniprogram/miniprogram/images/share-cover.png');

// 用 CommonJS 的 require 找：它认 NODE_PATH，全局装的 playwright 也找得到（ESM import 不认）
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch (e) {
  console.error('找不到 playwright。先运行：npm i --no-save playwright && npx playwright install chromium');
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(SRC).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  // 字体没拉到会退回系统字体，图照样能出，但衬线一句话会变黑体——宁可失败也别静默出错图
  const ok = await page.evaluate(() => document.fonts.check('700 96px "Noto Serif SC"', '你有一笔奖励'));
  if (!ok) throw new Error('Noto Serif SC 没加载上（检查网络），封面没有生成');
  mkdirSync(dirname(OUT_WECOM), { recursive: true });
  mkdirSync(dirname(OUT_MP), { recursive: true });
  await page.screenshot({ path: OUT_WECOM, type: 'png' });
  copyFileSync(OUT_WECOM, OUT_MP);
  console.log(`封面已生成：\n  ${OUT_WECOM}\n  ${OUT_MP}`);
} finally {
  await browser.close();
}
