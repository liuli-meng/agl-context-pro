# -*- coding: utf-8 -*-
"""
注册 / 取消开机自启

用「启动文件夹 + 快捷方式」方案，不需要管理员权限，也不碰注册表。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TRAY = os.path.join(HERE, 'tray.py')
PYW = r'C:\Users\<user>\.workbuddy\binaries\python\envs\default\Scripts\pythonw.exe'
LNK_NAME = 'Antigravity上下文监控.lnk'


def startup_dir():
    return os.path.join(os.environ['APPDATA'],
                        'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')


def lnk_path():
    return os.path.join(startup_dir(), LNK_NAME)


def make_shortcut():
    """通过 WScript.Shell COM 创建快捷方式"""
    import subprocess
    ps = (
        '$ws = New-Object -ComObject WScript.Shell;'
        '$s = $ws.CreateShortcut("{lnk}");'
        '$s.TargetPath = "{exe}";'
        '$s.Arguments = \'"{script}"\';'
        '$s.WorkingDirectory = "{wd}";'
        '$s.Description = "Antigravity 上下文用量托盘监控";'
        '$s.WindowStyle = 7;'
        '$s.Save();'
    ).format(lnk=lnk_path(), exe=PYW, script=TRAY, wd=HERE)

    tmp = os.path.join(HERE, '_mk_lnk.ps1')
    with open(tmp, 'w', encoding='utf-8-sig') as f:
        f.write(ps)
    try:
        r = subprocess.run(
            ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp],
            capture_output=True, text=True, timeout=60)
        return r.returncode == 0, (r.stderr or r.stdout or '').strip()
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass


def enable():
    if not os.path.isfile(PYW):
        return False, '找不到 pythonw.exe: %s' % PYW
    if not os.path.isfile(TRAY):
        return False, '找不到 tray.py: %s' % TRAY
    os.makedirs(startup_dir(), exist_ok=True)
    ok, msg = make_shortcut()
    if ok and os.path.exists(lnk_path()):
        return True, '已设为开机自启：%s' % lnk_path()
    return False, msg or '快捷方式创建失败'


def disable():
    p = lnk_path()
    if os.path.exists(p):
        try:
            os.remove(p)
            return True, '已取消开机自启'
        except Exception as e:
            return False, '删除失败: %s' % e
    return True, '当前未设置开机自启'


def status():
    p = lnk_path()
    return os.path.exists(p), p


if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if action == 'enable':
        ok, msg = enable()
    elif action == 'disable':
        ok, msg = disable()
    else:
        exists, p = status()
        ok, msg = True, ('已启用：%s' % p) if exists else '未启用'
    print(('[OK] ' if ok else '[失败] ') + msg)
    sys.exit(0 if ok else 1)
