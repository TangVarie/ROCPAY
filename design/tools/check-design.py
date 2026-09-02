#!/usr/bin/env python3
"""BYWOOD 设计系统机器闸 · v3.0

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
    [PALETTE]  文件里出现色板外色值
    [FIG]      docx 里每张图之后紧跟的那一段必须含「来源｜」（模板 v5.1 起图只走 FIG()，
               来源行是构件的一部分；缺 = 手写版式绕过了模板，负面清单「无来源行的图」）。
               默认 FAIL，--lenient 降为提示（已交付旧版带图文档探查用）
    [RADIUS]   border-radius 非 0（例外：50% 圆形本体、系统件）
    [BLUR]     backdrop-filter（毛玻璃，零豁免）
    [GRADIENT] UI 渐变（例外：骨架屏微光）
    [SHADOW]   box-shadow（例外：抽屉 --shadow-sheet）
    [CONTRAST] palette.json 自身的关键配色对比度是否达标
    [LOGO]     标志原件走独立白名单；标志青在 logo/ 之外只许做品牌面色（background），
               当前景（color / border / stroke / fill）即 FAIL（v5.1 起）

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
}


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

    # 3. miniprogram.wxss：亮色 hex token 逐值比对
    wx = os.path.join(ROOT, 'tokens', 'miniprogram.wxss')
    if os.path.exists(wx):
        src = open(wx, encoding='utf-8').read()
        for key, var in CSS_VAR.items():
            want = p['screen']['light'].get(key, '')
            if not want.startswith('#'):
                continue
            m = re.search(re.escape(var) + r':\s*(#[0-9A-Fa-f]{3,8})\s*;', src)
            if m and m.group(1).upper() != want.upper():
                fail('SYNC', 'tokens/miniprogram.wxss',
                     f'{var} = {m.group(1)}，palette.json 是 {want}')

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
RE_SOURCE_LINE = re.compile(r'来源[｜|]')


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
    # 文本框（drawing 里的 txbxContent）内的段落不算版面段落，先剔除
    nested = set()
    for d in root.iter(DRAWING):
        for p in d.iter(P):
            nested.add(id(p))
    paras = [p for p in root.iter(P) if id(p) not in nested]
    missing = []
    n_fig = 0
    for i, p in enumerate(paras):
        if p.find(f'.//{DRAWING}') is None:
            continue
        n_fig += 1
        nxt = paras[i + 1] if i + 1 < len(paras) else None
        text = ''.join(t.text or '' for t in nxt.iter(T)) if nxt is not None else ''
        if not RE_SOURCE_LINE.search(text):
            missing.append(n_fig)
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


# ---------------------------------------------------------------- web
RE_HEX = re.compile(r'#([0-9A-Fa-f]{6})\b')
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
RADIUS_OK = re.compile(r'^\s*(0|0px|0%|none|50%|inherit|initial|var\()')


def scan_web(path, allowed, strict):
    try:
        src = open(path, encoding='utf-8', errors='replace').read()
    except Exception:
        return
    rel = os.path.relpath(path, os.getcwd())
    lines = src.splitlines()

    for i, line in enumerate(lines, 1):
        if line.lstrip().startswith(('*', '//', '<!--')):
            continue
        if RE_OK.search(line):
            continue
        # 骨架屏微光是渐变禁令的唯一豁免——标记可能写在上一两行的注释里
        ctx = '\n'.join(lines[max(0, i - 3):i]).lower()

        inline_logo = bool(RE_INLINE_LOGO.search(line))
        for h in RE_HEX.findall(line):
            H = h.upper()
            if H in allowed or H in NEUTRAL or H in ALLOWED_EXTRA:
                continue
            if inline_logo and H in LOGO_ALLOWED:
                continue   # 内联标志原件里的品牌资产色（含渐变站）合法，裸用仍 FAIL
            (fail if strict else warn)('PALETTE', f'{rel}:{i}', f'色板外色值 #{h}')

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
RE_TEAL_FIELD = re.compile(r'(?i)(background(?:-color)?\s*:[^;{}]*#7ED1CD|--color-field-brand\s*:\s*#7ED1CD)')


def check_teal_containment(root, targets):
    """标志青 #7ED1CD 的围栏（v5.1 版）。
    logo/ 之内随便用；logo/ 之外只有两种合法形态：① 内联的标志原件本身（靠 viewBox 签名认）；
    ② **品牌面色**——写在 background / background-color 或 --color-field-brand 里（做底不做字）。
    写进 color / border / stroke / fill 就是把 1.77:1 的青当前景用，照旧 FAIL。
    青面块内的文字对比由 palette.json 的 _contrastPairs 保证（墨字 9.85 / 主色字 5.06），
    但赭石压青只有 2.81、白字压青 1.77——这两条闸门测不到，靠 BRAND.md §2 的用法纪律。"""
    teal = re.compile(r'#7ED1CD\b', re.I)
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
                if not teal.search(line) or RE_OK.search(line) or inlined_logo.search(line):
                    continue
                # 同一行里所有的 #7ED1CD 都必须是面色写法；去掉合法片段后若还剩，就是前景用法
                rest = RE_TEAL_FIELD.sub('', line)
                if teal.search(rest):
                    hits.append(f'{os.path.relpath(path, root)}:{i}')
                else:
                    fields += 1
    for h in hits:
        fail('LOGO', h, '标志青 #7ED1CD 当前景用了（color / border / stroke / fill）——它只做标志图形与品牌面色（background），'
                        '文字/线条/描边一律改用 primary #1E5754（BRAND.md §2）')
    if not hits:
        print(f'  · 标志青未当前景用（品牌面色写法 {fields} 处）')


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
        print('\n[LOGO] 标志原件与标志青围栏')
        check_logo(ROOT)
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
