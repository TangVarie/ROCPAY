# 设计机器闸（BYWOOD 设计系统 v5.5.1 · 色板 v5.1）

小程序前端按 BYWOOD 设计系统落地（token 见 `miniprogram/miniprogram/app.wxss` 头注）。
这里只放两样让机器闸在本仓库能跑的东西，**都是设计系统包原件，未改一字**：

- `tokens/palette.json` —— 色值唯一事实源
- `tools/check-design.py` —— 机器闸：色板外色值（hex 长短 / rgb / hsl 归一比对）/ 圆角整值 / 渐变 / 阴影 / 毛玻璃 / 括号配平 / 标志青当前景

```bash
npm run design:check        # 扫 miniprogram/miniprogram，一条 FAIL = 返工
```

小程序 token 文件 `miniprogram/miniprogram/tokens/miniprogram.wxss` 同为原件（v5.4.1 起深色块正确、括号配平，可直接 `@import`）。

升级设计系统时：整份覆盖这三个文件 → 对照 CHANGELOG 看 `screen` 节有没有换值（有则 `app.wxss` 扩展 token 同改，只改值不改名）→ 重跑闸。
完整规范（DESIGN.md / BRAND.md / BRAND-LANGUAGE.md / scenarios/04-miniprogram.md）在设计系统包里，不复制进仓库。

## 已知上游闸门（v5.5.1）未覆盖、靠自检的项

本仓库的闸门是上游原件，不打补丁；下面这些已反馈上游，在修好之前靠写代码时自觉：

- 块注释里的文字会被当声明扫（注释里别写 `border-radius:` 这类原样声明）
- CSS 命名色（`color: red`）不查
- 短写 / 带 alpha 的 hex 只在与 `:` 同一行才认：`color:` 换行后写 `#f0f;` 会漏
- `hsl()` 的角度单位只认 `deg`：`0.5turn` / `rad` / `grad` 会被静默忽略
- `color(display-p3 …)` 不在"不认的函数"清单里，静默通过
- 5 位 / 7 位的非法 hex（`#12345`）不再报错
- JS 单行样式对象 `{ background: '#fff', color: '#7ed1cd' }`：青面豁免会把逗号后的青色前景一起吞掉
- `border-radius: 0 0 0 0` 会被误拦（整值匹配没放行重复的 0）——写 `0` 一个值即可
