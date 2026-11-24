'use strict';
// 统一的流式请求封装：OpenAI 兼容 / Anthropic Messages

// 估算 token 用的计数：[中日韩字符数, 其他“词”数]。
// 其他部分按英文单词、最多 3 位数字、连续空白、单个符号各算一个单位——
// 这和常见分词器的切法接近，实测比按字符数估算准得多（连续缩进只算一个单位）
const CJK = '\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_RE = new RegExp(`[${CJK}]`, 'g');
const WORD_RE = new RegExp(`[A-Za-z]+|\\d{1,3}|\\s+|[^\\sA-Za-z\\d${CJK}]`, 'g');
function splitCount(s) {
  s = String(s);
  return [(s.match(CJK_RE) || []).length, (s.match(WORD_RE) || []).length];
}

// 把上游网关（one-api / new-api 一类中转）的常见报错翻成一句人话，附在原始信息后面。
// 原始 message 和 request id 一律保留，方便到网关日志里按 id 查具体渠道
function explainHttpError(status, msg) {
  const s = String(msg || '');
  if (/insufficient[ _-]?user[ _-]?quota/i.test(s)) return '上游网关的账户余额或令牌额度已用尽';
  if (/pre[ _-]?consume[ _-]?token[ _-]?quota[ _-]?fail/i.test(s)) return '余额不足以预扣本次请求的额度';
  if (/do[ _-]?request[ _-]?fail/i.test(s)) return '上游网关向模型服务发起请求失败：地址不可达、超时或证书不受信';
  if (/no[ _-]?available[ _-]?channel|model[ _-]?not[ _-]?found|无可用渠道/i.test(s)) return '该模型在网关下没有可用渠道';
  if (status === 401) return 'API Key 无效、已过期，或无权访问该模型';
  if (status === 403) return '被上游拒绝：权限、分组或额度限制';
  if (status === 404) return '接口路径不存在，检查 baseUrl 的 /v1 有没有多写或少写';
  if (status === 429) return '触发上游限流或并发超限';
  return '';
}

function trimSlash(s) {
  return String(s || '').trim().replace(/\/+$/, '');
}

function endpoint(cfg) {
  const base = trimSlash(cfg.baseUrl);
  if (cfg.format === 'anthropic') {
    if (/\/messages$/.test(base)) return base;
    if (/\/v1$/.test(base)) return base + '/messages';
    return base + '/v1/messages';
  }
  if (/\/chat\/completions$/.test(base)) return base;
  if (/^https?:\/\/[^/]+$/i.test(base)) return base + '/v1/chat/completions';
  return base + '/chat/completions';
}

function modelsEndpoint(cfg) {
  let base = trimSlash(cfg.baseUrl).replace(/\/chat\/completions$/, '').replace(/\/messages$/, '');
  if (cfg.format === 'anthropic' && !/\/v1$/.test(base)) base += '/v1';
  else if (cfg.format !== 'anthropic' && /^https?:\/\/[^/]+$/i.test(base)) base += '/v1';
  return base + '/models';
}

function headers(cfg) {
  const h = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (cfg.format === 'anthropic') {
    h['x-api-key'] = cfg.apiKey;
    h['anthropic-version'] = '2023-06-01';
  } else if (cfg.apiKey) {
    h.authorization = `Bearer ${cfg.apiKey}`;
  }
  return h;
}

function buildBody(cfg, { system, user, maxTokens, cache }) {
  let extra = {};
  if (cfg.extraBody && typeof cfg.extraBody === 'object') extra = cfg.extraBody;
  if (cfg.format === 'anthropic') {
    const sys = [{ type: 'text', text: system }];
    if (cache) sys[0].cache_control = { type: 'ephemeral' };
    return {
      model: cfg.model,
      system: sys,
      messages: [{ role: 'user', content: user }],
      max_tokens: maxTokens,
      temperature: cfg.temperature,
      stream: true,
      ...extra,
    };
  }
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: cfg.temperature,
    stream: true,
  };
  if (cfg._useMaxCompletionTokens) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  // continuous_usage_stats（vLLM 等支持）：每个数据块都带上累计 token 数，峰值速度就能精确计算
  if (!cfg._noStreamOptions) body.stream_options = cfg._noContinuousUsage ? { include_usage: true } : { include_usage: true, continuous_usage_stats: true };
  if (cfg.ignoreEos && maxTokens > 1) body.ignore_eos = true;
  return { ...body, ...extra };
}

function pickCached(u) {
  return [
    u.prompt_tokens_details?.cached_tokens,
    u.input_tokens_details?.cached_tokens,
    u.prompt_cache_hit_tokens,
    u.cached_tokens,
    u.cache_read_input_tokens,
  ].find(isTokenCount);
}

const isTokenCount = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * 发起一次流式请求。
 * onDelta(text, kind, now, cum) kind = 'content' | 'reasoning'；cum 是服务端给出的累计输出 token 数（不支持时为 null）
 * 返回 { ok, error, status, tStart, tFirst, tEnd, promptTokens, completionTokens, cachedTokens, chunks, chars, gaps }
 */
