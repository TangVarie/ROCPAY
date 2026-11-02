#!/usr/bin/env python3
"""BYWOOD 设计系统机器闸 · v3.4

一条命令扫全轨。品牌跑偏从此是构建错误，不是审美分歧。

用法：
    python3 tools/check-design.py                  # 扫整个设计系统包（自检）
    python3 tools/check-design.py 成品.docx         # 扫一份交付 docx
    python3 tools/check-design.py src/ app.css     # 扫业务代码目录/文件
    python3 tools/check-design.py --lenient src/   # 探查模式：色板外色值只提示不判错

检查项：
    [SYNC]     四个派生文件的色值与 tokens/palette.json 是否一致
    [MIRROR]   bywood-proposal skill 里的 assets 镜像（docx-template.js / check-palette.py /
               bywood-fonts.conf）是否与本包同版——COLORS、白名单、版本戳逐值比对，
               模板正文（头部方向说明段之外）与 fonts.conf 逐字节比对。
               自检模式下自动定位 skill 目录，或用 --mirror=<路径> 指定
    [PALETTE]  文件里出现色板外色值——六位 hex、#rgb / #rgba / #rrggbbaa、rgb() / rgba() / hsl() / hsla()
               一律归一到六位比对（v5.5.1 起；透明度不参与比对）；oklch / lab / hwb / color-mix 写法直接判不认
    [FIG]      docx 里每张图之后紧跟的那一段必须含「来源｜」（模板 v5.1 起图只走 FIG()，
               来源行是构件的一部分；缺 = 手写版式绕过了模板，负面清单「无来源行的图」）。
               默认 FAIL，--lenient 降为提示（已交付旧版带图文档探查用）。
               模板 v5.3 内嵌的标志图形（docPr name 以 bywood- 开头）不是图，不计
    [ROUND]    对客 docx 在讲轮（第 N 轮 / 上一轮 / 下一轮 / 轮次表）却没有轮页栏目「这一轮」时提示（v5.8 起按条件，
               没有轮次语言的文件不查）。提示级，不判 FAIL
    [MODE]     生成层（v5.8）：声明了 data-bw-role 的网页逐块核对角色的必需槽位、上限、证据的文字替代（无图降级）、
               data-bw-plain 纯文本版是否完整、页序是否与 data-bw-contract 指向的契约一致；*.contract.json 核对
               任务 / 角色 / 槽位取值、P0 是否扛过每种降级、媒介约束是否都给了降级方案、样张是否存在；自检时
               另跑 tools/compose.py 比对黄金样张有没有被手改（漂移即 FAIL）。词表只认 composition/roles.json。
               只验结构，不评审美
    [CASE]     案史派生记录（v5.8.1）：composition/cases/case-records.json 的每个数字都要在 bywood-proposal 案例索引里
               写有该案名的行中逐字出现（正本在索引，记录不先于索引写事实）；不许出现金额；索引写了对外匿名的
               不许标 public；prev 链要接得上。找不到 skill 目录时只查结构
    [SYNTAX]   css / wxss 花括号配平（v5.4.1：多一个 } 会让小程序 @import 整份失败）
    [RADIUS]   border-radius 非 0（例外：50% 圆形本体、系统件）；整值匹配，0.5rem / 08px / "0 0 4px 0" 都不放行（v5.5.1）
    [BLUR]     backdrop-filter（毛玻璃，零豁免）
    [GRADIENT] UI 渐变（例外：骨架屏微光）
    [SHADOW]   box-shadow（例外：抽屉 --shadow-sheet）
    [CONTRAST] palette.json 自身的关键配色对比度是否达标
    [PROSE]    规范文本漂移（v5.7）：*.md 与 tokens/ templates/ 下 .py / .js 里出现已退役的色名
               （藏蓝 / 品牌红 / 红杠 / 双箭 …），或 *.md 里出现色板外色值。叙述历史的分句（带「退役 /
               曾 / 旧 / 当时 / 此前 / 原来 / 沿革 …」）与带 ok: 标记的行豁免；版本号不算历史标记——
               「v4 起…红＝信号系统」就是带着版本号漏过去的。CHANGELOG.md / reference/ / demo-v5/
               是存档，不扫。机器闸此前只认色值不认文字，换届后散文里的旧口径没有任何东西拦
    [GLYPH]    网页文件里出现 » / &raquo;（v5.7）：双箭的衍生用法（区块前标、链接尾标、步骤连接符）
               已随旧标志退役（BRAND.md §4），注释里的说明不算
    [TPLVAR]   模板与规范里的内联 token 漂移（v5.7.1）：界面轨模板（:root 里有 --block-primary）的亮 / 暗两块
               短名变量逐值比对 palette.json screen；任何 --X-rgb 三元组必须与同名 --X 的 hex 一致。
               此前派生文件之外的内联 token 没有任何比对——深色 --danger 写成赭石、deck 覆盖变量的 rgb 停在 v5.0 主色
    [ONFILL]   有深色模式的网页文件里，主色 / 危险色填充上写死白字（v5.7.1）：深色模式下亮青上白字仅 2.11:1、
               危险色上 3.53:1，一律写 --on-primary / --on-danger（--color-on-primary / --color-on-danger）
    [LOGO]     标志原件走独立白名单；标志青在 logo/ 之外只许做品牌面色（background），
               当前景（color / border / stroke / fill）即 FAIL（v5.1 起）。围栏对显式扫描目标也跑，
               认 hex / rgb() / hsl() 任何写法（v5.5.1）

退出码：0 全过；1 有 FAIL。
"""
import sys
import os
import re
import json
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PALETTE_PATH = os.path.join(ROOT, 'tokens', 'palette.json')

WEB_EXT = {'.css', '.wxss', '.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.wxml', '.svg'}
SKIP_DIRS = {'node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'logo', 'reference'}  # reference/ 是冻结存档，不按现行色板扫

# 允许出现在任何文件里的中性值
NEUTRAL = {'FFFFFF', 'FFF', '000000', '000', 'AUTO', 'TRANSPARENT'}
# 已拍板的例外（加新条目须在 CHANGELOG 留痕）
ALLOWED_EXTRA = {
    'FAFAFB',  # preview.html 色板演示底
    'E4E7EA',  # 模板演示用的设备外壳底（--desk），不是产品 token
    '0A0D11',  # 同上，深色档
}

# v4 版式起构件不再使用的 v3 浅调（仍在白名单，旧版文档合法；新件命中 = 用了 v3 旧模板）
# 标志原件专用白名单：这些色只在 logo/ 下合法。渐变同理——负面清单 #2 禁的是 UI 渐变，
# 标志不是 UI 色块；把渐变围进 logo/ 就既保住了 #2 的拦截力，也没把品牌最有辨识度的资产废掉。
LOGO_ALLOWED = {
    '7ED1CD',                                            # 标志主青（实心版）
    '6AC1BD', '78CCC9', '89DBD7', '9BEBE7', 'AEFCF8',    # 山形渐变 11 站（暖端 → 中点）
    'AFFDFC', '9BEEF5', '82DAEA', '6BC9E2', '53B9DA', '3CAAD2',
    '1E5754',                                            # icon.svg 的方底（= brand.primary，v5.1 深青）
}

V4_RETIRED_TINTS = {
    'E3EFEF': '原表头底', 'F0F6F6': '原 callout 底', 'CFE3E4': '原强调行底', 'F6F7F9': '原斑马纹',
}

# v5.7 · 规范文本漂移闸（[PROSE]）与退役字形闸（[GLYPH]）
RETIRED_NAMES = ['深藏蓝', '藏蓝', '品牌红', '标志红', '钢蓝', '红杠', '蓝杠', '深蓝', '深藏青', '藏青', '双箭',
                 '红＝信号', '红=信号', '红色增量', '红=增长', '红柱', '蓝块', '蓝字', '蓝底白字', '深蓝底', '蓝描边', '主蓝',
                 '红/蓝', '红 / 蓝', '红 ↔ 蓝', '红↔蓝', '蓝前红后', '红色只', '红色大块', '红色数字', '蓝色数据', '蓝+雾蓝']
# 语义色的「红」（危险按钮红底、danger）是状态色不是品牌色，不在清单里
# 叙述历史的标记。版本号与箭头不算：「v4 起…红＝信号系统」带着版本号却是现行口径
RE_HISTORY = re.compile(r'退役|已退|曾|旧|沿革|历史|对照|废止|作废|当时|此前|以前|原为|原来|（原|继承|换届|取代|替代|弃用')
# 豁免按分句判，不按整行：「主按钮用深蓝，不再加描边」里的历史词不能替同一行的另一句开脱（v5.7 复核指出）
RE_CLAUSE = re.compile(r'[，。；;！？|]')   # 顿号不切：枚举项与其历史词同属一句
PROSE_SKIP_FILES = {'CHANGELOG.md'}
# 带日期的版本记录（「**v4.0（2026-08-17）·…」「> **模板 v5.3（2026-09-02 …」）本身就是历史，整行豁免
RE_RELEASE_NOTE = re.compile(r'^\s*(?:>\s*)?\*\*.{0,72}?20\d\d-\d\d-\d\d')
PROSE_SKIP_DIRS = {'reference', 'demo-v5', 'tools', 'logo'}
HUE_SEGS = {'blue', 'red', 'sky', 'blush', 'teal', 'ochre', 'green', 'gold', 'cyan', 'purple', 'orange', 'navy', 'pink'}
RE_VAR_DEF = re.compile(r'(--[A-Za-z0-9_-]+)\s*:')
RE_GLYPH = re.compile(r'»|&raquo;|&#187;|&#x0*bb;|\\u00bb', re.I)
RE_GLYPH_CSS = re.compile(r'content\s*:\s*([\'"])[^\'"]*\\0{0,4}bb(?![0-9a-f])', re.I)   # CSS 转义 \bb / \00bb

# 行内豁免标记：在同一行写 /* ok: 理由 */、// ok: 理由、<!-- ok: 理由 --> 即跳过该行检查。
# 理由必须写，空标记不算。加豁免须在 CHANGELOG 留痕。
RE_OK = re.compile(r'(?:/\*|//|<!--)\s*ok:\s*\S+')

# bywood-proposal skill 的常见安装位（镜像自检用；宿主会换布局，都找不到就跳过并提示）
MIRROR_CANDIDATES = [
    os.path.expanduser('~/.claude/skills/bywood-proposal'),
    os.path.expanduser('~/.claude/skills/synced/bywood-proposal'),
    '/root/.claude/skills/bywood-proposal',
    '/root/.claude/skills/synced/bywood-proposal',
    '/mnt/skills/user/bywood-proposal',
]

fails = []
warns = []


def fail(kind, path, msg):
    fails.append((kind, path, msg))


def warn(kind, path, msg):
    warns.append((kind, path, msg))


# ---------------------------------------------------------------- palette
def load_palette():
    with open(PALETTE_PATH, encoding='utf-8') as f:
        return json.load(f)


def collect_hexes(node, out):
    """只收色值字段，不收描述字段。v5.1 修：brand.*.source / role 这类散文里写着退役色与渐变色
    （「v5.0 曾取 #1C4F62」），以前会被一并收进白名单，退役色在模板里残留也查不出来。"""
    if isinstance(node, dict):
        for k, v in node.items():
            if k.startswith('_') or k in ('meta', 'ratio', 'rules', 'source', 'role', 'name', 'hsl', 'categoricalRoles'):
                continue
            collect_hexes(v, out)
    elif isinstance(node, list):
        for v in node:
            collect_hexes(v, out)
    elif isinstance(node, str):
        for m in re.findall(r'#?\b([0-9A-Fa-f]{6})\b', node):
            out.add(m.upper())


# ---------------------------------------------------------------- contrast
def _lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hexstr):
    h = hexstr.lstrip('#')
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def resolve(p, ref):
    """'#FFFFFF' 原样返回；'brand.primary.hex' 按点号路径从色板取值。"""
    if ref.startswith('#'):
        return ref
    node = p
    for part in ref.split('.'):
        node = node[part]
    return node if node.startswith('#') else '#' + node


