# -*- coding: utf-8 -*-
"""
agl_ls.py —— Antigravity Language Server 客户端

两种连接方式，按优先级自动选择：
  1. 复用正在运行的 LS 实例（毫秒级）—— 从进程命令行读 CSRF，从日志读端口
  2. 自己拉起一个 LS 实例（约 7-8 秒）—— 复用场景不可用时的回退方案

复用模式不额外占用内存，也绝不会干扰 Antigravity 自身的运行。
"""
import os
import re
import ssl
import sys
import json
import time
import uuid
import socket
import subprocess
import urllib.error
import urllib.request

# ---------------------------------------------------------------- 路径解析

# 桌面版可能的安装位置（按优先级）
_CANDIDATE_DIRS = [
    r'D:\Antigravity\app',
    os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'antigravity'),
    os.path.join(os.environ.get('PROGRAMFILES', ''), 'Antigravity'),
]


def find_ls_binary():
    """定位 language_server.exe。兼容 junction / 符号链接。"""
    override = os.environ.get('AGL_LS_PATH')
    if override and os.path.isfile(override):
        return override
    for base in _CANDIDATE_DIRS:
        if not base:
            continue
        p = os.path.join(base, 'resources', 'bin', 'language_server.exe')
        if os.path.isfile(p):
            # 解析真实路径，避免通过 junction 重复占用
            return os.path.realpath(p)
    return None


def app_data_dir_name():
    """与桌面版 getAppDataDirName() 保持一致：app.getName().toLowerCase()"""
    return 'antigravity'


def ls_log_path():
    return os.path.join(os.environ.get('APPDATA', ''),
                        'Antigravity', 'logs', 'language_server.log')


# ------------------------------------------------------- 发现运行中的实例

_PORT_RE = re.compile(r'listening on \w+ port at (\d+) for HTTPS')
_CSRF_RE = re.compile(r'--csrf_token[= ]+([0-9a-fA-F-]{36})')


def _find_csrf_via_psutil():
    """从 LS 进程命令行里读 CSRF token。"""
    try:
        import psutil
    except ImportError:
        return None
    try:
        for p in psutil.process_iter(['name', 'cmdline']):
            try:
                nm = (p.info.get('name') or '').lower()
                if 'language_server' not in nm:
                    continue
                cmd = ' '.join(p.info.get('cmdline') or [])
                m = _CSRF_RE.search(cmd)
                if m:
                    return m.group(1)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception:
        pass
    return None


def _find_csrf_via_wmic():
    """psutil 不可用时的回退：调 wmic 拿命令行。"""
    try:
        r = subprocess.run(
            ['wmic', 'process', 'where', "name='language_server.exe'",
             'get', 'CommandLine', '/value'],
            capture_output=True, text=True, timeout=15,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        m = _CSRF_RE.search(r.stdout or '')
        return m.group(1) if m else None
    except Exception:
        return None


def find_running_csrf():
    """拿到正在运行的 LS 实例的 CSRF token；找不到返回 None。"""
    return _find_csrf_via_psutil() or _find_csrf_via_wmic()


def find_running_port():
    """从 LS 日志里解析出监听端口（取最后一次出现的，即最新实例）。"""
    log = ls_log_path()
    if not os.path.exists(log):
        return None
    try:
        with open(log, 'rb') as f:
            txt = f.read().decode('utf-8', 'replace')
    except Exception:
        return None
    ports = _PORT_RE.findall(txt)
    return int(ports[-1]) if ports else None


def _probe(port, csrf, timeout=3):
    """轻量探活：能通就返回 True。"""
    if not (port and csrf):
        return False
    # 先做 TCP 预检，避免在死端口上白等 TLS 握手超时
    if not _port_open(port, tcp_timeout=1.0):
        return False
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                     urllib.request.HTTPSHandler(context=ctx))
    url = ('https://127.0.0.1:%d/%s/GetAuthStatus'
           % (port, LanguageServer.SERVICE))
    req = urllib.request.Request(url, data=b'{}', method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('X-Codeium-Csrf-Token', csrf)
    req.add_header('Connect-Protocol-Version', '1')
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def _port_open(port, tcp_timeout=1.0):
    s = socket.socket()
    s.settimeout(tcp_timeout)
    try:
        s.connect(('127.0.0.1', port))
        return True
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


def discover_running():
    """尝试发现可用的运行中实例。返回 (port, csrf) 或 (None, None)。"""
    csrf = find_running_csrf()
    if not csrf:
        return None, None
    port = find_running_port()
    if not port:
        return None, None
    if _probe(port, csrf):
        return port, csrf
    return None, None


# ---------------------------------------------------------------- 工具函数

def _free_port():
    """让系统分配一个空闲端口，避免和桌面版自己起的 LS 撞车。"""
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _ssl_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _opener():
    # 关键：显式禁用代理，否则本地 HTTPS 会被系统代理劫持成 502
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=_ssl_ctx()),
    )


