#!/usr/bin/env node
// ============================================================
//  把小程序主要页面的各个状态逐一摆出来截图（微信开发者工具的模拟器截图）
//
//  为什么要它：样式问题在代码里看不出来——比如 style v2 把整行按钮压成 184px，要到模拟器里才露馅。
//  这个脚本驱动开发者工具，把 mp-shots.fixtures.cjs 里的每个状态（待领取、到账中、已到账、发放四步、
//  台账、详情面板……）各截一张，发版前翻一遍就知道哪里排版不对。
//
//  注意：截的是开发者工具的「模拟器」，用的是真基础库，能抓到原生组件默认样式这类问题；
//  它不是真手机，字体、安全区、机型差异还得真机看。微信的自动化接口不支持真机截图。
//
//  用法（在你自己的电脑上）：
//    1. 装好微信开发者工具并登录；设置 › 安全设置 › 打开「服务端口」
//    2. npm i --no-save miniprogram-automator
//    3. node scripts/mp-shots.cjs                # 全部状态，输出到 mp-shots/
//       node scripts/mp-shots.cjs --only claim   # 只截名字里带 claim 的
//       node scripts/mp-shots.cjs --tag dark     # 先在模拟器里切到深色，再跑一遍，文件名带 -dark
//       node scripts/mp-shots.cjs --check        # 不开工具，只检查状态数据的字段名和页面对不对得上
//  选项：--cli <开发者工具 cli 路径>  --out <输出目录>  --port <自动化端口，默认 9420>  --keep（跑完不关项目窗口）
//
//  做法：每个状态都重新打开页面 → 把页面自己的 setData 换成空函数（页面发的请求回来也改不了画面）→
//  用「页面初始 data + 状态数据」摆出画面 → 页面比一屏长就往下滚着多截几张。不依赖后端，也不会真的发钱。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'miniprogram'); // project.config.json 所在目录
const MP = path.join(PROJECT, 'miniprogram');
const shots = require('./mp-shots.fixtures.cjs');

function parseArgs(argv) {
  const o = { out: path.join(ROOT, 'mp-shots'), only: '', tag: '', cli: '', port: 0, keep: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') o.keep = true;
    else if (a === '--check') o.check = true;
    else if (['--out', '--only', '--tag', '--cli', '--port'].includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 后面要跟一个值`);
      if (a === '--port') o.port = Number(v);
      else if (a === '--out') o.out = path.resolve(v);
      else o[a.slice(2)] = v;
    } else throw new Error(`不认识的参数：${a}`);
  }
  return o;
}

// 读出页面 data 的初始值：用一个假的 Page() 执行页面文件，只取它传进来的 data，不运行任何页面逻辑
function initialData(pageName) {
  const src = fs.readFileSync(path.join(MP, 'pages', pageName, `${pageName}.js`), 'utf8');
  let opts = null;
  const anything = new Proxy(function () {}, { get: () => anything, apply: () => anything });
  new Function('require', 'Page', 'wx', 'getApp', src)(() => anything, (o) => { opts = o; }, anything, () => anything);
  if (!opts || !opts.data) throw new Error(`没读到 pages/${pageName} 的初始 data`);
  return JSON.parse(JSON.stringify(opts.data));
}

// 状态数据里有、页面却不认识的键：多半是页面改了字段名，这张图会摆不对。
// 「认识」= 在页面初始 data 里，或者在页面模板里出现过（有些键是运行时才 setData 的，初始 data 里没有）
const wxmlCache = {};
function unknownKeys(pageName, base, data) {
  if (!wxmlCache[pageName]) wxmlCache[pageName] = fs.readFileSync(path.join(MP, 'pages', pageName, `${pageName}.wxml`), 'utf8');
  return Object.keys(data).filter((k) => !(k in base) && !new RegExp(`\\b${k}\\b`).test(wxmlCache[pageName]));
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const bases = {};
  for (const s of shots) if (!bases[s.page]) bases[s.page] = initialData(s.page);
  const list = shots.filter((s) => !opt.only || opt.only.split(',').some((k) => s.name.includes(k)));
  if (!list.length) throw new Error(`没有名字里带「${opt.only}」的状态`);

  let warned = 0;
  for (const s of list) {
    const bad = unknownKeys(s.page, bases[s.page], s.data);
    if (bad.length) {
      warned++;
      console.warn(`! ${s.name}：页面 data 里没有这些键：${bad.join('、')}（页面改过字段名？）`);
    }
  }
  if (opt.check) {
    console.log(warned ? `${list.length} 个状态里有 ${warned} 个对不上，见上` : `${list.length} 个状态的字段名都对得上`);
    process.exit(warned ? 1 : 0);
  }

  let automator;
  try {
    automator = require('miniprogram-automator');
  } catch (e) {
    console.error('找不到 miniprogram-automator。先运行：npm i --no-save miniprogram-automator');
    process.exit(1);
  }
  fs.mkdirSync(opt.out, { recursive: true });
  const launchOpt = { projectPath: PROJECT };
  if (opt.cli) launchOpt.cliPath = opt.cli;
  if (opt.port) launchOpt.port = opt.port;
  let mp;
  try {
    mp = await automator.launch(launchOpt);
  } catch (e) {
    console.error(`开发者工具没连上：${e.message}\n检查：① 工具已安装并登录 ② 设置 › 安全设置 › 服务端口已打开 ③ 装在非默认位置时用 --cli 指定 cli 路径`);
    process.exit(1);
  }

  const failed = [];
  try {
    const info = await mp.systemInfo();
    const winH = (info && info.windowHeight) || 667;
    let n = 0;
    for (const s of list) {
      n++;
      const tag = opt.tag ? `-${opt.tag}` : '';
      const file = (i) => path.join(opt.out, `${String(n).padStart(2, '0')}-${s.name}${i ? `-${i + 1}` : ''}${tag}.png`);
      try {
        const page = await mp.reLaunch(`/pages/${s.page}/${s.page}`);
        // 在小程序里执行：冻结页面自己的 setData，再用它原来的 setData 摆出这个状态
        await mp.evaluate(function (data) {
          const pages = getCurrentPages(); // eslint-disable-line no-undef
          const p = pages[pages.length - 1];
          if (!p.__shotSetData) {
            p.__shotSetData = p.setData;
            p.setData = function () {};
          }
          p.__shotSetData.call(p, data);
        }, { ...bases[s.page], ...s.data });
        await page.waitFor(600);
        const size = await page.size();
        const screens = Math.min(4, Math.max(1, Math.ceil(((size && size.height) || winH) / winH)));
        for (let i = 0; i < screens; i++) {
          await mp.pageScrollTo(i * winH);
          await page.waitFor(250);
          await mp.screenshot({ path: file(i) });
        }
        console.log(`✓ ${s.name}${screens > 1 ? `（${screens} 屏）` : ''}`);
      } catch (e) {
        failed.push(s.name);
        console.error(`✗ ${s.name}：${e.message}`);
      }
    }
  } finally {
    if (opt.keep) await mp.disconnect();
    else await mp.close();
  }
  console.log(`\n截图在 ${opt.out}`);
  if (failed.length) {
    console.error(`${failed.length} 个状态没截成：${failed.join('、')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