def check_contrast(p):
    """配对表住在 palette.json 的 _contrastPairs 里，本函数不认识任何具体色名。
    v4 版本把 brand.blue / doc.SKY_100 这类键路径写死在这里，换一次品牌色闸门就 KeyError 崩在
    第一步，后面的 SYNC / MIRROR 全部不跑——闸门反而成了换色时最先失灵的一环。v5 起解耦。"""
    pairs = p.get('_contrastPairs')
    if not pairs:
        fail('CONTRAST', 'tokens/palette.json', '缺 _contrastPairs 声明：色板自检无从跑起')
        return
    for item in pairs:
        try:
            fg, bg = resolve(p, item['fg']), resolve(p, item['bg'])
        except (KeyError, TypeError):
            fail('CONTRAST', 'tokens/palette.json',
                 f"{item['name']}：引用了不存在的键路径（{item['fg']} / {item['bg']}）")
            continue
        r = contrast(fg, bg)
        if r < item['min']:
            fail('CONTRAST', 'tokens/palette.json', f"{item['name']}：{r:.2f}:1 < {item['min']}:1")
        else:
            print(f"  · {item['name']}: {r:.2f}:1")


def check_naming(p):
    """token 名不许带色相。v4→v5 的迁移成本九成来自 blue/red/sky/blush 这类名字。"""
    HUE = re.compile(r'(?i)(blue|red|sky|blush|teal|ochre|green|gold|cyan|purple|orange)')
    for section in ('brand', 'ratio', 'doc'):
        for k in p.get(section, {}):
            if k.startswith('_'):
                continue
            if HUE.search(k) and k != 'logoMark':
                fail('NAMING', 'tokens/palette.json', f'{section}.{k} 带色相名，改角色名（meta.namingRule）')
    for mode in ('light', 'dark'):
        for k in p['screen'][mode]:
            if HUE.search(k):
                fail('NAMING', 'tokens/palette.json', f'screen.{mode}.{k} 带色相名，改角色名')


def check_provenance(p):
    """负面清单 #4 的机器落地物：每个品牌色必须写明它是取值色还是推导色，以及取自哪。
    #4 旧文「品牌色以标志为唯一基准」任何色板都做不到——标志只有一两个色，系统要四十个。
    它真正拦的是『从第三方模板抄品牌色』（克莱因蓝就是这么进来的）。v5 把它落成来源留痕。"""
    for k, v in p.get('brand', {}).items():
        if k.startswith('_'):
            continue
        src = (v or {}).get('source', '').strip() if isinstance(v, dict) else ''
        if not src:
            fail('SOURCE', 'tokens/palette.json', f'brand.{k} 缺 source：品牌色必须留取值/推导来源')
        elif not (src.startswith('取值色') or src.startswith('推导色')):
            fail('SOURCE', 'tokens/palette.json',
                 f'brand.{k} 的 source 未标明取值色/推导色：{src[:24]}')
        else:
            print(f'  · brand.{k}: {src[:38]}')


CSS_VAR = {
    'primary': '--color-primary', 'primaryDark': '--color-primary-dark',
    'accent': '--color-accent', 'money': '--color-money',
    'blockPrimary': '--color-block-primary', 'blockAccent': '--color-block-accent',
    'tintPrimary': '--color-tint-primary', 'tintAccent': '--color-tint-accent',
    'fieldBrand': '--color-field-brand',
    'success': '--color-success', 'warning': '--color-warning',
    'danger': '--color-danger', 'dangerDark': '--color-danger-dark',
    'successDeep': '--color-success-deep', 'warningDeep': '--color-warning-deep',
    'dangerDeep': '--color-danger-deep',
    'bg': '--color-bg', 'bgSecondary': '--color-bg-secondary',
    'surface': '--color-surface', 'borderStrong': '--color-border-strong',
    'onPrimary': '--color-on-primary', 'onDanger': '--color-on-danger',   # v5.7.1
}

# v5.7.1 · [TPLVAR] 界面轨模板内联 token 的短名 → palette.json screen 键
TPL_VAR = {
    '--primary': 'primary', '--primary-dark': 'primaryDark', '--on-primary': 'onPrimary',
    '--accent': 'accent', '--block-primary': 'blockPrimary', '--block-accent': 'blockAccent',
    '--tint-primary': 'tintPrimary', '--tint-accent': 'tintAccent',
    '--success': 'success', '--warning': 'warning', '--danger': 'danger', '--on-danger': 'onDanger',
    '--success-deep': 'successDeep', '--warning-deep': 'warningDeep', '--danger-deep': 'dangerDeep',
    '--bg': 'bg', '--bg2': 'bgSecondary', '--surface': 'surface', '--border-strong': 'borderStrong',
}
RE_RGB_TRIPLE = re.compile(r'(--[A-Za-z0-9_-]+)-rgb\s*:\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})')
RE_HEX_DEF = re.compile(r'(--[A-Za-z0-9_-]+)\s*:\s*(#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3})\b')
RE_DARK_SEL = re.compile(r"\[data-theme=['\"]?dark['\"]?\]\s*\{|:root:not\(\[data-theme=['\"]?light['\"]?\]\)\s*\{")
RE_HAS_DARK = re.compile(r"data-theme=['\"]?dark|prefers-color-scheme\s*:\s*dark", re.I)
RE_FILL_BG = re.compile(r'background(?:-color)?\s*:\s*var\(--(?:color-)?(primary|danger)\)')
RE_WHITE_FG = re.compile(r'(?<![-\w])color\s*:\s*(?:#fff(?:fff)?|white)\b', re.I)


def _hex6(v):
    v = v.lstrip('#').upper()
    return ''.join(c * 2 for c in v) if len(v) == 3 else v[:6]