# ---------------------------------------------------------------- LS 会话

class LanguageServer:
    """LS 会话。

    默认优先复用正在运行的实例（毫秒级响应）；
    传 reuse=False 或复用不可用时，才自己拉起一个（约 7-8 秒）。
    """

    SERVICE = 'exa.language_server_pb.LanguageServerService'

    def __init__(self, ls_path=None, app_data_dir=None, startup_timeout=60,
                 reuse=True):
        self.ls_path = ls_path or find_ls_binary()
        self.app_data_dir = app_data_dir or app_data_dir_name()
        self.startup_timeout = startup_timeout
        self.reuse = reuse
        self.port = None
        self.csrf = str(uuid.uuid4())
        self.proc = None
        self._log = None
        self.reused = False   # 本次是否走的复用路径

    # -------------------------------------------------- 启动
    def start(self):
        # 第一步：尝试复用正在运行的实例
        if self.reuse:
            port, csrf = discover_running()
            if port and csrf:
                self.port = port
                self.csrf = csrf
                self.reused = True
                return True

        # 第二步：自己拉一个
        if not self.ls_path or not os.path.isfile(self.ls_path):
            raise RuntimeError('找不到 language_server.exe，请设置环境变量 AGL_LS_PATH')

        self.port = _free_port()
        args = [
            self.ls_path,
            '--standalone',
            '--override_ide_name', 'antigravity',
            '--subclient_type', 'hub',
            '--override_ide_version', self._detect_version(),
            '--override_user_agent_name', 'antigravity',
            '--https_server_port', str(self.port),
            '--csrf_token', self.csrf,
            '--app_data_dir', self.app_data_dir,
            '--api_server_url', 'https://generativelanguage.googleapis.com',
            '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com',
            '--enable_sidecars',
        ]
        # 不在 HEADLESS 模式下跑，否则部分 manager 不初始化
        env = dict(os.environ)
        env.pop('ELECTRON_OZONE_PLATFORM_HINT', None)

        # 输出丢弃：LS 日志量很大，托盘工具不需要留存
        self._log = open(os.devnull, 'wb')
        creationflags = 0
        if os.name == 'nt':
            creationflags = 0x08000000  # CREATE_NO_WINDOW，不弹黑框
        self.proc = subprocess.Popen(
            args, stdout=self._log, stderr=subprocess.STDOUT,
            cwd=os.path.dirname(self.ls_path), env=env,
            creationflags=creationflags,
        )

        deadline = time.time() + self.startup_timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError('language_server 启动即退出，code=%s' % self.proc.returncode)
            try:
                status, _ = self.call('GetAuthStatus', timeout=3)
                if status == 200:
                    return True
            except Exception:
                pass
            time.sleep(0.3)
        raise RuntimeError('language_server 启动超时（%ss）' % self.startup_timeout)

    def _detect_version(self):
        """从 app 目录的 package.json 读版本；读不到就给个安全的默认值。"""
        try:
            base = os.path.dirname(os.path.dirname(os.path.dirname(self.ls_path)))
            pj = os.path.join(base, 'package.json')
            with open(pj, 'r', encoding='utf-8') as f:
                return json.load(f).get('version', '2.19.1')
        except Exception:
            return '2.19.1'

    # -------------------------------------------------- 调用
    def call(self, method, body=None, timeout=30):
        """调一个 RPC，返回 (status, text)。status 为 None 表示连接层失败。"""
        url = 'https://127.0.0.1:%d/%s/%s' % (self.port, self.SERVICE, method)
        data = json.dumps(body or {}).encode('utf-8')
        req = urllib.request.Request(url, data=data, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('X-Codeium-Csrf-Token', self.csrf)
        req.add_header('Connect-Protocol-Version', '1')
        try:
            with _opener().open(req, timeout=timeout) as r:
                return r.status, r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode('utf-8', 'replace')
        except Exception as e:
            return None, 'ERR %s' % e

    def json(self, method, body=None, timeout=30):
        status, text = self.call(method, body, timeout)
        if status != 200:
            raise RuntimeError('%s 失败: %s %s' % (method, status, text[:200]))
        return json.loads(text) if text.strip() else {}

    # -------------------------------------------------- 停止
    def stop(self):
        # 复用的是用户自己的实例，绝不能 terminate —— 那会把 Antigravity 搞崩
        if self.reused:
            return
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=8)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        if self._log:
            try:
                self._log.close()
            except Exception:
                pass
            self._log = None

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()
        return False


