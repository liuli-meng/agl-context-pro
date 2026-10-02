# -*- coding: utf-8 -*-
"""
把 Antigravity 的注册表卸载项版本号对齐到主程序实际版本，
消除「更新器认为自己是旧版、每轮都弹更新失败」的问题。

背景：junction 环境下 NSIS 卸载器清理失败，会留下不完整的注册表项。
某次更新把文件换成了 2.19.1，但注册表仍旧记着 2.18.1，导致
electron-updater 每轮都判定「该升级」，于是反复弹框。

用法：
    python fix-registry-version.py            # 只报告
    python fix-registry-version.py --apply     # 实际写入
"""
import re
import sys
import winreg

KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\121a0be4-63bd-531e-acf8-fc3924c7e984'
EXE = r'D:\Antigravity\app\Antigravity.exe'
APPLY = '--apply' in sys.argv


def exe_version(path):
    """从 exe 的 VS_VERSIONINFO 里抠版本（UTF-16LE）"""
    with open(path, 'rb') as f:
        u = f.read().decode('utf-16-le', errors='ignore')
    hits = re.findall(r'2\.\d+\.\d+', u)
    return max(set(hits), key=hits.count) if hits else None


def main():
    target = exe_version(EXE)
    print('主程序实际版本 :', target or '(读不到)')
    if not target:
        print('无法确定目标版本，中止。')
        return 1

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, KEY, 0, winreg.KEY_READ) as h:
        cur_name = winreg.QueryValueEx(h, 'DisplayName')[0]
        cur_ver = winreg.QueryValueEx(h, 'DisplayVersion')[0]

    print('注册表 DisplayName    :', cur_name)
    print('注册表 DisplayVersion :', cur_ver)
    print()

    if cur_ver == target:
        print('已一致，无需修改。')
        return 0

    new_name = re.sub(r'\d+\.\d+\.\d+', target, cur_name)
    print('将要修改：')
    print('  DisplayName     : %s  ->  %s' % (cur_name, new_name))
    print('  DisplayVersion  : %s  ->  %s' % (cur_ver, target))
    print()

    if not APPLY:
        print('（未加 --apply，仅报告，未写入）')
        return 0

    # 备份一份原值，便于回退
    import json, time, os
    bak = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       'reg-backup-%s.json' % time.strftime('%Y%m%d%H%M%S'))
    with open(bak, 'w', encoding='utf-8') as f:
        json.dump({'DisplayName': cur_name, 'DisplayVersion': cur_ver}, f,
                  ensure_ascii=False, indent=1)
    print('原值已备份 ->', bak)

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, KEY, 0, winreg.KEY_SET_VALUE) as h:
        winreg.SetValueEx(h, 'DisplayName', 0, winreg.REG_SZ, new_name)
        winreg.SetValueEx(h, 'DisplayVersion', 0, winreg.REG_SZ, target)

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, KEY, 0, winreg.KEY_READ) as h:
        print()
        print('写入后 DisplayName    :', winreg.QueryValueEx(h, 'DisplayName')[0])
        print('写入后 DisplayVersion :', winreg.QueryValueEx(h, 'DisplayVersion')[0])
    print()
    print('完成。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
