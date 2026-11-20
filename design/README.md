# 设计机器闸（BYWOOD 设计系统 v6.3 · 机器闸 v4.2 · 色板 v5.1）

小程序前端按 BYWOOD 设计系统 v6.3 落地（语法见 `miniprogram/miniprogram/app.wxss` 头注）。
这里只放两样让机器闸在本仓库能跑的东西，**都是设计系统包原件，未改一字**：

- `tokens/palette.json` —— 色值唯一事实源（v6 起多了 `grounds` 节：四种底与它们的字、线、按钮搭档）
- `tools/check-design.py` —— 机器闸 v4.2：色板外色值 / 圆角两档（容器 `--radius-container`、控件 `--radius-control`，嵌一层减 8rpx）/ 渐变 / 阴影 / 毛玻璃 / 括号配平 / 标志青当前景 / 主色与危险色填充上写死白字 / 动效写法（默认 `ease`、`transition: all`、动画去改布局属性）

```bash
npm run design:check        # 扫 miniprogram/miniprogram，一条 FAIL = 返工
```

小程序 token 文件 `miniprogram/miniprogram/tokens/miniprogram.wxss` 同为原件（v6.3：容器 24rpx / 控件 16rpx 两档圆角、六条按角色的动效曲线与时长、按下 `scale(.97)`）。

## v6.3 在小程序里落成了什么

- **底就是角色**，以块出现：深青 = 证据（待领奖励、可发额度）、浅青 = 方法与范围（筛选口径的汇总、空态说明）、标志青 = 承诺与里程碑（到账、开屏，青面三件套）、白表面 = 判断与操作（各步面板、行表）。
- **两种形状**：容器 24rpx、控件 16rpx、嵌一层减 8rpx；底部操作栏、标签页、行表的行、轮尺仍直角。
- **七个字级 + 两级数字**：d1 56 · d3 34 · lede 42 · body 30 · sm 26 · mi 24 · n1 80 · n2 34（rpx）；粗细只用两端。
- **四态**：按下 = 缩放 + 底色一起变，统一用 `hover-class="is-press"`（不用基础库默认的 `button-hover`）。
- **选择控件按行为选**：发放方式、员工角色是分段；台账与等级筛选是 chips；状态是语义色加深档的圆点记号。
- 去掉了没有信息的装饰（大字报水印「ROC」）；累计发放并进深青证据块。

升级设计系统时：整份覆盖这三个文件 → 对照 CHANGELOG 看 `screen` / `grounds` 节有没有换值（有则 `app.wxss` 扩展 token 同改，只改值不改名）→ 重跑闸。
完整规范（DESIGN.md / BRAND.md / CRAFT.md / CRAFT-UI.md / scenarios/04-miniprogram.md）在设计系统包里，不复制进仓库。

## 已知上游闸门（v4.2，随包 v6.3）未覆盖、靠自检的项

本仓库的闸门是上游原件，不打补丁；下面这些在升级到 v4.2 后逐条用样本复测仍未修，在修好之前靠写代码时自觉：

- 块注释里的文字会被当声明扫（注释里别写 `border-radius:` 这类原样声明）
- CSS 命名色（`color: red`）不查
- 短写 / 带 alpha 的 hex 只在与 `:` 同一行才认：`color:` 换行后写 `#f0f;` 会漏
- `hsl()` 的角度单位只认 `deg`：`0.5turn` / `rad` / `grad` 会被静默忽略
- `color(display-p3 …)` 不在"不认的函数"清单里，静默通过
- 5 位 / 7 位的非法 hex（`#12345`）不再报错
- JS 单行样式对象 `{ background: '#fff', color: '#7ed1cd' }`：青面豁免会把逗号后的青色前景一起吞掉

v4.2 已修：`border-radius: 0 0 0 0` 不再被误拦。
