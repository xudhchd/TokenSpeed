'use strict';
// LLM Speedtest · 零依赖 Node 服务：静态页面 + 测速代理（规避浏览器 CORS 与并发连接数限制）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const os = require('os');
const { runBenchmark } = require('./lib/bench');
const { listModels } = require('./lib/client');
const { buildBrowserBundle } = require('./lib/browser-bundle');
const D = require('./lib/dataset');
const mock = require('./lib/mock');
// 只读版本号：页脚会显示它，用来一眼确认浏览器加载的前端是不是这版镜像里的
const PKG_VERSION = require('./package.json').version;
// 前端选择「演示模式」时 baseUrl 传 "demo"，这里换成本机内置的演示服务
const useDemo = (cfg) => {
  if (cfg && cfg.baseUrl === 'demo') {
    cfg.baseUrl = `http://127.0.0.1:${PORT}/demo/v1`;
    cfg.format = 'openai';
    cfg.model = cfg.model || 'demo-coder';
    cfg._demo = true;
  }
  return cfg;
};

// 公开部署时设置 BLOCK_PRIVATE=1：拒绝把请求转发到本机、内网等地址，避免被当成跳板访问服务器上的其他服务
const BLOCK_PRIVATE = process.env.BLOCK_PRIVATE === '1';
// 证书校验状态，仅用于在页面上提示，不改变任何行为。
// NODE_TLS_REJECT_UNAUTHORIZED=0 会让进程内所有 https 请求都不校验证书（包括填了 Key 的公网 API），
// 而 NODE_EXTRA_CA_CERTS 只是往信任库里追加一个 CA，公网 CA 照常校验——后者是内网自签证书的正解。
const TLS_INSECURE = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
const EXTRA_CA = process.env.NODE_EXTRA_CA_CERTS || null;
// 本机网卡地址 + SELF_IPS 里声明的公网 IP（云服务器的公网 IP 通常不在网卡上）
const OWN_IPS = new Set(
  Object.values(os.networkInterfaces())
    .flat()
    .map((x) => x.address.toLowerCase())
    .concat(String(process.env.SELF_IPS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))
);
function isPrivate(ip) {
  ip = ip.toLowerCase();
  if (OWN_IPS.has(ip)) return true;
  if (net.isIPv6(ip)) {
    if (ip.startsWith('::ffff:')) return isPrivate(ip.slice(7));
    return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function guard(cfg) {
  if (!BLOCK_PRIVATE || !cfg || cfg._demo) return cfg;
  let u;
  try {
    u = new URL(String(cfg.baseUrl || '').trim());
  } catch (_) {
    return cfg; // 地址格式错误交给后面的校验报错
  }
  const name = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(name) ? [name] : (await dns.lookup(name, { all: true }).catch(() => [])).map((x) => x.address);
  if (addrs.some(isPrivate)) throw new Error('出于安全考虑，这个测速服务不能访问内网或本机地址');
  cfg._noRedirect = true; // 禁止跳转，防止借 302 绕过上面的检查
  return cfg;
}

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const runs = new Map();
let browserBundle;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handleRun(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const id = crypto.randomBytes(8).toString('hex');
  const ctl = { id, master: new AbortController(), stopDecode: null };
  runs.set(id, ctl);
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });
  res.socket && res.socket.setNoDelay(true);
  res.flushHeaders && res.flushHeaders();
  let closed = false;
  res.on('close', () => {
    closed = true;
    if (!res.writableEnded) ctl.master.abort();
    runs.delete(id);
  });
  const emit = (ev) => {
    if (!closed) res.write(JSON.stringify(ev) + '\n');
  };
  emit({ type: 'run', id });
  try {
    await runBenchmark(await guard(useDemo(body)), emit, ctl);
  } catch (e) {
    emit({ type: 'error', message: e.message });
  }
  runs.delete(id);
  if (!closed) res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/demo/')) return mock.handle(req, res);
    if (req.method === 'POST' && url.pathname === '/api/run') return await handleRun(req, res);
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const { id, scope } = await readJson(req);
      const ctl = runs.get(id);
      if (!ctl) return sendJson(res, 404, { error: 'run not found' });
      if (scope === 'decode' && ctl.stopDecode) ctl.stopDecode();
      else ctl.master.abort();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/models') {
      const cfg = useDemo(await readJson(req));
      try {
        return sendJson(res, 200, { models: await listModels(await guard(cfg)) });
      } catch (e) {
        return sendJson(res, 200, { error: e.message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/info') {
      return sendJson(res, 200, {
        version: PKG_VERSION,
        dataset: { items: D.ITEMS.length, chars: D.TOTAL_CHARS, sources: ['HumanEval (164)', 'MBPP (974)'] },
        tls: { insecure: TLS_INSECURE, extraCa: EXTRA_CA },
        blockPrivate: BLOCK_PRIVATE,
      });
    }
    if (req.method === 'GET' && url.pathname === '/direct-bench.js') {
      browserBundle ??= buildBrowserBundle();
      const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, {
        'content-type': MIME['.js'], 'cache-control': 'no-cache', vary: 'Accept-Encoding',
        ...(gzip ? { 'content-encoding': 'gzip' } : {}),
      });
      return res.end(gzip ? browserBundle.gzip : browserBundle.plain);
    }
    if (req.method === 'GET') {
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/index.html';
      const file = path.normalize(path.join(PUBLIC, p));
      if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
      fs.readFile(file, (err, data) => {
        if (err) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(data);
      });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用，可改用：PORT=${PORT + 1} npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ⚡ LLM Speedtest 已启动  →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  console.log(`  语料：${D.ITEMS.length} 道代码题（HumanEval + MBPP），约 ${(D.TOTAL_CHARS / 1000).toFixed(0)}K 字符\n`);
});
