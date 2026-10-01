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
from agl_ls import TokenInfo, LanguageServer, find_ls_binary  # noqa: E402

APP_NAME = 'Antigravity 上下文'
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'last_reading.json')

# 配色
C_TRACK = (68, 72, 82)
C_IDLE = (86, 156, 214)       # 蓝：正常
C_WARN = (214, 157, 86)       # 橙：偏高
C_DANGER = (214, 96, 96)      # 红：接近上限


# ---------------------------------------------------------------- 图标绘制

def _state_color(percent, warn=65.0, danger=85.0):
    if percent >= danger:
        return C_DANGER
    if percent >= warn:
        return C_WARN
    return C_IDLE


def _ring_icon(percent, size=64, warn=65.0, danger=85.0):
    """托盘图标：外环进度 + 中心实心点。

    Windows 托盘实际渲染尺寸是 16×16，中心放文字必然糊，
    所以改为纯图形表达：
      - 外环弧长  = 上下文占用比例（0~100%）
      - 中心实心点 = 状态色（蓝=正常 / 橙=偏高 / 红=危险）
    具体数值看悬停提示。
    """
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    color = _state_color(percent, warn, danger)

    pad = 4
    width = 8
    box = (pad, pad, size - pad, size - pad)

    # 底环（留一点缺口更易辨识起点）
    d.arc(box, start=0, end=360, fill=C_TRACK, width=width)
    # 进度环：从 12 点顺时针
    if percent > 0:
        end = -90 + 360.0 * min(percent, 100.0) / 100.0
        d.arc(box, start=-90, end=end, fill=color, width=width)

    # 中心实心点
    r = size * 0.20
    cx = cy = size / 2.0
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
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
            with open(CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump({'stamp': self.stamp, 'raw': self.info.raw}, f,
                          ensure_ascii=False)
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
    icon.icon = _ring_icon(info.percent)
    when = time.strftime('%H:%M:%S', time.localtime(STATE.stamp)) if STATE.stamp else '—'
    lines = [
        APP_NAME,
        '已用 %d / %d tokens' % (info.total, info.budget),
        '占用 %.1f%%   剩余 %d' % (info.percent, info.remaining),
    ]
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
    text = build_detail_text()
    try:
        _show_popup(text)
    except Exception:
        _show_messagebox(text)


def _show_popup(text):
    """用 tkinter 弹一个可复制的文本框，比 messagebox 好用。"""
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
        pystray.MenuItem('立即刷新', on_refresh, default=True),
        pystray.MenuItem('查看明细', show_detail),
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
