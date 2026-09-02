# 设计机器闸（BYWOOD 设计系统 v5.4.0 · 色板 v5.1）

小程序前端按 BYWOOD 设计系统落地（token 见 `miniprogram/miniprogram/app.wxss` 头注）。
这里只放两样让机器闸在本仓库能跑的东西：

- `tokens/palette.json` —— 色值唯一事实源（从设计系统包原样复制，不在此改）
- `tools/check-design.py` —— 机器闸：色板外色值 / 圆角 / 渐变 / 阴影 / 毛玻璃 / 标志青当前景

```bash
npm run design:check        # 扫 miniprogram/miniprogram，一条 FAIL = 返工
```

升级设计系统时：整份覆盖这两个文件 → 对照 `palette.json` 的 `screen.light / screen.dark` 改 `app.wxss` 的 token 值（只改值不改名）→ 重跑闸。
完整规范（DESIGN.md / BRAND.md / scenarios/04-miniprogram.md）在设计系统包里，不复制进仓库。
