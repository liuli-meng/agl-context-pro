# -*- coding: utf-8 -*-
"""
Antigravity 上下文用量托盘监控

托盘图标 = 环形进度条，直观显示上下文预算占用率。
- 悬停：显示 已用/上限 与百分比
- 双击 / 菜单「立即刷新」：重新查询
- 菜单「查看明细」：展开 Rules / Skills 逐项 token 占用

数据来源：GetTokenBase（Antigravity Language Server）
查询方式：按需拉起 LS，查完即退，不常驻、不占用后台内存。
"""
import os
import sys
import time
import json
import threading
import traceback

from PIL import Image, ImageDraw

try:
    import pystray
except ImportError:
    sys.exit('缺少依赖，请先安装：pip install pystray pillow')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agl_ls import (TokenInfo, LanguageServer, find_ls_binary,  # noqa: E402
                    fetch_conversation)

APP_NAME = 'Antigravity 上下文'
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'last_reading.json')

# 配色
C_TRACK = (68, 72, 82)
C_IDLE = (86, 156, 214)       # 蓝：正常
C_WARN = (214, 157, 86)       # 橙：偏高
C_DANGER = (214, 96, 96)      # 红：接近上限

# 卡片 UI 配色（浅色卡片，仿 DeepSeek/ZCode 用量面板）
UI_BG = '#ffffff'
UI_FG = '#1f2329'
UI_SUB = '#8a9099'
UI_TRACK = '#e9ebef'
UI_SYS = '#9aa3ad'            # 系统提示词 - 灰
UI_TOOL = '#8b7cf6'           # 工具定义 - 紫
UI_CONV = '#3b82f6'           # 对话消息 - 蓝
UI_RULE = '#10b981'           # Rules/Skills 自定义内容 - 绿

# 模型 id → 友好名（与 GetCascadeModelConfigData 对齐）
MODEL_NAMES = {
    'MODEL_PLACEHOLDER_M318': 'Gemini 3.8 Flash (High)',
    'MODEL_PLACEHOLDER_M319': 'Gemini 3.8 Flash (Med)',
    'MODEL_PLACEHOLDER_M320': 'Gemini 3.8 Flash (Low)',
    'MODEL_PLACEHOLDER_M298': 'Gemini 3.7 Flash (High)',
    'MODEL_PLACEHOLDER_M299': 'Gemini 3.7 Flash (Med)',
    'MODEL_PLACEHOLDER_M300': 'Gemini 3.7 Flash (Low)',
    'MODEL_PLACEHOLDER_M71': 'Gemini 3.6 Flash (High)',
    'MODEL_PLACEHOLDER_M72': 'Gemini 3.6 Flash (Med)',
    'MODEL_PLACEHOLDER_M73': 'Gemini 3.6 Flash (Low)',
    'MODEL_PLACEHOLDER_M16': 'Gemini 3.1 Pro (High)',
    'MODEL_PLACEHOLDER_M36': 'Gemini 3.1 Pro (Low)',
    'MODEL_PLACEHOLDER_M35': 'Claude Sonnet 4.6',
    'MODEL_PLACEHOLDER_M26': 'Claude Opus 4.6',
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 'GPT-OSS 120B',
}


def model_name(mid):
    if not mid:
        return '—'
    return MODEL_NAMES.get(mid, mid.replace('MODEL_PLACEHOLDER_', 'Gemini '))


# ---------------------------------------------------------------- 图标绘制

def _state_color(percent, warn=65.0, danger=85.0):
    if percent >= danger:
        return C_DANGER
    if percent >= warn:
        return C_WARN
    return C_IDLE


def _ring_icon(percent, size=64, warn=65.0, danger=85.0):
    """托盘图标：圆环进度（DeepSeek/ZCode 同款思路）。

    托盘实际渲染 16×16，任何数字都会糊成一团，所以中心不放文字——
    精确百分比放在悬停提示和「查看上下文用量」卡片里。
    环的颜色反映状态：蓝=正常 / 橙=偏高 / 红=接近上限。
    """
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    color = _state_color(percent, warn, danger)

    pad = 6
    width = 9
    box = (pad, pad, size - pad, size - pad)
    # 底环
    d.arc(box, start=0, end=360, fill=C_TRACK, width=width)
    # 进度环：从 12 点顺时针
    if percent > 0:
        end = -90 + 360.0 * min(percent, 100.0) / 100.0
        d.arc(box, start=-90, end=end, fill=color, width=width)
    else:
        # 0% 时画一个小的起始标记，表明程序在工作
        d.arc(box, start=-90, end=-70, fill=color, width=width)
    return img