// 把 fetch 的底层网络错误翻译成看得懂的提示
function netError(e) {
  const c = e && e.cause;
  const code = (c && c.code) || (e && e.name) || '';
  const tip = {
    UND_ERR_CONNECT_TIMEOUT: '连接超时：测速服务器连不上这个地址，请确认接口对外网开放',
    ETIMEDOUT: '连接超时：测速服务器连不上这个地址，请确认接口对外网开放',
    TimeoutError: '请求超时：接口太久没有响应',
    ECONNREFUSED: '连接被拒绝：地址或端口不对，或服务没有启动',
    ENOTFOUND: '域名解析失败：请检查接口地址',
    EAI_AGAIN: '域名解析失败：请检查接口地址',
    ECONNRESET: '连接被重置：可能被防火墙拦截',
  }[code];
  if (tip) return tip;
  if (e && e.message === 'fetch failed' && c) return `网络错误：${c.message || c.code}`;
  return `网络错误：${(e && e.message) || e}`;
}

function request(cfg, url, options) {
  if (!cfg.browserDirect) return fetch(url, options);
  return fetch(url, { ...options, mode: 'cors', credentials: 'omit', redirect: 'error', targetAddressSpace: 'loopback' });
}

function requestError(cfg, e) {
  if (cfg.browserDirect && e instanceof TypeError) {
    return '无法直连你的本机。请检查模型服务和端口，允许本站的本机网络权限，并确认模型服务允许本站跨域访问（CORS）。';
  }
  return netError(e);
}

