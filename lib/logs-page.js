/**
 * The plugin's own log page: a loopback-only HTML view of everything that
 * matters when "the model cannot be reached".
 *
 * Why a standalone page instead of only a settings card: the card lives inside
 * the Plugins page and is only reachable where the host serves this entry's
 * settings, which varies by DSH build and profile. A URL that the plugin logs at
 * startup — and repeats in the error the user is already looking at — works
 * everywhere, is what a bug report can quote, and needs no UI framework.
 *
 * @module opencode2dsh-improve/logs-page
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

/** Cap on JSON request bodies (nothing is posted). */
const MAX_BODY_BYTES = 4096

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>opencode2dsh 日志</title>
<style>
:root{color-scheme:light dark}
body{margin:0;padding:16px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0f1115;color:#d7dae0}
h1{font-size:15px;margin:0 0 4px}
#state{color:#9aa4b2;margin-bottom:10px;white-space:pre-wrap}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid #2b3038;background:#181c22;color:#d7dae0;cursor:pointer}
button:hover{border-color:#4f8cff}
label{color:#9aa4b2;display:flex;gap:6px;align-items:center}
.login{border:1px solid #2b3038;border-radius:8px;padding:10px 12px;margin-bottom:10px;background:#12151a}
.login-note{color:#9aa4b2;margin-bottom:8px;line-height:1.5}
.login-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.login-row input{flex:1 1 260px;min-width:220px;font:inherit;padding:6px 8px;border-radius:6px;border:1px solid #2b3038;background:#181c22;color:#d7dae0}
#loginStatus{color:#9aa4b2;font-size:12px}
pre{margin:0;padding:10px;border:1px solid #2b3038;border-radius:8px;background:#12151a;white-space:pre-wrap;word-break:break-word;min-height:60vh}
.warn{color:#e3b341}.err{color:#f85149}
</style></head><body>
<h1>opencode2dsh 日志</h1>
<div id="state">加载中…</div>
<div class="bar">
<button id="refresh">刷新</button><button id="copy">复制</button><button id="clear">清除日志</button>
<label><input type="checkbox" id="auto" checked>自动刷新（3 秒）</label>
<span id="copied"></span><span id="cleared" class="warn"></span>
</div>
<div class="login">
<div class="login-note">脱离匿名限流：在 <a href="https://opencode.ai/auth" target="_blank" rel="noopener noreferrer">opencode.ai/auth</a> 创建 API Key，粘贴到这里登录（写入本机 auth.json，下一轮请求即生效，也作用于独立 opencode）。</div>
<div class="login-row">
<input type="password" id="apikey" placeholder="sk-… (opencode.ai/auth)" autocomplete="off">
<button id="login">登录</button>
<span id="loginStatus"></span>
</div>
</div>
<pre id="out"></pre>
<script>
const base = location.pathname.replace(/\\/$/, '');
let last = '';
async function load() {
  try {
    const response = await fetch(base + '/logs');
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error(body && (body.error || body.message) || ('HTTP ' + response.status));
    const value = body.value;
    const stamp = (ms) => new Date(ms).toLocaleTimeString();
    const plugin = (value.plugin || []).map((line) => '[' + stamp(line.at) + '] ' + String(line.level).toUpperCase() + ' ' + line.message);
    const delegate = value.delegate || {};
    const state = delegate.enabled === false
      ? '委托通道：已关闭（delegate: false）'
      : delegate.ready
        ? '委托运行时：已就绪 · ' + (delegate.status || '')
        : delegate.failure
          ? '委托运行时：失败 · ' + delegate.failure
          : '委托运行时：准备中 · ' + (delegate.status || '');
    const arrivals = delegate.arrivals;
    const arrivalLine = delegate.ready === false
      ? ''
      : (arrivals && arrivals.count > 0)
        ? '本机端点已收到 ' + arrivals.count + ' 个模型请求（最近：' + (arrivals.last ? arrivals.last.model + ' stream=' + arrivals.last.stream + ' tools=' + arrivals.last.tools : '-') + '）'
        : '本机端点尚未收到任何模型请求 —— 请求没有到达本插件（检查 provider/模型选择、中间网关或代理）';
    document.getElementById('state').textContent = state + '\\n端点：' + (delegate.shimUrl || '(未就绪)')
      + '\\n数据目录：' + (value.dataDir || '(默认)')
      + (arrivalLine ? '\\n' + arrivalLine : '');
    // Staleness is otherwise invisible: a page kept open across a DSH restart
    // keeps polling a dead token and looks like "the log stopped".
    const last = (value.plugin || [])[value.plugin.length - 1];
    document.getElementById('state').textContent += '\\n最后一条插件日志：'
      + (last ? stamp(last.at) : '(无)') + '（页面每 3 秒刷新；若 DSH 重启，日志页地址会变，请从插件日志重新取）';
    const runtime = value.runtimeLog || [];
    last = [
      '── 插件日志 ──\\n' + (plugin.length ? plugin.join('\\n') : '(暂无)'),
      '\\n── 委托运行时日志 ──\\n' + (runtime.length ? runtime.join('\\n') : '(暂无)')
    ].join('\\n');
    document.getElementById('out').textContent = last;
  } catch (error) {
    document.getElementById('state').textContent = '日志获取失败：' + (error && error.message ? error.message : String(error));
  }
}
document.getElementById('refresh').onclick = load;
document.getElementById('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(last);
    document.getElementById('copied').textContent = '已复制';
    setTimeout(() => { document.getElementById('copied').textContent = ''; }, 1500);
  } catch (error) {
    document.getElementById('copied').textContent = '复制失败';
  }
};
document.getElementById('auto').onchange = (event) => { auto = event.target.checked ? load : stop; };
document.getElementById('clear').onclick = async () => {
  // Destructive and unundoable: the whole point of this page is to keep the
  // evidence, so clearing asks first.
  if (!confirm('将清空插件日志与委托运行时日志文件（不可恢复）。\n建议先把需要的内容复制走。')) return;
  auto = false;
  document.getElementById('auto').checked = false;
  const note = document.getElementById('cleared');
  note.textContent = '正在清除…';
  try {
    const response = await fetch(base + '/logs/clear', { method: 'POST' });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error(body && (body.error || body.message) || ('HTTP ' + response.status));
    const value = body.value || {};
    note.textContent = value.fileCleared
      ? ('已清除：插件日志 ' + value.removedLines + ' 行，运行时日志文件已清空')
      : ('已清除插件日志 ' + value.removedLines + ' 行；运行时日志文件未能清空（' + (value.fileError || '未知原因') + '）');
    await load();
  } catch (error) {
    note.textContent = '清除失败：' + (error && error.message ? error.message : String(error));
  }
};
document.getElementById('login').onclick = async () => {
  const input = document.getElementById('apikey');
  const status = document.getElementById('loginStatus');
  const key = input.value.trim();
  if (!key) { status.textContent = '请先粘贴 API Key。'; return; }
  status.textContent = '登录中…';
  try {
    const response = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error((body && (body.message || body.error)) || ('HTTP ' + response.status));
    status.textContent = '已保存：' + (body.files || []).length + ' 处（本机 auth.json 与委托运行时）。下一轮请求即生效。';
    input.value = '';
  } catch (error) {
    status.textContent = '登录失败：' + (error && error.message ? error.message : String(error));
  }
};
let auto = load;
const timer = setInterval(() => { if (auto) load(); }, 3000);
load();
</script></body></html>`

/**
 * Start the loopback log page.
 *
 * The token is a fresh 128-bit random per process and every path is bound to
 * 127.0.0.1, so the page is readable only by this machine's user — there is no
 * remote exposure and nothing to authenticate against.
 *
 * @param {object} source
 * @param {() => {lines: {at: number, level: string, message: string}[]}} source.ring plugin log ring
 * @param {() => object} source.delegate current delegate state
 * @param {() => string} source.dataDir delegate data directory
 * @param {() => Promise<string[]>} source.runtimeLog tail of the runtime log file
 * @param {() => Promise<object>} [source.clearLogs] empties both views
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function startLogsPage({ ring, delegate, dataDir, runtimeLog, clearLogs }) {
  const token = randomBytes(16).toString('hex')
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
    res.end(JSON.stringify(body))
  }

  const server = createServer((req, res) => {
    const remote = req.socket?.remoteAddress
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      json(res, 403, { ok: false, error: 'loopback only' })
      return
    }
    const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '')
    if (path === `/${token}` && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      res.end(PAGE)
      return
    }
    if (path === `/${token}/logs` && req.method === 'GET') {
      Promise.resolve()
        .then(async () => json(res, 200, {
          ok: true,
          value: {
            plugin: ring().lines.slice(),
            delegate: delegate(),
            runtimeLog: await runtimeLog(),
            dataDir: dataDir(),
          },
        }))
        .catch(error => json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }))
      return
    }
    if (path === `/${token}/logs/clear` && req.method === 'POST') {
      Promise.resolve()
        .then(() => clearLogs())
        .then(value => json(res, 200, { ok: true, value }))
        .catch(error => json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }))
      return
    }
    json(res, 404, { ok: false, error: 'not found', hint: `log page: http://127.0.0.1:<port>/<token>` })
  })
  server.requestTimeout = 0
  server.headersTimeout = 30000
  server.keepAliveTimeout = 72000
  // Bodies are never read; drain so a client cannot stall the socket.
  server.on('connection', socket => socket.on('data', chunk => { if (chunk.length > MAX_BODY_BYTES) socket.destroy() }))

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/${token}`,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}