# ---------------------------------------------------------------- 高层封装

class TokenInfo:
    """一次 GetTokenBase 的结构化结果"""

    def __init__(self, raw):
        self.raw = raw or {}
        self.reused = None
        base = self.raw.get('customizationTokenBase', {}) or {}
        self.groups = base.get('groups', []) or []
        self.total = base.get('totalTokens', 0) or 0
        self.budget = self.raw.get('customizationBudget', 0) or 0
        self.remaining = self.raw.get('remainingBudget', 0) or 0
        self.rules_budget = self.raw.get('rulesBudget', 0) or 0
        self.rules_remaining = self.raw.get('remainingRulesBudget', 0) or 0
        self.truncated = bool(self.raw.get('truncatedCustomizationTokenBase'))

    @property
    def percent(self):
        return (100.0 * self.total / self.budget) if self.budget else 0.0

    def items(self):
        """展开成 (分组名, 项目名, tokens) 列表"""
        out = []
        for g in self.groups:
            gname = g.get('name', '?')
            gtok = g.get('numTokens', 0)
            out.append((gname, None, gtok))
            for ch in (g.get('children') or []):
                out.append((gname, ch.get('name', '?'), ch.get('numTokens', 0)))
        return out


def fetch_token_base(ls_path=None, timeout=60, reuse=True):
    """拉一次上下文用量（含逐项明细）"""
    with LanguageServer(ls_path=ls_path, startup_timeout=timeout,
                        reuse=reuse) as ls:
        info = TokenInfo(ls.json('GetTokenBase'))
        info.reused = ls.reused
        return info


def fetch_user_status(ls_path=None, timeout=60, reuse=True):
    with LanguageServer(ls_path=ls_path, startup_timeout=timeout,
                        reuse=reuse) as ls:
        return ls.json('GetUserStatus')


# ---------------------------------------------------------------- 对话用量

# 模型 → 上下文窗口上限（2026-10-02 按本机 LS 实际返回的模型表整理）
# 取自 GetCascadeModelConfigData 的 modelOrAlias.model
_MODEL_LIMITS = {
    # Claude 系（Anthropic 200k 窗口，Antigravity 侧按 160k 计）
    'M35': 160000,   # Claude Sonnet 4.6 (Thinking)
    'M26': 160000,   # Claude Opus 4.6 (Thinking)
    # Gemini Pro 系
    'M16': 128000,   # Gemini 3.1 Pro (High)
    'M36': 128000,   # Gemini 3.1 Pro (Low)
    'M18': 128000,
    'M37': 128000,
    # Gemini Flash 系（3.5+ 为 256k）
    'M318': 256000,  # Gemini 3.8 Flash (High)
    'M319': 256000,  # Gemini 3.8 Flash (Medium)
    'M320': 256000,  # Gemini 3.8 Flash (Low)
    'M298': 256000,  # Gemini 3.7 Flash (High)
    'M299': 256000,
    'M300': 256000,
    'M71': 256000,   # Gemini 3.6 Flash (High)
    'M72': 256000,
    'M73': 256000,
}