def _error_icon(size=64):
    """查询失败：灰色环 + 中心橙点，并在环上留缺口表示异常。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad, width = 4, 8
    box = (pad, pad, size - pad, size - pad)
    d.arc(box, start=-70, end=250, fill=C_TRACK, width=width)
    r = size * 0.20
    cx = cy = size / 2.0
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=C_WARN)
    return img


# ---------------------------------------------------------------- 状态

class State:
    def __init__(self):
        self.info = None
        self.conv = None          # ConversationUsage：当前会话对话用量
        self.error = None
        self.stamp = 0.0
        self.elapsed = None
        self.busy = False

    def load_cache(self):
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                raw = json.load(f)
            self.info = TokenInfo(raw.get('raw', {}))
            self.stamp = raw.get('stamp', 0)
        except Exception:
            pass

    def save_cache(self):
        if not self.info:
            return
        try:
            data = {'stamp': self.stamp, 'raw': self.info.raw}
            if self.conv and self.conv.ok:
                data['conversation'] = {
                    'summary': self.conv.summary,
                    'model': self.conv.model,
                    'inputTokens': self.conv.input_tokens,
                    'outputTokens': self.conv.output_tokens,
                    'limit': self.conv.limit,
                }
            with open(CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False)
        except Exception:
            pass


STATE = State()
ERROR_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tray_error.log')


def log_error(text):
    """把异常/错误落盘。pythonw 无控制台,不落盘就永远看不到原因。"""
    try:
        with open(ERROR_LOG, 'a', encoding='utf-8') as f:
            f.write(time.strftime('[%Y-%m-%d %H:%M:%S]\n') + text.rstrip() + '\n\n')
    except Exception:
        pass


# ---------------------------------------------------------------- 查询

def do_query(icon=None, notify=False):
    """跑一次真实查询。会在后台线程里被调用。

    优先复用正在运行的 LS 实例（毫秒级）；Antigravity 没开时才自己拉一个。
    一次连接里同时取「自定义内容预算」(GetTokenBase) 和「当前对话用量」。
    """
    if STATE.busy:
        return
    STATE.busy = True
    t0 = time.time()
    try:
        with LanguageServer(startup_timeout=90) as ls:
            raw = ls.json('GetTokenBase')
            reused = ls.reused
        info = TokenInfo(raw)
        info.reused = reused
        STATE.info = info
        STATE.error = None
        STATE.stamp = time.time()
        STATE.elapsed = time.time() - t0
        STATE.save_cache()
    except Exception as e:
        STATE.error = str(e)
        log_error('查询失败: %s' % traceback.format_exc())
    finally:
        STATE.busy = False
        if icon is not None:
            refresh_icon(icon)
        if notify:
            _notify(icon)
    # 对话用量单独查一次（复用同一 LS，失败静默）
    try:
        STATE.conv = fetch_conversation()
    except Exception:
        log_error('对话用量查询失败: %s' % traceback.format_exc())


def _notify(icon):
    if not icon:
        return
    try:
        if STATE.error:
            icon.notify('查询失败：%s' % STATE.error[:120], APP_NAME)
        elif STATE.info:
            src = '复用实例' if STATE.info.reused else '新建实例'
            icon.notify('上下文已用 %d / %d tokens（%.1f%%）· %s %.0fms'
                        % (STATE.info.total, STATE.info.budget,
                           STATE.info.percent, src,
                           (STATE.elapsed or 0) * 1000),
                        APP_NAME)
    except Exception:
        pass


def query_async(icon=None, notify=False):
    threading.Thread(target=do_query, args=(icon, notify), daemon=True).start()


def refresh_icon(icon):
    """按当前状态重绘图标与提示文字。"""
    if STATE.error and not STATE.info:
        icon.icon = _error_icon()
        icon.title = '%s\n查询失败：%s' % (APP_NAME, STATE.error[:160])
        return
    if not STATE.info:
        icon.icon = _ring_icon(0)
        icon.title = '%s\n尚未获取数据，右键选择「立即刷新」' % APP_NAME
        return

    info = STATE.info
    conv = STATE.conv
    # 图标百分比：优先用对话模型窗口（更贴近截图的总量视角），
    # 拿不到对话数据时回退到自定义预算占比
    if conv and conv.ok and conv.limit:
        used = 1500 + 5600 + conv.used
        pct = 100.0 * used / conv.limit
        cap_txt = '%d/%dK' % (used / 1000.0, conv.limit / 1000.0)
    else:
        pct = info.percent
        cap_txt = '%d/%d' % (info.total, info.budget)

    icon.icon = _ring_icon(pct)

    when = time.strftime('%H:%M:%S', time.localtime(STATE.stamp)) if STATE.stamp else '—'
    lines = [APP_NAME]
    if conv and conv.ok and conv.limit:
        lines.append('上下文已用 %.0f%%   %s' % (pct, cap_txt))
        lines.append('对话 %d / %d tokens（%s）'
                     % (conv.used, conv.limit, model_name(conv.model)))
        lines.append('  新增 %d + 缓存 %d'
                     % (conv.input_tokens, conv.cache_read_tokens))
    else:
        lines.append('已用 %d / %d tokens' % (info.total, info.budget))
        lines.append('占用 %.1f%%   剩余 %d' % (info.percent, info.remaining))
        if conv and conv.error:
            lines.append('（对话用量：%s）' % conv.error[:40])
    if info.truncated:
        lines.append('⚠ 已发生截断')
    if info.groups:
        lines.append('')
        for g in info.groups:
            lines.append('  %s：%d' % (g.get('name', '?'), g.get('numTokens', 0)))
    lines.append('')
    lines.append('更新于 %s' % when)
    if STATE.elapsed is not None and info.reused is not None:
        src = '复用实例' if info.reused else '新建实例'
        lines.append('%s · %.0f ms' % (src, STATE.elapsed * 1000))
    if STATE.busy:
        lines.append('（正在刷新…）')
    icon.title = '\n'.join(lines)


# ---------------------------------------------------------------- 菜单

def build_detail_text():
    if not STATE.info:
        return '暂无数据'
    info = STATE.info
    out = ['上下文用量   %d / %d tokens（%.1f%%）'
           % (info.total, info.budget, info.percent),
           '剩余预算     %d' % info.remaining,
           '规则预算     %d（剩余 %d）' % (info.rules_budget, info.rules_remaining)]
    if STATE.stamp:
        when = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(STATE.stamp))
        src = ''
        if STATE.elapsed is not None and info.reused is not None:
            src = '（%s %.0f ms）' % ('复用实例' if info.reused else '新建实例',
                                     STATE.elapsed * 1000)
        out.append('读取时间     %s %s' % (when, src))
    out.append('')
    for g in info.groups:
        out.append('【%s】小计 %d' % (g.get('name', '?'), g.get('numTokens', 0)))
        for ch in (g.get('children') or []):
            name = ch.get('name', '?')
            out.append('    %6d   %s' % (ch.get('numTokens', 0), name))
        out.append('')
    if info.truncated:
        out.append('⚠ 部分自定义内容已被截断')
    return '\n'.join(out)


def show_detail(icon, item):
    """菜单「查看明细」：打开卡片式 UI。"""
    try:
        _show_card()
    except Exception:
        log_error('卡片 UI 打开失败: %s' % traceback.format_exc())
        try:
            _show_messagebox(build_detail_text())
        except Exception:
            pass


def _show_card():
    """卡片式用量面板（仿 DeepSeek / ZCode 上下文用量 UI）。

    组成：标题行（已用百分比 + 总量/上限）→ 堆叠彩条 → 分类图例明细。
    用 tkinter Canvas 手绘，无第三方依赖。
    """
    import tkinter as tk

    W = 380
    PAD = 22
    win = tk.Tk()
    win.title(APP_NAME)
    win.configure(bg=UI_BG)
    win.attributes('-topmost', True)
    win.resizable(False, False)

    # 关闭边框、圆角观感（Win 上尽量素雅）
    try:
        win.overrideredirect(False)
    except Exception:
        pass

    canvas = tk.Canvas(win, width=W, height=260, bg=UI_BG,
                       highlightthickness=0, bd=0)
    canvas.pack(fill='both', expand=True)

    info = STATE.info
    conv = STATE.conv

    # ------------------ 计算三段数据 ------------------
    # 系统提示词 / 工具定义：LS 未把这两项单独拆出来（它们混在输入里），
    # 用固定开销近似（截图上那两条 ~1.5K / ~5.6K 即此类）。
    SYS_TOK = 1500
    TOOL_TOK = 5600
    # 对话消息 = 当前会话真实上下文（新增输入 + 缓存读取）
    conv_tok = conv.used if (conv and conv.ok) else 0

    limit = (conv.limit if (conv and conv.ok and conv.limit)
             else (info.budget if info else 20000))
    total = SYS_TOK + TOOL_TOK + conv_tok
    pct = (100.0 * total / limit) if limit else 0.0

    y = PAD
    # ------------------ 标题行 ------------------
    canvas.create_text(PAD, y + 4, anchor='nw', text='上下文已用',
                       fill=UI_SUB, font=('Microsoft YaHei UI', 11))
    canvas.create_text(PAD + 78, y - 2, anchor='nw', text='%d%%' % round(pct),
                       fill=UI_FG, font=('Microsoft YaHei UI', 17, 'bold'))
    if limit >= 1000000:
        cap = '~%.1fM / %.0fM' % (total / 1e6, limit / 1e6)
    elif limit >= 1000:
        cap = '~%.0fK / %.0fK' % (total / 1000.0, limit / 1000.0)
    else:
        cap = '~%d / %d' % (total, limit)
    canvas.create_text(W - PAD, y + 4, anchor='ne', text=cap,
                       fill=UI_FG, font=('Microsoft YaHei UI', 11, 'bold'))

    y += 34
    # ------------------ 堆叠彩条 ------------------
    bar_h = 10
    bar_y = y
    # 底槽
    canvas.create_rectangle(PAD, bar_y, W - PAD, bar_y + bar_h,
                            fill=UI_TRACK, outline='')
    segs = [('sys', SYS_TOK, UI_SYS), ('tool', TOOL_TOK, UI_TOOL),
            ('conv', conv_tok, UI_CONV),
            ('rule', (info.total if info else 0), UI_RULE)]
    denom = limit if limit else 1
    x = PAD
    inner_w = W - 2 * PAD
    for key, tok, color in segs:
        if tok <= 0:
            continue
        w = inner_w * (tok / float(denom))
        w = min(w, W - PAD - x)
        if w <= 0:
            continue
        canvas.create_rectangle(x, bar_y, x + w, bar_y + bar_h,
                                fill=color, outline='')
        x += w

    y = bar_y + bar_h + 20
    # ------------------ 明细行 ------------------
    def fmt(t):
        if t >= 1000:
            return '~%.1fK' % (t / 1000.0)
        return '~%d' % t

    rows = [
        ('系统提示词', SYS_TOK, UI_SYS),
        ('工具定义', TOOL_TOK, UI_TOOL),
        ('对话消息', conv_tok, UI_CONV),
    ]
    if info and info.total:
        rows.append(('Rules / Skills', info.total, UI_RULE))

    for label, tok, color in rows:
        canvas.create_rectangle(PAD, y + 3, PAD + 10, y + 13,
                                fill=color, outline='')
        canvas.create_text(PAD + 18, y, anchor='nw', text=label,
                           fill=UI_FG, font=('Microsoft YaHei UI', 11))
        canvas.create_text(W - PAD, y, anchor='ne', text=fmt(tok),
                           fill=UI_FG, font=('Microsoft YaHei UI', 11))
        y += 26

    # ------------------ 底部信息 ------------------
    y = max(y + 4, 232)
    if conv and conv.ok and conv.summary:
        model = model_name(conv.model)
        canvas.create_text(PAD, y, anchor='nw',
                           text='会话：%s' % conv.summary[:26],
                           fill=UI_SUB, font=('Microsoft YaHei UI', 9))
        y += 16
        canvas.create_text(PAD, y, anchor='nw',
                           text='模型：%s   步数：%d%s'
                                % (model, conv.step_count,
                                   '   ⚠ 已压缩' if conv.compressed else ''),
                           fill=UI_SUB, font=('Microsoft YaHei UI', 9))
    elif conv and conv.error:
        canvas.create_text(PAD, y, anchor='nw', text=conv.error[:42],
                           fill=UI_SUB, font=('Microsoft YaHei UI', 9))
    else:
        canvas.create_text(PAD, y, anchor='nw',
                           text='对话用量暂不可用（需 Antigravity 运行中）',
                           fill=UI_SUB, font=('Microsoft YaHei UI', 9))

    win.update_idletasks()
    h = int(canvas.bbox('all')[3]) + PAD
    canvas.configure(height=h)
    win.geometry('%dx%d' % (W, h))

    # 居中显示在屏幕偏右下（贴近托盘）
    win.update_idletasks()
    sw = win.winfo_screenwidth()
    sh = win.winfo_screenheight()
    win.geometry('%dx%d+%d+%d' % (W, h, sw - W - 40, sh - h - 80))

    win.mainloop()


def _show_popup(text):
    """纯文本弹窗（备用）。"""
    import tkinter as tk
    from tkinter import scrolledtext

    win = tk.Tk()
    win.title(APP_NAME + ' — 明细')
    win.geometry('620x460')
    win.attributes('-topmost', True)

    txt = scrolledtext.ScrolledText(win, wrap='none', font=('Consolas', 10))
    txt.pack(fill='both', expand=True, padx=8, pady=8)
    txt.insert('1.0', text)

    def copy_all():
        win.clipboard_clear()
        win.clipboard_append(text)
        btn.config(text='已复制')

    btn = tk.Button(win, text='复制全部', command=copy_all)
    btn.pack(pady=(0, 8))
    win.mainloop()


def _show_messagebox(text):
    import ctypes
    ctypes.windll.user32.MessageBoxW(0, text, APP_NAME + ' — 明细', 0x40)


def on_refresh(icon, item):
    query_async(icon, notify=True)


def on_copy(icon, item):
    try:
        import tkinter as tk
        r = tk.Tk()
        r.withdraw()
        r.clipboard_clear()
        r.clipboard_append(build_detail_text())
        r.update()
        r.destroy()
    except Exception:
        pass


def on_open_folder(icon, item):
    os.startfile(os.path.dirname(os.path.abspath(__file__)))


def on_quit(icon, item):
    icon.stop()


# ---------------------------------------------------------------- 入口

def main():
    if not find_ls_binary():
        sys.exit('找不到 language_server.exe。\n'
                 '请设置环境变量 AGL_LS_PATH 指向该文件。')

    STATE.load_cache()

    menu = pystray.Menu(
        pystray.MenuItem('查看上下文用量', show_detail, default=True),
        pystray.MenuItem('立即刷新', on_refresh),
        pystray.MenuItem('复制到剪贴板', on_copy),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('打开程序目录', on_open_folder),
        pystray.MenuItem('退出', on_quit),
    )

    icon = pystray.Icon(APP_NAME, _ring_icon(0), APP_NAME, menu)
    refresh_icon(icon)

    # 启动即弹气泡:图标可能被 Win10 收进任务栏溢出区(^),气泡是"程序活着"的信号
    threading.Thread(target=_startup_notify, args=(icon,), daemon=True).start()
    # 启动后台做一次静默刷新,不阻塞托盘显示
    threading.Thread(target=_initial_query, args=(icon,), daemon=True).start()

    icon.run()


def _startup_notify(icon):
    time.sleep(1.5)
    try:
        icon.notify('监控已启动。若任务栏没看到图标，请点右下角 ^ 展开。', APP_NAME)
    except Exception:
        pass


def _initial_query(icon):
    time.sleep(1.0)
    do_query(icon, notify=False)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # pythonw 下 stdout/stderr 是 None,print_exc 会二次异常;必须落盘
        try:
            err = traceback.format_exc()
        except Exception:
            err = 'unknown error'
        log_error(err)
        sys.exit(1)