def check_template_tokens(root, p):
    """[TPLVAR] v5.7.1：派生文件之外的内联 token。SYNC 只比四个派生文件，模板与规范里抄的那份没人比——
    v5.7 包里深色 --danger 写成了赭石 #D97E55（两份模板），场景 06 的 --accent-rgb 停在 v5.0 主色 28,79,98。"""
    tdir = os.path.join(root, 'templates')
    n = 0
    for fn in sorted(os.listdir(tdir)) if os.path.isdir(tdir) else []:
        if not fn.endswith('.html'):
            continue
        src = open(os.path.join(tdir, fn), encoding='utf-8', errors='replace').read()
        m = re.search(r':root\s*\{(.*?)\}', src, re.S)
        if not m or '--block-primary' not in m.group(1):
            continue   # 只认界面轨模板；deck / 物料 / 图表模板的 --accent 等是另一套语义
        n += 1
        blocks = [('light', m.group(1))]
        for md in RE_DARK_SEL.finditer(src):
            blocks.append(('dark', src[md.end():src.find('}', md.end())]))
        for mode, body in blocks:
            for var, val in RE_HEX_DEF.findall(body):
                key = TPL_VAR.get(var)
                want = p['screen'][mode].get(key, '') if key else ''
                if want.startswith('#') and _hex6(val) != _hex6(want):
                    fail('TPLVAR', f'templates/{fn}',
                         f'{"亮色" if mode == "light" else "深色"} {var} = {val}，palette.json screen.{mode}.{key} 是 {want}')
    t = 0
    for dirpath, dirs, files in os.walk(root):
        top = os.path.relpath(dirpath, root).split(os.sep)[0]
        if top in SKIP_DIRS or top in PROSE_SKIP_DIRS:
            dirs[:] = []
            continue
        for fn in files:
            if fn in PROSE_SKIP_FILES or os.path.splitext(fn)[1].lower() not in ('.md', '.html', '.css', '.wxss'):
                continue
            fp = os.path.join(dirpath, fn)
            src = open(fp, encoding='utf-8', errors='replace').read()
            defs = [(mm.start(), mm.group(1), mm.group(2)) for mm in RE_HEX_DEF.finditer(src)]
            for mt in RE_RGB_TRIPLE.finditer(src):
                prior = [d for d in defs if d[1] == mt.group(1)]
                if not prior:
                    continue
                before = [d for d in prior if d[0] < mt.start()]
                h = (before[-1] if before else prior[0])[2]
                got = tuple(int(x) for x in mt.group(2, 3, 4))
                want = tuple(int(_hex6(h)[i:i + 2], 16) for i in (0, 2, 4))
                t += 1
                if got != want:
                    line = src[:mt.start()].count('\n') + 1
                    fail('TPLVAR', f'{os.path.relpath(fp, root)}:{line}',
                         f'{mt.group(1)}-rgb = {",".join(map(str, got))}，与 {mt.group(1)} {h} 不符（应为 {",".join(map(str, want))}）')
    print(f'  · 比对 {n} 份界面轨模板的内联 token，{t} 组 rgb 三元组')



def check_sync(p):
    """四个派生文件必须与 palette.json 逐值一致——这是本闸门存在的理由，抽查不算数。"""
    # 1. docx-template.js 的 COLORS：全 doc 节双向比对
    tpl = os.path.join(ROOT, 'templates', 'docx-template.js')
    if os.path.exists(tpl):
        src = open(tpl, encoding='utf-8').read()
        block = re.search(r'const COLORS = \{(.*?)\n\};', src, re.S)
        if not block:
            fail('SYNC', 'templates/docx-template.js', '找不到 COLORS 常量块')
        else:
            got = dict(re.findall(r"(\w+):\s*'([0-9A-Fa-f]{6})'", block.group(1)))
            want = {k: v for k, v in p['doc'].items() if not k.startswith('_')}
            for k, v in want.items():
                if got.get(k, '').upper() != v.upper():
                    fail('SYNC', 'templates/docx-template.js',
                         f'COLORS.{k} = {got.get(k, "缺失")}，palette.json 是 {v}')
            for k in got:
                if k not in want:
                    fail('SYNC', 'templates/docx-template.js', f'COLORS.{k} 不在 palette.json 的 doc 节里')

    # 2. globals.css：亮 + 暗两套全部 hex token 逐值比对
    css = os.path.join(ROOT, 'tokens', 'globals.css')
    if os.path.exists(css):
        src = open(css, encoding='utf-8').read()
        dark_block = src[src.index("[data-theme='dark']"):] if "[data-theme='dark']" in src else ''
        light_block = src[:src.index('@layer base')] if '@layer base' in src else src
        for mode, blk in (('亮色', light_block), ('深色', dark_block)):
            if not blk:
                fail('SYNC', 'tokens/globals.css', f'找不到{mode}块')
                continue
            for key, var in CSS_VAR.items():
                want = p['screen']['light' if mode == '亮色' else 'dark'].get(key, '')
                if not want.startswith('#'):
                    continue  # rgba 类跳过：格式不可逐字比
                m = re.search(re.escape(var) + r':\s*(#[0-9A-Fa-f]{3,8})\s*;', blk)
                if not m:
                    # 深色与亮色同值时不需要覆盖，缺席是正确的
                    if mode == '深色' and want.upper() == p['screen']['light'].get(key, '').upper():
                        continue
                    fail('SYNC', 'tokens/globals.css', f'{mode}块里找不到 {var}')
                elif m.group(1).upper() != want.upper():
                    fail('SYNC', 'tokens/globals.css',
                         f'{mode} {var} = {m.group(1)}，palette.json 是 {want}')

    # 3. miniprogram.wxss：亮色块与深色块的 hex token 分别逐值比对
    #    v5.4.1 起深色块也比——此前只比亮色块，深色块从 v4 起写着亮色值，直到外部使用者报上来才发现。
    wx = os.path.join(ROOT, 'tokens', 'miniprogram.wxss')
    if os.path.exists(wx):
        src = open(wx, encoding='utf-8').read()
        dk = src.find('@media (prefers-color-scheme: dark)')
        light_blk, dark_blk = (src[:dk], src[dk:]) if dk != -1 else (src, '')
        for key, var in CSS_VAR.items():
            want = p['screen']['light'].get(key, '')
            if not want.startswith('#'):
                continue
            m = re.search(re.escape(var) + r':\s*(#[0-9A-Fa-f]{3,8})\s*;', light_blk)
            if m and m.group(1).upper() != want.upper():
                fail('SYNC', 'tokens/miniprogram.wxss',
                     f'亮色 {var} = {m.group(1)}，palette.json 是 {want}')
            if not m:
                continue   # 小程序 token 是子集：亮色块没定义的键不查深色块
            want_d = p['screen']['dark'].get(key, '')
            if not want_d.startswith('#'):
                continue
            md = re.search(re.escape(var) + r':\s*(#[0-9A-Fa-f]{3,8})\s*;', dark_blk)
            if not md:
                if want_d.upper() != want.upper():
                    fail('SYNC', 'tokens/miniprogram.wxss', f'深色块里找不到 {var}（深色值 {want_d} 与亮色不同，必须覆盖）')
            elif md.group(1).upper() != want_d.upper():
                fail('SYNC', 'tokens/miniprogram.wxss',
                     f'深色 {var} = {md.group(1)}，palette.json 是 {want_d}')

    # 4. chart-palette.py：四组色序全部比对
    cp = os.path.join(ROOT, 'tokens', 'chart-palette.py')
    if os.path.exists(cp):
        src = open(cp, encoding='utf-8').read()
        arrays = {
            'CATEGORICAL': p['chart']['light']['categorical'],
            'CATEGORICAL_DARK': p['chart']['dark']['categorical'],
            'SEQUENTIAL': p['chart']['light']['sequential'],
            'DIVERGING': p['chart']['light']['diverging'],
        }
        for name, want in arrays.items():
            m = re.search(name + r' = \[(.*?)\]', src, re.S)
            if not m:
                fail('SYNC', 'tokens/chart-palette.py', f'找不到 {name}')
                continue
            got = [x.upper() for x in re.findall(r"'(#[0-9A-Fa-f]{6})'", m.group(1))]
            if got != [x.upper() for x in want]:
                fail('SYNC', 'tokens/chart-palette.py', f'{name} 色序不一致：{got} ≠ {want}')
        for name, want in (('GRID', p['chart']['light']['grid']),
                           ('AXIS', p['chart']['light']['axis']),
                           ('LABEL', p['chart']['light']['label'])):
            m = re.search(name + r" = '(#[0-9A-Fa-f]{6})'", src)
            if m and m.group(1).upper() != want.upper():
                fail('SYNC', 'tokens/chart-palette.py', f'{name} = {m.group(1)}，palette.json 是 {want}')