def guess_context_limit(model_id):
    """按模型 id 猜上下文窗口上限。"""
    import re as _re
    mid = str(model_id or '').upper()
    m = _re.search(r'MODEL_PLACEHOLDER_([A-Z]\d+)', mid)
    if m and m.group(1) in _MODEL_LIMITS:
        return _MODEL_LIMITS[m.group(1)]
    low = str(model_id or '').lower()
    if 'claude' in low or 'opus' in low or 'sonnet' in low:
        return 160000
    if 'flash' in low or 'lite' in low or 'unspecified' in low:
        vm = _re.search(r'(\d+\.\d+)', low)
        ver = float(vm.group(1)) if vm else 0
        return 128000 if (ver and ver < 3.5) else 256000
    if 'gpt' in low or 'oss' in low:
        return 80000
    if 'pro' in low:
        return 128000
    # 兜底：M 编号按 Flash 系算
    return 256000


_STEP_CHECKPOINT = 'CORTEX_STEP_TYPE_CHECKPOINT'
# modelUsage 实际挂在模型应答步上（不是 checkpoint）
_STEP_WITH_USAGE = ('CORTEX_STEP_TYPE_PLANNER_RESPONSE', 'CORTEX_STEP_TYPE_CHECKPOINT')


class ConversationUsage:
    """当前会话的对话用量（来自 cascade trajectory）。

    口径说明（2026-10-02 实测修正）：
      - modelUsage 挂在 PLANNER_RESPONSE 步的 metadata 上
      - 真实上下文规模 = inputTokens + cacheReadTokens
        （inputTokens 只是本次新增，cacheReadTokens 是被缓存的历史上下文）
    """

    def __init__(self, raw=None):
        self.raw = raw or {}
        self.ok = False
        self.error = None
        self.summary = ''
        self.model = ''
        self.input_tokens = 0
        self.cache_read_tokens = 0
        self.output_tokens = 0
        self.tool_output_tokens = 0
        self.limit = 0
        self.step_count = 0
        self.compressed = False

    @property
    def used(self):
        """真实上下文占用 = 新增输入 + 缓存读取。"""
        return self.input_tokens + self.cache_read_tokens

    @property
    def percent(self):
        return (100.0 * self.used / self.limit) if self.limit else 0.0

    def parse(self, steps, summary='', model='', step_count=0):
        prev_total = -1
        last = None
        for step in (steps or []):
            typ = step.get('type', '')
            meta = step.get('metadata') or {}
            if typ in _STEP_WITH_USAGE:
                mu = meta.get('modelUsage')
                if mu:
                    try:
                        it = int(str(mu.get('inputTokens') or '0') or 0)
                    except Exception:
                        it = 0
                    try:
                        cr = int(str(mu.get('cacheReadTokens') or '0') or 0)
                    except Exception:
                        cr = 0
                    try:
                        ot = int(str(mu.get('outputTokens') or '0') or 0)
                    except Exception:
                        ot = 0
                    total = it + cr
                    # 压缩检测：上下文总量骤降
                    if prev_total > 0 and total < prev_total and (prev_total - total) > 20000:
                        self.compressed = True
                    prev_total = total
                    last = (it, cr, ot, mu.get('model') or '')
            elif meta.get('toolCallOutputTokens'):
                try:
                    self.tool_output_tokens += int(meta['toolCallOutputTokens'])
                except Exception:
                    pass
        if last:
            self.input_tokens, self.cache_read_tokens, self.output_tokens, m = last
            self.model = m or model
        self.summary = summary
        self.step_count = step_count
        if not self.model:
            self.model = model
        self.limit = guess_context_limit(self.model)
        self.ok = True
        return self