async function streamRequest(cfg, opts, signal, onDelta, firstStart) {
  const url = endpoint(cfg);
  const requestHeaders = headers(cfg);
  const body = JSON.stringify(buildBody(cfg, opts));
  const r = {
    ok: false,
    error: null,
    status: 0,
    tStart: firstStart ?? performance.now(),
    tFirst: null,
    // 第一个 SSE data 块（含空 delta、usage、[DONE]）的到达时间。tFirst 要求有可见文本，
    // 这个不要求——用于"服务端已经开始响应但拿不到文字"时的兜底延迟
    tFirstChunk: null,
    tEnd: null,
    promptTokens: null,
    completionTokens: null,
    cachedTokens: null,
    chunks: 0,
    chars: 0,
    finishReason: null,
    gaps: [],
    // 每个输出事件的 [到达时间, 累计输出 token 数, 累计中文字符数, 累计其他字符数]。
    // 只有服务端逐块返回用量时第 2 项才非 null；后两项始终有值，
    // 供上层在拿不到逐块用量时按字符曲线估算（见 bench.js 的 estimateMarks）。
    marks: [],
  };
  let lastTokT = null;
  let cjkAcc = 0;
  let otherAcc = 0;
  let res;
  try {
    res = await request(cfg, url, {
      method: 'POST',
      headers: requestHeaders,
      body,
      signal,
      redirect: cfg._noRedirect ? 'error' : 'follow',
    });
  } catch (e) {
    r.tEnd = performance.now();
    r.error = signal && signal.aborted ? 'aborted' : requestError(cfg, e);
    return r;
  }
  r.status = res.status;
  if (!res.ok) {
    let txt = '';
    try {
      txt = await res.text();
    } catch (_) {}
    r.tEnd = performance.now();
    // 有些服务不认识 continuous_usage_stats 或整个 stream_options，逐级降级重试
    if (res.status === 400 && /continuous_usage_stats/i.test(txt) && !cfg._noContinuousUsage) {
      cfg._noContinuousUsage = true;
      return streamRequest(cfg, opts, signal, onDelta, r.tStart);
    }
    if (res.status === 400 && /stream_options/i.test(txt) && !cfg._noStreamOptions) {
      cfg._noStreamOptions = true;
      return streamRequest(cfg, opts, signal, onDelta, r.tStart);
    }
    // 部分新模型（如 OpenAI o 系列 / GPT-5）要求 max_completion_tokens
    if (res.status === 400 && /max_completion_tokens/i.test(txt) && !cfg._useMaxCompletionTokens) {
      cfg._useMaxCompletionTokens = true;
      return streamRequest(cfg, opts, signal, onDelta, r.tStart);
    }
    let msg = txt;
    try {
      const j = JSON.parse(txt);
      msg = (j.error && (j.error.message || j.error)) || j.message || j.detail || txt;
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
    } catch (_) {}
    const hint = explainHttpError(res.status, msg);
    r.error = `HTTP ${res.status}：${String(msg).slice(0, 400)}${hint ? `（${hint}）` : ''}`;
    return r;
  }

  const decoder = new TextDecoder();
  let buf = '';
  let sawData = false;
  let sawDone = false;
  let nonSse = '';
  const anth = cfg.format === 'anthropic';
  const anthUsage = {};

  const handle = (data, now) => {
    sawData = true;
    if (r.tFirstChunk === null) r.tFirstChunk = now;
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    let j;
    try {
      j = JSON.parse(data);
    } catch (_) {
      return;
    }
    if (j.error) {
      r.error = `流式错误：${j.error.message || JSON.stringify(j.error)}`;
      return;
    }
    let text = '';
    let reasoning = '';
    let cum = null;
    if (anth) {
      const u = j.type === 'message_start' ? j.message?.usage : j.type === 'message_delta' ? j.usage : null;
      if (u) {
        for (const field of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
          if (isTokenCount(u[field])) anthUsage[field] = u[field];
        }
        if (anthUsage.input_tokens != null) {
          r.promptTokens = anthUsage.input_tokens + (anthUsage.cache_read_input_tokens ?? 0) + (anthUsage.cache_creation_input_tokens ?? 0);
        }
        r.cachedTokens = anthUsage.cache_read_input_tokens ?? null;
      }
      if (j.type === 'message_stop') {
        sawDone = true;
      } else if (j.type === 'content_block_delta' && j.delta) {
        if (j.delta.type === 'thinking_delta') reasoning = j.delta.thinking;
        else if (j.delta.type === 'text_delta') text = j.delta.text;
      } else if (j.type === 'message_delta') {
        if (isTokenCount(u?.output_tokens)) r.completionTokens = u.output_tokens;
        if (j.delta && j.delta.stop_reason) r.finishReason = j.delta.stop_reason;
      }
    } else {
      const c = j.choices && j.choices[0];
      if (c) {
        const d = c.delta || {};
        reasoning = d.reasoning_content || d.reasoning;
        text = d.content || c.text;
        if (c.finish_reason) r.finishReason = c.finish_reason;
      }
      if (j.usage) {
        if (isTokenCount(j.usage.prompt_tokens)) r.promptTokens = j.usage.prompt_tokens;
        if (isTokenCount(j.usage.completion_tokens)) {
          cum = j.usage.completion_tokens;
          if (j.choices?.length === 0 || c?.finish_reason) r.completionTokens = cum;
        }
        r.cachedTokens = pickCached(j.usage) ?? r.cachedTokens;
      }
    }
    const content = typeof text === 'string' ? text : '';
    const thinking = typeof reasoning === 'string' ? reasoning : '';
    if (content || thinking) {
      if (r.tFirst === null) r.tFirst = now;
      const [cjk, other] = splitCount(content + thinking);
      cjkAcc += cjk;
      otherAcc += other;
      r.marks.push([now, cum, cjkAcc, otherAcc]);
      if (lastTokT !== null) r.gaps.push(now - lastTokT);
      lastTokT = now;
      r.chunks++;
      r.chars += content.length + thinking.length;
      if (onDelta) onDelta(content, thinking, cum);
    }
  };

  try {
    for await (const chunk of res.body) {
      const receivedAt = performance.now();
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) handle(line.slice(5).trim(), receivedAt);
        else if (!sawData && line && nonSse.length < 1000) nonSse += line;
        if (sawDone) {
          r.tEnd = receivedAt;
          break;
        }
      }
      if (sawDone) break;
    }
    if (!sawDone) {
      buf += decoder.decode();
      if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim(), performance.now());
      else if (!sawData && buf.trim() && nonSse.length < 1000) nonSse += buf.trim();
    }
  } catch (e) {
    r.tEnd = performance.now();
    r.error = signal && signal.aborted ? 'aborted' : `读取流失败：${e.message}`;
    return r;
  }
  r.tEnd ??= performance.now();
  if (!sawData && nonSse) {
    try {
      const j = JSON.parse(nonSse);
      const errMsg = (j.error && (j.error.message || j.error)) || j.message || j.detail || j.msg;
      if (errMsg) r.error = `接口返回错误：${typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)}`.slice(0, 400);
    } catch (_) {
      r.error = `非 SSE 响应：${nonSse.slice(0, 200)}`;
    }
  }
  if (!r.error && !sawData) r.error = '接口没有返回 SSE 事件';
  if (!r.error && !sawDone && (anth || !r.finishReason)) r.error = '输出流缺少结束事件';
  if (!r.error) r.ok = true;
  return r;
}

async function listModels(cfg) {
  const h = headers(cfg);
  delete h.accept;
  let res;
  try {
    res = await request(cfg, modelsEndpoint(cfg), { headers: h, signal: AbortSignal.timeout(15000), redirect: cfg._noRedirect ? 'error' : 'follow' });
  } catch (e) {
    throw new Error(requestError(cfg, e));
  }
  const txt = await res.text();
  if (!res.ok) {
    const hint = explainHttpError(res.status, txt);
    throw new Error(`HTTP ${res.status}：${txt.slice(0, 300)}${hint ? `（${hint}）` : ''}`);
  }
  const j = JSON.parse(txt);
  const arr = j.data || j.models || (Array.isArray(j) ? j : []);
  return arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}

module.exports = { streamRequest, listModels, endpoint, splitCount };