# ---------------------------------------------------------------- mirror
def check_mirror(p, d):
    """bywood-proposal skill 里的两份镜像必须与 palette.json 同版。
    镜像的存在是为了 skill 离线也能开工；这个检查的存在是为了镜像不悄悄变旧。"""
    want = {k: v.upper() for k, v in p['doc'].items() if not k.startswith('_')}

    tpl = os.path.join(d, 'assets', 'docx-template.js')
    if os.path.exists(tpl):
        src = open(tpl, encoding='utf-8').read()
        block = re.search(r'const COLORS = \{(.*?)\n\};', src, re.S)
        if not block:
            fail('MIRROR', tpl, '找不到 COLORS 常量块')
        else:
            got = {k: v.upper() for k, v in re.findall(r"(\w+):\s*'([0-9A-Fa-f]{6})'", block.group(1))}
            if got != want:
                diffs = sorted(k for k in set(want) | set(got) if want.get(k) != got.get(k))
                fail('MIRROR', tpl,
                     f'COLORS 与 palette.json 不同步（{", ".join(diffs)}）——'
                     '从设计系统 templates/docx-template.js 整份覆盖，不要就地改')
    else:
        fail('MIRROR', tpl, '镜像缺失')

    cp = os.path.join(d, 'assets', 'check-palette.py')
    if os.path.exists(cp):
        src = open(cp, encoding='utf-8').read()
        m = re.search(r'WHITELIST = \{(.*?)\}', src, re.S)
        wl = {x.upper() for x in re.findall(r"'([0-9A-Fa-f]{6}|AUTO)'", m.group(1))} if m else set()
        expect = set(want.values()) | {'FFFFFF', '000000', 'AUTO'}
        if wl != expect:
            extra, missing = sorted(wl - expect), sorted(expect - wl)
            fail('MIRROR', cp, f'WHITELIST 与 palette.json doc 节不同步：多 {extra or "无"} / 少 {missing or "无"}')
        vm = re.search(r"PALETTE_VERSION = '([^']+)'", src)
        ver = vm.group(1) if vm else '缺失'
        if ver != p['meta']['version']:
            fail('MIRROR', cp, f"版本戳 {ver} ≠ palette.json 的 {p['meta']['version']}")
    else:
        fail('MIRROR', cp, '镜像缺失')

    # 模板正文逐字节比对：头部方向说明段（首个 /** … */ 块）除外，其余两份必须完全一致（v4 §四）
    src_tpl = os.path.join(ROOT, 'templates', 'docx-template.js')
    if os.path.exists(tpl) and os.path.exists(src_tpl):
        def _body(fp):
            t = open(fp, encoding='utf-8').read()
            i = t.find('*/')
            return t[i + 2:] if i != -1 else t
        if _body(tpl) != _body(src_tpl):
            fail('MIRROR', tpl, '模板正文与包侧 templates/docx-template.js 不一致'
                 '（头部说明段之外应逐字节相同）——以包侧为准整份覆盖，不要就地改')

    # fonts.conf 镜像（v4 新增）：skill 离线开工时没有它，soffice 出的 PDF 字体观感是错的
    fc_src = os.path.join(ROOT, 'tools', 'bywood-fonts.conf')
    fc_mir = os.path.join(d, 'assets', 'bywood-fonts.conf')
    if os.path.exists(fc_src):
        if not os.path.exists(fc_mir):
            fail('MIRROR', fc_mir, '镜像缺失（v4 起 skill 需携带字体映射）')
        elif open(fc_mir, 'rb').read() != open(fc_src, 'rb').read():
            fail('MIRROR', fc_mir, '与包侧 tools/bywood-fonts.conf 不一致——以包侧为准覆盖')
    print(f'  · 已比对 {d}')


# ---------------------------------------------------------------- docx
W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
RE_SOURCE_LINE = re.compile(r'来源[｜|]')
# 模板 v5.3 起，标志图形（刊头 / 轮印里的山形）也是 <w:drawing>，靠 docPr name 前缀认：它们不是图，不要求来源行
BRAND_DRAWING_PREFIX = 'bywood-'
# v5.5.1 起查的是轮页栏目「这一轮」（模板 v5.4：印不计数，页眉不报轮次，轮页左格固定写「这一轮」）
RE_ROUND_MARK = re.compile(r'这一轮')
RE_ROUND_TALK = re.compile(r'第\s*[一二三四五六七八九十\d]+\s*轮|上一轮|下一轮|轮次表|分轮')


def check_fig_sources(path, xml, strict):
    """图必须带来源行（模板 v5.1 FIG 构件：图题 / 图 / 来源行三件一体）。
    规则：document.xml 里每个含 <w:drawing> 的段落，其后紧邻的一个段落必须含「来源｜」。
    FIG() 生成的结构天然满足；不满足 = 图是绕开模板手放的，或来源行被删。
    图内颜色不在 document.xml，本闸不管图色——图色靠 tokens/chart-palette.py 保证。"""
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        fail('FIG', path, f'document.xml 解析失败：{e}')
        return
    P, DRAWING, T = f'{{{W_NS}}}p', f'{{{W_NS}}}drawing', f'{{{W_NS}}}t'
    DOCPR = f'{{{WP_NS}}}docPr'
    # 文本框（drawing 里的 txbxContent）内的段落不算版面段落，先剔除
    nested = set()
    for d in root.iter(DRAWING):
        for p in d.iter(P):
            nested.add(id(p))
    paras = [p for p in root.iter(P) if id(p) not in nested]
    missing = []
    n_fig = 0
    n_brand = 0
    for i, p in enumerate(paras):
        drawings = p.findall(f'.//{DRAWING}')
        if not drawings:
            continue
        # 段里的 drawing 全是标志图形（docPr name 以 bywood- 开头）→ 不是图，跳过
        names = [(d.find(f'.//{DOCPR}').get('name') or '') if d.find(f'.//{DOCPR}') is not None else '' for d in drawings]
        if names and all(nm.startswith(BRAND_DRAWING_PREFIX) for nm in names):
            n_brand += 1
            continue
        n_fig += 1
        nxt = paras[i + 1] if i + 1 < len(paras) else None
        text = ''.join(t.text or '' for t in nxt.iter(T)) if nxt is not None else ''
        if not RE_SOURCE_LINE.search(text):
            missing.append(n_fig)
    if n_brand:
        print(f'    {n_brand} 处标志图形（docPr bywood-*，模板 v5.3 内嵌）不计入图')
    if n_fig == 0:
        return
    if missing:
        (fail if strict else warn)(
            'FIG', path,
            f'共 {n_fig} 张图，第 {", ".join(map(str, missing))} 张之后没有来源行——'
            '图只走模板 FIG()（图题＋图＋「来源｜」三件一体，缺 source 构建即抛错）；'
            '手放的图与无来源的数字是同一种事故（负面清单「无来源行的图」）')
    else:
        print(f'    {n_fig} 张图均带来源行')


def scan_docx(path, allowed, strict=True):
    try:
        xml = zipfile.ZipFile(path).read('word/document.xml').decode('utf-8')
    except Exception as e:
        fail('PALETTE', path, f'读不出 word/document.xml：{e}')
        return
    pat = re.compile(
        r'<w:(?:color|shd|top|bottom|left|right|insideH|insideV)\b[^>]*?'
        r'w:(?:val|fill|color)="([0-9A-Fa-f]{6})"')
    found = {m.upper() for m in pat.findall(xml)}
    bad = found - allowed - NEUTRAL - ALLOWED_EXTRA
    if bad:
        fail('PALETTE', path, '白名单外色值：' + ' '.join(sorted(bad)))
    else:
        print(f'  · {os.path.basename(path)}: {len(found)} 个色值全部在白名单内')
        tints = found & set(V4_RETIRED_TINTS)
        if tints:
            print('    v4 提示（不判 FAIL）：检测到 v3 底纹色——'
                  + '、'.join(f'{c}（{V4_RETIRED_TINTS[c]}）' for c in sorted(tints)))
            print('    新构建的文档应使用 v4 模板（零底纹，templates/docx-template.js）；本文件若为已交付旧版则忽略本提示。')
    check_fig_sources(path, xml, strict)
    check_round_mark(path, xml)


def check_round_mark(path, xml):
    """轮页（模板 v5.4 的 ROUND()；v5.8 起按条件查）。
    「轮」是方法核心，轮页是场景构件：只有文件自己在讲轮（第 N 轮 / 上一轮 / 下一轮 / 轮次表）却没有「这一轮」栏目时才提示。
    单次交付、短期项目、没有轮次语言的文件不查——v5.7 以前这条对每份 docx 都提示，单轮项目收到的全是噪音。"""
    plain = re.sub(r'<[^>]+>', '', xml)
    talks = RE_ROUND_TALK.search(plain)
    has = RE_ROUND_MARK.search(plain)
    if has:
        print('    轮页「这一轮」在')
    elif talks:
        warn('ROUND', path, f'正文在讲轮（「{talks.group(0)}」）却没有「这一轮」栏目——提案写了轮次表且甲方认可分轮关系时，'
                            '在刊头之下放 ROUND({ span, goal, prev, now, next })，数字取自案史记录；只是顺口一提就忽略本提示')
    else:
        print('    无轮次语言，不查轮页')