def fetch_conversation(ls_path=None, timeout=60, reuse=True, tail=400):
    """拉当前会话的对话用量。

    链路（与 agl-context-pro 扩展版一致）：
      GetAllCascadeTrajectories → 取最近会话 → GetCascadeTrajectorySteps
    注意：GetAllCascadeTrajectories 请求体必须带 metadata，否则返回空。
    """
    conv = ConversationUsage()
    try:
        with LanguageServer(ls_path=ls_path, startup_timeout=timeout,
                            reuse=reuse) as ls:
            conv.reused = ls.reused
            data = ls.json('GetAllCascadeTrajectories',
                           {'metadata': {'ideName': 'antigravity',
                                         'extensionName': 'antigravity'}},
                           timeout=20)
            summaries = (data or {}).get('trajectorySummaries') or {}
            if not summaries:
                conv.error = '未发现会话（Antigravity 未运行或尚无对话）'
                return conv
            # 按最后修改时间取最近一条
            items = sorted(summaries.items(),
                           key=lambda kv: (kv[1] or {}).get('lastModifiedTime', ''),
                           reverse=True)
            cid, meta = items[0]
            step_count = int((meta or {}).get('stepCount') or 0)
            summary = (meta or {}).get('summary') or cid
            model = ''
            for key in ('latestTaskBoundaryStep', 'latestNotifyUserStep'):
                latest = (meta or {}).get(key) or {}
                m = (latest.get('step') or {}).get('metadata') or {}
                if m.get('generatorModel'):
                    model = m['generatorModel']
                rq = m.get('requestedModel') or {}
                if rq.get('model'):
                    model = rq['model']
            start = max(0, step_count - tail)
            steps_resp = ls.json('GetCascadeTrajectorySteps',
                                 {'cascadeId': cid, 'startIndex': start,
                                  'endIndex': step_count}, timeout=25)
            conv.parse((steps_resp or {}).get('steps') or [],
                       summary=summary, model=model, step_count=step_count)
    except Exception as e:
        conv.error = str(e)
    return conv


# ---------------------------------------------------------------- CLI

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description='Antigravity 上下文用量查询')
    ap.add_argument('--json', action='store_true', help='输出原始 JSON')
    ap.add_argument('--ls-path', help='手动指定 language_server.exe')
    ap.add_argument('--no-reuse', action='store_true',
                    help='不复用运行中的实例，强制自己拉起一个')
    ap.add_argument('--probe', action='store_true',
                    help='只探测运行中的实例是否可复用')
    args = ap.parse_args()

    if args.probe:
        port, csrf = discover_running()
        if port:
            print('发现可复用的实例：端口 %d，CSRF %s…' % (port, csrf[:8]))
        else:
            print('未发现可复用的实例（Antigravity 可能未运行）')
        sys.exit(0)

    t0 = time.time()
    try:
        info = fetch_token_base(args.ls_path, reuse=not args.no_reuse)
    except Exception as e:
        print('查询失败:', e, file=sys.stderr)
        sys.exit(1)
    elapsed = time.time() - t0

    source = ('复用运行中实例' if info.reused else '新建实例') if info.reused is not None else ''
    if args.json:
        print(json.dumps(info.raw, ensure_ascii=False, indent=2))
    else:
        bar_w = 28
        filled = int(round(bar_w * info.percent / 100.0))
        bar = '█' * filled + '░' * (bar_w - filled)
        print('上下文用量  %s  %5.1f%%' % (bar, info.percent))
        print('            %d / %d tokens（剩余 %d）' % (info.total, info.budget, info.remaining))
        if info.truncated:
            print('            ⚠ 已发生截断')
        print('            %s · 耗时 %.0f ms' % (source, elapsed * 1000))
        print()
        print('%-10s %-46s %8s' % ('分组', '项目', 'tokens'))
        print('-' * 68)
        for gname, item, tok in info.items():
            label = item if item else '（小计）'
            if len(label) > 44:
                label = '…' + label[-43:]
            print('%-10s %-46s %8d' % (gname, label, tok))
