#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
建 GitHub Release 并上传 VSIX。

为什么不用 gh CLI / git push --tags：
  本机 github.com 的 git/https 通道时通时断，而 api.github.com 稳定可达。
  token 从 Windows 凭据管理器读（ctypes CredReadW），**不落盘、不进 argv、不打印**。

用法：
  python tools/gh-release.py --tag v0.3.1 --file releases/agl-context-pro-0.3.1.vsix
  python tools/gh-release.py --tag v0.3.1 --check     # 只查状态
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = os.environ.get('GH_REPO', 'liuli-meng/agl-context-pro')
CRED_TARGET = 'git:https://github.com'
API = 'https://api.github.com'

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def log(*a):
    print(*a, flush=True)


class CREDENTIAL(ctypes.Structure):
    _fields_ = [
        ('Flags', wt.DWORD),
        ('Type', wt.DWORD),
        ('TargetName', wt.LPWSTR),
        ('Comment', wt.LPWSTR),
        ('LastWritten', ctypes.c_ubyte * 8),
        ('CredentialBlobSize', wt.DWORD),
        ('CredentialBlob', ctypes.POINTER(ctypes.c_ubyte)),
        ('Persist', wt.DWORD),
        ('AttributeCount', wt.DWORD),
        ('Attributes', ctypes.c_void_p),
        ('TargetAlias', wt.LPWSTR),
        ('UserName', wt.LPWSTR),
    ]


def read_token():
    """从凭据管理器读 github token（返回 (user, token)）。"""
    advapi32 = ctypes.WinDLL('advapi32', use_last_error=True)
    advapi32.CredReadW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD,
                                   ctypes.POINTER(ctypes.POINTER(CREDENTIAL))]
    advapi32.CredReadW.restype = wt.BOOL
    pcred = ctypes.POINTER(CREDENTIAL)()
    if not advapi32.CredReadW(CRED_TARGET, 1, 0, ctypes.byref(pcred)):  # 1 = CRED_TYPE_GENERIC
        raise RuntimeError('凭据管理器里没有 %s（CredReadW 失败 %d）'
                           % (CRED_TARGET, ctypes.get_last_error()))
    c = pcred.contents
    blob = ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize)
    token = blob.decode('utf-16-le')
    return c.UserName or '', token


def api(token, method, path, body=None, raw=None, ctype='application/json'):
    url = path if path.startswith('http') else API + path
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': ctype,
        'User-Agent': 'agl-context-pro-release',
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = r.read()
            try:
                return r.status, json.loads(payload)
            except Exception:
                return r.status, payload
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode('utf-8', 'replace')
        return e.code, body_txt
    except Exception as e:
        return 0, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tag', required=True)
    ap.add_argument('--name', default='')
    ap.add_argument('--notes', default='')
    ap.add_argument('--file', default='')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()

    user, token = read_token()
    log('凭据账号 : %s（token %d 字符，未打印）' % (user, len(token)))
    log('仓库     : %s' % REPO)

    st, rel = api(token, 'GET', '/repos/%s/releases/tags/%s' % (REPO, a.tag))
    exists = st == 200
    log('Tag 状态 : %s' % ('已存在' if exists else ('不存在（HTTP %s）' % st)))

    if a.check:
        if exists:
            log('  release : %s' % rel.get('html_url'))
            for asset in rel.get('assets', []):
                log('  asset   : %s (%d 字节)' % (asset['name'], asset['size']))
        return 0

    if not exists:
        st, rel = api(token, 'POST', '/repos/%s/releases' % REPO, body={
            'tag_name': a.tag,
            'name': a.name or a.tag,
            'body': a.notes or '',
            'draft': False,
            'prerelease': False,
        })
        if st not in (200, 201):
            log('创建 release 失败: HTTP %s\n%s' % (st, rel))
            return 1
        log('创建成功 : %s' % rel.get('html_url'))
    else:
        log('复用已有 : %s' % rel.get('html_url'))

    if a.file:
        path = a.file
        if not os.path.isfile(path):
            log('找不到文件: %s' % path)
            return 1
        fname = os.path.basename(path)
        # 同名 asset 已存在 -> 先删掉再传（避免 422）
        for asset in rel.get('assets', []):
            if asset['name'] == fname:
                d, _ = api(token, 'DELETE', '/repos/%s/releases/assets/%d' % (REPO, asset['id']))
                log('删除旧 asset %s -> HTTP %s' % (fname, d))
        upload_url = rel['upload_url'].split('{')[0]
        with open(path, 'rb') as f:
            blob = f.read()
        st, res = api(token, 'POST', upload_url + '?name=' + urllib.parse.quote(fname),
                      raw=blob, ctype='application/octet-stream')
        if st not in (200, 201):
            log('上传失败: HTTP %s\n%s' % (st, str(res)[:600]))
            return 1
        log('已上传   : %s (%d 字节)' % (res.get('name'), res.get('size')))
        log('下载直链 : %s' % res.get('browser_download_url'))

    st, rel2 = api(token, 'GET', '/repos/%s/releases/tags/%s' % (REPO, a.tag))
    if st == 200:
        log('\n复核 —— release 页面: %s' % rel2.get('html_url'))
        for asset in rel2.get('assets', []):
            log('        asset: %s  %d 字节  downloads=%s'
                % (asset['name'], asset['size'], asset.get('download_count')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