# ---------------------------------------------------------------- web
RE_HEX = re.compile(r'#([0-9A-Fa-f]{6})\b')
# v5.5.1：色值不只有六位 hex。#rgb / #rgba / #rrggbbaa / rgb() / rgba() / hsl() / hsla() 此前一概不认，
# 等于给闸门留了一扇后门（外部使用者的代码审查指出）。统一归一到六位 hex 再比对；透明度不参与比对——
# 色板色带 alpha 仍是色板色（文字四阶、徽标浅底都是这种写法）。
RE_COLOR = re.compile(
    r'#([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3,4})(?![0-9A-Fa-f\w-])'
    r'|\b(rgba?|hsla?)\(\s*([^()]*?)\s*\)', re.I)
RE_COLOR_FN_UNKNOWN = re.compile(r'\b(oklch|oklab|lab|lch|hwb|color-mix)\(', re.I)


def _num(tok, scale):
    tok = tok.strip().lower().replace('deg', '')
    if tok.endswith('%'):
        return float(tok[:-1]) / 100 * scale
    return float(tok)


def _hsl_to_rgb(h, sl, l):
    h = (h % 360) / 360
    c = (1 - abs(2 * l - 1)) * sl
    x = c * (1 - abs((h * 6) % 2 - 1))
    m = l - c / 2
    r, g, b = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)][int(h * 6) % 6]
    return [round((v + m) * 255) for v in (r, g, b)]


def colors_in(line):
    """yield (原文, 六位大写 hex)。认不出的写法（oklch / lab / hwb / color-mix）单独由调用方判。
    短写 hex（#rgb / #rgba / #rrggbbaa）只在取值位认：前面同一声明里有 : 或 =（排掉 #abc 这类 id 选择器与锚点）。"""
    for m in RE_COLOR.finditer(line):
        if m.group(1) is not None:
            h = m.group(1)
            if len(h) != 6:
                before = line[:m.start()]
                decl = re.split(r'[;{}]', before)[-1]
                if not re.search(r'[:=]', decl) or re.search(r'(href\s*=\s*["\']?|url\(\s*["\']?)$', before):
                    continue
            if len(h) in (3, 4):
                h = ''.join(ch * 2 for ch in h[:3])
            yield m.group(0), h[:6].upper()
            continue
        fn, args = m.group(2).lower(), m.group(3)
        parts = [t for t in re.split(r'[,\s/]+', args) if t]
        if len(parts) < 3:
            continue
        try:
            if fn.startswith('rgb'):
                rgb = [max(0, min(255, round(_num(t, 255)))) for t in parts[:3]]
            else:
                rgb = _hsl_to_rgb(_num(parts[0], 360), _num(parts[1], 1) if parts[1].endswith('%') else float(parts[1]) / 100,
                                  _num(parts[2], 1) if parts[2].endswith('%') else float(parts[2]) / 100)
        except ValueError:
            continue
        yield m.group(0), '%02X%02X%02X' % tuple(rgb)
RE_RADIUS = re.compile(r'border-radius\s*:\s*([^;}\n]+)')
RE_BLUR = re.compile(r'backdrop-filter\s*:|(?<![\w-])-webkit-backdrop-filter\s*:')
RE_GRAD = re.compile(r'(linear|radial|conic)-gradient\s*\(')
# 单文件产物（demo / 分享卡 / 邮件模板）必须把标志内联，不能引 logo/ 下的文件。
# 内联的标志原件本身仍是合法用色处，靠 viewBox 签名认出来：
# 山形 292.502×90、横版 733.1x×90、方图标 512×512（各版导出的小数位略有出入，故放宽尾数）。
# 认不出签名的行 = 裸用（按钮、文字、边框用了标志色），照旧 FAIL。
RE_INLINE_LOGO = re.compile(r'viewBox="0 0 (?:292\.50\d*|733\.1\d*|512) 90|viewBox="0 0 512 512"', re.I)
RE_SHADOW = re.compile(r'box-shadow\s*:\s*([^;}\n]+)')

# 只放行"本体即圆形"与继承值。药丸形 999px/9999px 不在 DESIGN.md §5 例外清单里，
# 真要用就写 /* ok: 理由 */，不给静默通道。
# v5.5.1：整值匹配。此前只匹配前缀，0.5rem / 08px / "0 0 4px 0" 都从 0 那条缝里漏过去（外部代码审查指出）。
RADIUS_OK = re.compile(r'^\s*(?:0|0px|0%|none|50%|inherit|initial|unset|var\([^)]*\))\s*(?:!important\s*)?$', re.I)


def scan_web(path, allowed, strict):
    try:
        src = open(path, encoding='utf-8', errors='replace').read()
    except Exception:
        return
    rel = os.path.relpath(path, os.getcwd())
    lines = src.splitlines()
    # 注释块（含跨行的 /* */ 与 <!-- -->）换成等量换行，[GLYPH] 只看注释之外——注释里写「» 已退役」是说明不是使用
    _blank = lambda m: '\n' * m.group(0).count('\n')
    code_lines = re.sub(r'/\*.*?\*/|<!--.*?-->', _blank, src, flags=re.S).splitlines()

    # 样式表括号配平（v5.4.1）：多一个或少一个花括号，wxss 的 @import 会整份失败，css 会静默丢掉后面的规则
    if os.path.splitext(path)[1].lower() in ('.css', '.wxss'):
        body = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
        body = re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'', '', body)
        o, c = body.count('{'), body.count('}')
        if o != c:
            fail('SYNTAX', rel, f'花括号不配平：{{ ×{o}，}} ×{c}——多余或缺失的括号会让整份样式表失效')

    # [ONFILL] v5.7.1：有深色模式的文件里，主色 / 危险色填充上写死白字
    if RE_HAS_DARK.search(src):
        for mr in re.finditer(r'\{([^{}]*)\}', src):
            body = mr.group(1)
            if RE_FILL_BG.search(body) and RE_WHITE_FG.search(body):
                ln = src[:mr.start()].count('\n') + 1
                if RE_OK.search(lines[ln - 1] if ln - 1 < len(lines) else ''):
                    continue
                which = RE_FILL_BG.search(body).group(1)
                fail('ONFILL', f'{rel}:{ln}',
                     f'{which} 填充上写死白字——深色模式下压在亮色填充上不够读（亮青 2.11:1 / 危险色 3.53:1），改 var(--on-{which}) / var(--color-on-{which})')

    for i, line in enumerate(lines, 1):
        if line.lstrip().startswith(('*', '//', '<!--')):
            continue
        if RE_OK.search(line):
            continue
        code = code_lines[i - 1] if i - 1 < len(code_lines) else ''
        if RE_GLYPH.search(code) or RE_GLYPH_CSS.search(code):
            fail('GLYPH', f'{rel}:{i}', '» 已随双箭退役（区块前标 / 链接尾标 / 步骤连接符，BRAND.md §4）——层级交给字重与主色，步骤交给编号')
        for mv in RE_VAR_DEF.finditer(code):
            segs = mv.group(1)[2:].lower().split('-')
            if HUE_SEGS & set(segs):
                fail('NAMING', f'{rel}:{i}', f'CSS 变量 {mv.group(1)} 带色相名，改角色名（--primary / --accent / --tint-primary …，palette.json meta.namingRule）')
        # 骨架屏微光是渐变禁令的唯一豁免——标记可能写在上一两行的注释里
        ctx = '\n'.join(lines[max(0, i - 3):i]).lower()

        inline_logo = bool(RE_INLINE_LOGO.search(line))
        for lit, H in colors_in(line):
            if H in allowed or H in NEUTRAL or H in ALLOWED_EXTRA:
                continue
            if inline_logo and H in LOGO_ALLOWED:
                continue   # 内联标志原件里的品牌资产色（含渐变站）合法，裸用仍 FAIL
            shown = lit if lit.startswith('#') else f'{lit} → #{H}'
            (fail if strict else warn)('PALETTE', f'{rel}:{i}', f'色板外色值 {shown}')
        mu = RE_COLOR_FN_UNKNOWN.search(line)
        if mu:
            (fail if strict else warn)('PALETTE', f'{rel}:{i}', f'{mu.group(1)}() 写法闸门不认——色值一律用 token 或色板 hex')

        m = RE_RADIUS.search(line)
        if m and not RADIUS_OK.match(m.group(1)):
            fail('RADIUS', f'{rel}:{i}', f'border-radius: {m.group(1).strip()}（直角制度，例外仅 50% 圆形本体）')

        if RE_BLUR.search(line):
            fail('BLUR', f'{rel}:{i}', 'backdrop-filter 毛玻璃，零豁免')

        if (RE_GRAD.search(line) and not inline_logo
                and 'skeleton' not in ctx and 'shimmer' not in ctx and '骨架' not in ctx):
            fail('GRADIENT', f'{rel}:{i}', 'UI 渐变（例外仅骨架屏微光）')

        ms = RE_SHADOW.search(line)
        if ms:
            val = ms.group(1).strip()
            if 'shadow-sheet' not in val and val not in ('none', 'inherit'):
                fail('SHADOW', f'{rel}:{i}', f'box-shadow: {val[:44]}（阴影仅抽屉 --shadow-sheet 一档）')

    if os.path.splitext(path)[1].lower() in ('.html', '.htm'):
        check_mode_html(path, src)


# ---------------------------------------------------------------- MODE（v5.8 生成层）
# 只验必需槽位、角色、无图 / 纯文本降级与页序，不评审美（COMPOSITION.md §四）。角色与槽位词表只认 composition/roles.json。
from html.parser import HTMLParser

ROLES_PATH = os.path.join(ROOT, 'composition', 'roles.json')
_ROLES = None
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
        'path', 'rect', 'circle', 'line', 'use', 'polyline', 'polygon', 'ellipse', 'stop'}
DEGRADE_FLAGS = [('narrow', 'narrow'), ('images_may_be_blocked', 'no-image'), ('static_frame_seen', 'static'),
                 ('scripted', 'no-js'), ('plain_text', 'plain-text'), ('print', 'print')]


def roles_vocab():
    global _ROLES
    if _ROLES is None:
        try:
            _ROLES = json.load(open(ROLES_PATH, encoding='utf-8'))
        except Exception as e:
            _ROLES = {}
            fail('MODE', os.path.relpath(ROLES_PATH, ROOT), f'读不出角色词表：{e}')
    return _ROLES


class _N:
    __slots__ = ('tag', 'attrs', 'kids', 'text', 'parent')

    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.kids, self.text, self.parent = tag, dict(attrs), [], [], parent


class _Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _N('#root', [], None)
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        n = _N(tag, attrs, self.cur)
        self.cur.kids.append(n)
        if tag not in VOID:
            self.cur = n

    def handle_startendtag(self, tag, attrs):
        self.cur.kids.append(_N(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        n = self.cur
        while n is not self.root and n.tag != tag:
            n = n.parent
        if n is not self.root:
            self.cur = n.parent

    def handle_data(self, data):
        if self.cur.tag not in ('style', 'script'):
            self.cur.kids.append(data)


def _walk(n):
    for k in n.kids:
        if isinstance(k, _N):
            yield k
            yield from _walk(k)


def _text(n):
    out = []
    for k in n.kids:
        if isinstance(k, str):
            out.append(k)
        elif k.tag not in ('svg', 'style', 'script'):
            out.append(_text(k))
    return re.sub(r'\s+', ' ', ''.join(out).replace('\xa0', ' ')).strip()


def _slots_of(region):
    """region 自己的槽位：不往下钻进嵌套的 data-bw-role。"""
    out = []

    def rec(n):
        for k in n.kids:
            if not isinstance(k, _N):
                continue
            if 'data-bw-slot' in k.attrs:
                out.append(k)
            if 'data-bw-role' not in k.attrs:
                rec(k)
    rec(region)
    return out


def _resolve(content, ref):
    node = content
    for part in (ref or '').split('.'):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def _expected_roles(contract_path):
    try:
        c = json.load(open(contract_path, encoding='utf-8'))
        content = {}
        if c.get('content'):
            content = json.load(open(os.path.join(os.path.dirname(contract_path), c['content']), encoding='utf-8'))
        return [pg['role'] for pg in c['narrative'] if not pg.get('when') or _resolve(content, pg['when'])]
    except Exception:
        return None


def check_mode_html(path, src):
    if 'data-bw-role' not in src:
        return
    V = roles_vocab()
    if not V:
        return
    rel = os.path.relpath(path, os.getcwd())
    t = _Tree()
    t.feed(src)
    regions = [n for n in _walk(t.root) if 'data-bw-role' in n.attrs]
    tally = {}
    for r in regions:
        role = r.attrs['data-bw-role']
        where = f'{rel} #{r.attrs.get("id") or role}'
        spec = V['roles'].get(role)
        if not spec:
            fail('MODE', where, f'未知角色 {role}（composition/roles.json 只有 {"/".join(V["roles"])}）')
            continue
        tally[role] = tally.get(role, 0) + 1
        slots = _slots_of(r)
        names = [s.attrs['data-bw-slot'] for s in slots]
        for s, nm in zip(slots, names):
            if nm not in V['slots']:
                fail('MODE', where, f'未知槽位 {nm}')
                continue
            has_graphic = any(k.tag in ('svg', 'img') for k in _walk(s)) or s.tag in ('svg', 'img')
            if not _text(s) and not has_graphic and not s.attrs.get('aria-label', '').strip():
                fail('MODE', where, f'槽位 {nm} 是空的（运行时由脚本填的标志，在槽位上写 aria-label）')
            if nm == 'evidence' and has_graphic:
                alt = (any(k.tag in ('figcaption', 'table') and _text(k) for k in _walk(s))
                       or s.attrs.get('data-bw-alt', '').strip()
                       or any(k.tag == 'img' and k.attrs.get('alt', '').strip() for k in _walk(s)))
                if not alt:
                    fail('MODE', where, '证据是图但没有文字替代（figcaption / table / data-bw-alt）——无图降级后证据整个消失')
        for need in spec.get('required', []):
            if need not in names:
                fail('MODE', where, f'{spec["zh"]}页缺必需槽位 {need}——{spec["rule"]}')
        if spec.get('required_any') and not set(spec['required_any']) & set(names):
            fail('MODE', where, f'{spec["zh"]}页至少要有 {" / ".join(spec["required_any"])} 之一')
        for nm, mx in spec.get('max', {}).items():
            if names.count(nm) > mx:
                fail('MODE', where, f'{spec["zh"]}页 {nm} ×{names.count(nm)}，上限 {mx}——{spec["rule"]}')
        for nm in spec.get('discouraged', []):
            if nm in names:
                warn('MODE', where, f'{spec["zh"]}页里放了 {nm}——它其实是另一种角色？按那种角色标注和验收')

    # 纯文本降级：声明了 data-bw-plain 的块，每个槽位的每个词都要在纯文本版里找得到
    for n in _walk(t.root):
        plain = n.attrs.get('data-bw-plain')
        if not plain:
            continue
        pp = os.path.join(os.path.dirname(path), plain)
        if not os.path.exists(pp):
            fail('MODE', rel, f'声明了纯文本版 {plain}，文件不存在')
            continue
        ptxt = re.sub(r'\s+', ' ', open(pp, encoding='utf-8').read())
        for s in _slots_of(n):
            miss = [w for w in re.split(r'[\s·→｜|]+', _text(s)) if w and w not in ptxt]
            if miss:
                fail('MODE', rel, f'纯文本版缺 {s.attrs["data-bw-slot"]} 的「{" ".join(miss)}」——纯文本降级必须完整')

    # 页序：成品与生成契约一致（契约里 when 不成立的页不计）
    cpath = next((n.attrs.get('data-bw-contract') for n in _walk(t.root) if n.tag == 'html'), None)
    if cpath:
        cands = [os.path.join(os.path.dirname(path), cpath)]
        cands += [os.path.join(dp, cpath) for dp, _, fn in os.walk(os.path.join(ROOT, 'composition')) if cpath in fn]
        cp = next((c for c in cands if os.path.exists(c)), None)
        if not cp:
            fail('MODE', rel, f'声明的生成契约 {cpath} 找不到')
        else:
            want = _expected_roles(cp)
            top = [r.attrs['data-bw-role'] for r in regions if not any('data-bw-role' in a.attrs for a in _ancestors(r))]
            if want is not None and want != top:
                fail('MODE', rel, f'页序与契约不一致：契约 {"→".join(want)}，成品 {"→".join(top)}')
    summary = ' '.join(f'{V["roles"][k]["zh"]}×{v}' for k, v in tally.items())
    print(f'  · {os.path.basename(path)}: 角色 {summary}')


def _ancestors(n):
    p = n.parent
    while p is not None:
        yield p
        p = p.parent


def check_contract(path):
    """生成契约（*.contract.json）：字段形状 + 跨字段规则。"""
    V = roles_vocab()
    if not V:
        return
    rel = os.path.relpath(path, os.getcwd())
    try:
        c = json.load(open(path, encoding='utf-8'))
    except Exception as e:
        fail('MODE', rel, f'契约读不出：{e}')
        return
    for k in ('id', 'status', 'tier', 'task', 'reading', 'media', 'narrative', 'priority', 'degrade', 'adapt'):
        if k not in c:
            fail('MODE', rel, f'契约缺字段 {k}（composition/mode.schema.json）')
    if c.get('task') not in V['tasks']:
        fail('MODE', rel, f'task {c.get("task")} 不在 {"/".join(V["tasks"])} 里')
    if c.get('reading', {}).get('mode') not in V['reading']:
        fail('MODE', rel, f'reading.mode {c.get("reading", {}).get("mode")} 不在 {"/".join(V["reading"])} 里')
    base = os.path.dirname(path)
    content = None
    if c.get('content'):
        cp = os.path.join(base, c['content'])
        if os.path.exists(cp):
            content = json.load(open(cp, encoding='utf-8'))
        else:
            fail('MODE', rel, f'内容文件 {c["content"]} 不存在')
    used = set()
    for i, pg in enumerate(c.get('narrative', []), 1):
        role, slots = pg.get('role'), pg.get('slots', [])
        where = f'{rel} narrative[{pg.get("id", i)}]'
        spec = V['roles'].get(role)
        if not spec:
            fail('MODE', where, f'未知角色 {role}')
            continue
        bad = [s for s in slots if s not in V['slots']]
        if bad:
            fail('MODE', where, '未知槽位 ' + ' '.join(bad))
        for need in spec.get('required', []):
            if need not in slots:
                fail('MODE', where, f'{spec["zh"]}页缺必需槽位 {need}——契约阶段就该补上，不要等成品')
        if spec.get('required_any') and not set(spec['required_any']) & set(slots):
            fail('MODE', where, f'{spec["zh"]}页至少要有 {" / ".join(spec["required_any"])} 之一')
        if content is not None and pg.get('use') and not (pg.get('when') and not _resolve(content, pg['when'])):
            if _resolve(content, pg['use']) is None:
                fail('MODE', where, f'use: {pg["use"]} 在内容文件里找不到')
        used |= set(slots)
    pri = c.get('priority', {})
    p0 = pri.get('P0', [])
    if not p0:
        fail('MODE', rel, 'priority.P0 为空——总得有东西在任何降级下都留下')
    lost = [s for s in p0 if s not in used]
    if lost:
        fail('MODE', rel, 'P0 槽位没有出现在任何一页：' + ' '.join(lost))
    media, deg = c.get('media', {}), c.get('degrade', {})
    for flag, key in DEGRADE_FLAGS:
        if media.get(flag) and key not in deg:
            fail('MODE', rel, f'media.{flag} 为真但没有 degrade["{key}"]——{V["degrade"][key]["test"]}')
    for key, d in deg.items():
        if key not in V['degrade']:
            fail('MODE', rel, f'未知降级 {key}')
            continue
        gone = [s for s in p0 if s not in d.get('keeps', [])]
        if gone:
            fail('MODE', rel, f'降级 {key} 丢了 P0 槽位 {" ".join(gone)}——P0 的意思就是任何降级下都在')
    st = c.get('status')
    if st in ('golden', 'delivered'):
        g = c.get('golden')
        if not g or not os.path.exists(os.path.join(base, g)):
            fail('MODE', rel, f'status={st} 但黄金样张 {g} 不存在')
        if media.get('plain_text'):
            pl = c.get('plain')
            if not pl or not os.path.exists(os.path.join(base, pl)):
                fail('MODE', rel, f'media.plain_text 为真但纯文本版 {pl} 不存在')
    elif st == 'draft' and c.get('golden'):
        warn('MODE', rel, 'status=draft 却写了 golden——有样张就改成 golden')
    print(f'  · {os.path.basename(path)}: {V["tasks"].get(c.get("task"), {}).get("zh", "?")} · '
          f'{len(c.get("narrative", []))} 页 · 降级 {"/".join(deg) or "无"} · {st}')


def check_prose(root, allowed):
    """[PROSE] v5.7：规范文本漂移。v5 换届时机器闸只认色值，散文里的旧口径（墨青写成旧深藏蓝的值、
    「红＝信号系统」、「深蓝主块」、图表色序表停在 v4）没有任何东西拦，一直漏到 v5.6.1。"""
    ok_hex = set(allowed) | LOGO_ALLOWED | NEUTRAL | ALLOWED_EXTRA
    n = 0
    for dirpath, dirs, files in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        top = rel_dir.split(os.sep)[0]
        if top in PROSE_SKIP_DIRS or top in SKIP_DIRS:
            dirs[:] = []
            continue
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            is_md = ext == '.md'
            is_code = (ext in ('.py', '.js') and top in ('tokens', 'templates')) or \
                      (ext == '.html' and top in ('templates', '.'))   # v5.7：页面里的说明文字也是规范的一部分
            if fn in PROSE_SKIP_FILES or not (is_md or is_code):
                continue
            fp = os.path.join(dirpath, fn)
            rel = os.path.relpath(fp, root)
            n += 1
            for i, line in enumerate(open(fp, encoding='utf-8', errors='replace'), 1):
                if RE_OK.search(line) or RE_RELEASE_NOTE.match(line):
                    continue
                clauses = [c for c in RE_CLAUSE.split(line) if not RE_HISTORY.search(c)]
                hit = next((n for c in clauses for n in RETIRED_NAMES if n in c), None)
                if hit:
                    fail('PROSE', f'{rel}:{i}', f'已退役色名「{hit}」写在现行口径里——改现行色名，或在同一分句写明这是历史（退役 / 当时 / 此前…）')
                if is_md:
                    for c in clauses:
                        for h in re.findall(r'#([0-9A-Fa-f]{6})\b|`([0-9A-Fa-f]{6})`', c):
                            h = h[0] or h[1]
                            if h.upper() not in ok_hex:
                                fail('PROSE', f'{rel}:{i}', f'规范文本里的色板外色值 #{h}——改成 palette.json 的现行值，或写明这是历史 / 反例（ok: 理由）')
    print(f'  · 扫过 {n} 份规范文本与 token / 模板源码')


# ---------------------------------------------------------------- main
def check_logo(root):
    """logo/ 走独立白名单。两个方向都要管：
    ① 标志原件里不许混进色板外的杂色（改标时最容易发生）；
    ② 标志青与渐变**不许溢出到 logo/ 之外**——v5 色板的头号规则是「标志青只给标志图形」，
       在此之前这条规则没有任何机器约束，全靠自觉。"""
    d = os.path.join(root, 'logo')
    if not os.path.isdir(d):
        return
    n = 0
    for path in walk(d):
        if os.path.splitext(path)[1].lower() not in WEB_EXT:
            continue
        src = open(path, encoding='utf-8', errors='replace').read()
        bad = {h.upper() for h in re.findall(r'#([0-9A-Fa-f]{6})\b', src)} - LOGO_ALLOWED - NEUTRAL
        if bad:
            fail('LOGO', os.path.relpath(path, root), '标志原件里的色板外色值：' + ' '.join(sorted(bad)))
        n += 1
    print(f'  · 扫过 {n} 个标志原件，渐变与标志青在此目录内合法')


# 标志青作「面色」的合法写法（v5.1）：只许出现在 background / background-color 里，
# 或 token 定义行 --color-field-brand。写进 color / border / stroke / fill / box-shadow = 当前景用 = 溢出。
# 品牌面色的两种合法写法（整段声明剔除后再看剩余部分里还有没有标志青）
RE_TEAL_FIELD = re.compile(r'(?i)(background(?:-color)?\s*:[^;{}]*|--color-field-brand\s*:[^;{}]*)')
TEAL = '7ED1CD'


def check_teal_containment(root, targets):
    """标志青 #7ED1CD 的围栏（v5.1 版）。
    logo/ 之内随便用；logo/ 之外只有两种合法形态：① 内联的标志原件本身（靠 viewBox 签名认）；
    ② **品牌面色**——写在 background / background-color 或 --color-field-brand 里（做底不做字）。
    写进 color / border / stroke / fill 就是把 1.77:1 的青当前景用，照旧 FAIL。
    青面块内的文字对比由 palette.json 的 _contrastPairs 保证（墨字 9.85 / 主色字 5.06），
    但赭石压青只有 2.81、白字压青 1.77——这两条闸门测不到，靠 BRAND.md §2 的用法纪律。"""
    has_teal = lambda text: any(H == TEAL for _, H in colors_in(text))   # 任何写法：hex / rgb() / hsl()
    inlined_logo = RE_INLINE_LOGO
    logo_dir = os.path.join(root, 'logo') + os.sep
    hits = []
    fields = 0
    for target in targets:
        for path in walk(target):
            if os.path.splitext(path)[1].lower() not in WEB_EXT:
                continue
            if os.path.abspath(path).startswith(os.path.abspath(logo_dir)):
                continue
            src = open(path, encoding='utf-8', errors='replace').read()
            for i, line in enumerate(src.splitlines(), 1):
                if not has_teal(line) or RE_OK.search(line) or inlined_logo.search(line):
                    continue
                # 同一行里所有的标志青都必须是面色写法；去掉合法片段后若还剩，就是前景用法
                rest = RE_TEAL_FIELD.sub('', line)
                if has_teal(rest):
                    hits.append(f'{os.path.relpath(path, os.getcwd())}:{i}')
                else:
                    fields += 1
    for h in hits:
        fail('LOGO', h, '标志青 #7ED1CD 当前景用了（color / border / stroke / fill）——它只做标志图形与品牌面色（background），'
                        '文字/线条/描边一律改用 primary #1E5754（BRAND.md §2）')
    if not hits:
        print(f'  · 标志青未当前景用（品牌面色写法 {fields} 处）')


COMP_DIR = os.path.join(ROOT, 'composition')


CASES_PATH = os.path.join(ROOT, 'composition', 'cases', 'case-records.json')
RE_NUMTOK = re.compile(r'\d+(?:[.,]\d+)*')
RE_MONEY = re.compile(r'含税|首报|成交价|付款|[¥￥]\s*\d|\d\s*元|万\s*/\s*月|(?:报价|单价|预算|总价)\s*[:：]?\s*\d|\d[\d.,]*\s*万\s*(?:元|档|预算)')
CASE_TEXT_FIELDS = ('judgement', 'business', 'left_for_next', 'watch_next', 'reuse_note')


def check_cases(mirror):
    """案史派生记录（v5.8.1）：正本是 bywood-proposal 的案例索引。记录里每个数字都要在索引里写有该案名的行中逐字出现；
    不写金额；索引写了对外匿名的案子不许标 public；prev 链要接得上。找不到 skill 目录时只查结构。"""
    if not os.path.exists(CASES_PATH):
        print('  · 没有 composition/cases/，跳过')
        return
    rel = os.path.relpath(CASES_PATH, ROOT)
    try:
        recs = json.load(open(CASES_PATH, encoding='utf-8'))['records']
    except Exception as e:
        fail('CASE', rel, f'读不出：{e}')
        return
    ids = {r.get('id') for r in recs}
    idx_cache = {}
    for r in recs:
        rid = r.get('id', '?')
        where = f'{rel} {rid}'
        for k in ('id', 'index_ref', 'client', 'project', 'span', 'judgement', 'doc_feedback', 'business', 'execution', 'reuse'):
            if k not in r:
                fail('CASE', where, f'缺字段 {k}（composition/case-record.schema.json）')
        ex = r.get('execution') if isinstance(r.get('execution'), dict) else {}
        df = r.get('doc_feedback') if isinstance(r.get('doc_feedback'), dict) else {}
        texts = [r.get(k, '') or '' for k in CASE_TEXT_FIELDS]
        texts += [ex.get(k, '') or '' for k in ('metric', 'value', 'baseline', 'scope')]
        texts.append(df.get('text', '') or '')
        texts = [t for t in texts if isinstance(t, str)]
        for t in texts:
            m = RE_MONEY.search(t)
            if m:
                fail('CASE', where, f'出现金额字样「{m.group(0)}」——合同价、报价、单价、预算只留在案例索引，设计系统里的记录不写')
        if r.get('prev') and r['prev'] not in ids:
            fail('CASE', where, f'prev 指向不存在的记录 {r["prev"]}')
        ref = r.get('index_ref') or {}
        if not mirror:
            continue
        ip = os.path.join(mirror, ref.get('file', ''))
        if ip not in idx_cache:
            idx_cache[ip] = open(ip, encoding='utf-8').read().splitlines() if os.path.exists(ip) else None
        lines = idx_cache[ip]
        if lines is None:
            fail('CASE', where, f'案例索引 {ref.get("file")} 不存在')
            continue
        hit = [ln for ln in lines if ref.get('case') and ref['case'] in ln]
        if not hit:
            fail('CASE', where, f'案例索引里找不到「{ref.get("case")}」')
            continue
        src = '\n'.join(hit)
        miss = sorted({tok for t in texts for tok in RE_NUMTOK.findall(t) if tok not in src})
        if miss:
            fail('CASE', where, '这些数在案例索引里找不到：' + ' '.join(miss) + '——先记进索引，再进记录')
        if r.get('reuse') == 'public' and '匿名' in src:
            fail('CASE', where, '案例索引写了对外匿名，记录却标 public')
    print(f'  · {len(recs)} 条记录' + (f'，数字逐个对过案例索引（{mirror}）' if mirror else '，未找到 skill 目录，只查了结构'))


def check_compose(root):
    """自检：composition/ 下每份契约过 check_contract；status=golden 的再用 compose.py 重生成一遍，与磁盘上的样张逐字比对。"""
    if not os.path.isdir(COMP_DIR):
        print('  · 没有 composition/，跳过')
        return
    paths = sorted(os.path.join(dp, f) for dp, _, fn in os.walk(COMP_DIR) for f in fn if f.endswith('.contract.json'))
    for cp in paths:
        check_contract(cp)
    comp_py = os.path.join(root, 'tools', 'compose.py')
    if not os.path.exists(comp_py):
        return
    import importlib.util
    spec = importlib.util.spec_from_file_location('bw_compose', comp_py)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
        for cp in paths:
            for out, text in mod.build(cp):
                r = os.path.relpath(out, root)
                if not os.path.exists(out) or open(out, encoding='utf-8').read() != text:
                    fail('MODE', r, '黄金样张与契约 / 内容不一致（被手改，或改了内容没重跑）——跑 python3 tools/compose.py')
                else:
                    print(f'  · {r} 与契约一致')
    except Exception as e:
        fail('MODE', 'tools/compose.py', f'重生成失败：{e}')


def walk(target):
    if os.path.isfile(target):
        yield target
        return
    for dirpath, dirnames, filenames in os.walk(target):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            yield os.path.join(dirpath, fn)


def main(argv):
    strict = '--lenient' not in argv   # 默认严格：色板外色值判 FAIL
    targets = [a for a in argv if not a.startswith('--')] or [ROOT]

    p = load_palette()
    allowed = set()
    collect_hexes(p, allowed)
    # docx 白名单窄得多：只有 doc 节那几个色 + 中性，界面轨深色与语义色不许进对客文档
    doc_allowed = {v.upper().lstrip('#') for k, v in p['doc'].items() if not k.startswith('_')}

    print(f'BYWOOD 设计系统机器闸 · palette {p["meta"]["version"]}（{len(allowed)} 个合法色值）')

    print('\n[NAMING] token 命名')
    check_naming(p)

    print('\n[SOURCE] 品牌色来源留痕')
    check_provenance(p)

    print('\n[CONTRAST] 色板自检')
    check_contrast(p)

    if targets == [ROOT]:
        print('\n[SYNC] 派生文件一致性')
        check_sync(p)

        mirror = next((a.split('=', 1)[1] for a in argv if a.startswith('--mirror=')), None)
        if mirror is None:
            mirror = next((c for c in MIRROR_CANDIDATES if os.path.isdir(c)), None)
        print('\n[MIRROR] bywood-proposal skill 镜像')
        if mirror:
            check_mirror(p, mirror)
        else:
            print('  · 未找到 skill 安装目录，跳过（可用 --mirror=<路径> 指定）')

    if targets == [ROOT]:
        print('\n[PROSE] 规范文本漂移')
        check_prose(ROOT, allowed)
        print('\n[TPLVAR] 模板与规范里的内联 token')
        check_template_tokens(ROOT, p)
        print('\n[MODE] 生成契约与黄金样张')
        check_compose(ROOT)
        print('\n[CASE] 案史派生记录')
        check_cases(mirror)

    print('\n[LOGO] 标志原件与标志青围栏')
    if targets == [ROOT]:
        check_logo(ROOT)
    # v5.5.1：围栏对显式目标也跑。此前只在整包自检时跑，业务仓库按文档跑 check-design.py src/ 时，
    # #7ED1CD 因为在色板白名单里被普通扫描放行，color: #7ED1CD 也能过闸（外部代码审查指出）
    check_teal_containment(ROOT, targets)

    print('\n[SCAN] 文件扫描')
    n = 0
    for target in targets:
        for path in walk(target):
            ext = os.path.splitext(path)[1].lower()
            if ext == '.docx':
                scan_docx(path, doc_allowed, strict); n += 1
            elif ext in WEB_EXT:
                scan_web(path, allowed, strict); n += 1
            elif path.endswith('.contract.json') and not (targets == [ROOT] and os.path.abspath(path).startswith(COMP_DIR)):
                check_contract(path); n += 1
    print(f'  · 扫过 {n} 个文件')

    print()
    for kind, path, msg in warns:
        print(f'WARN  [{kind}] {path} — {msg}')
    for kind, path, msg in fails:
        print(f'FAIL  [{kind}] {path} — {msg}')

    if fails:
        print(f'\n✗ {len(fails)} 项不过。改回色板/规范，或让人拍板后同时更新 tokens/palette.json 与本文件的 ALLOWED_EXTRA。')
        return 1
    print(f'\n✓ 全部通过（{len(warns)} 条提示）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
