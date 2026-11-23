'use strict';
const crypto = require('crypto');
const { streamRequest, splitCount } = require('./client');
const D = require('./dataset');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nonce = () => crypto.randomBytes(6).toString('hex');

function stats(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
  return {
    min: a[0],
    max: a[a.length - 1],
    avg: a.reduce((s, x) => s + x, 0) / a.length,
    p50: q(0.5),
    p90: q(0.9),
    p99: q(0.99),
  };
}

function clamp(v, lo, hi, d) {
  v = Number(v);
  if (!Number.isFinite(v)) return d;
  return Math.min(hi, Math.max(lo, v));
}

function applyThinkingMode(cfg) {
  if (cfg.thinkingMode === 'default') return;
  if (cfg.format !== 'openai') throw new Error('这个思考模式快捷开关仅适用于兼容的 OpenAI 格式接口');

  const enabled = cfg.thinkingMode === 'on';
  const hostname = new URL(cfg.baseUrl).hostname;
  const extra = { ...cfg.extraBody };
  if (hostname === 'dashscope.aliyuncs.com' || hostname === 'dashscope-intl.aliyuncs.com') {
    extra.enable_thinking = enabled;
  } else {
    const field = hostname === 'api.deepseek.com' ? 'thinking' : 'chat_template_kwargs';
    const previous = extra[field];
    if (previous != null && (typeof previous !== 'object' || Array.isArray(previous))) {
      throw new Error(`额外请求参数的 ${field} 必须是 JSON 对象`);
    }
    if (field === 'thinking') {
      extra.thinking = { ...previous, type: enabled ? 'enabled' : 'disabled' };
    } else {
      // vLLM / SGLang 从聊天模板参数读取开关。
      delete extra.enable_thinking;
      extra.chat_template_kwargs = { ...previous, enable_thinking: enabled };
    }
  }
  cfg.extraBody = extra;
}

function normalizeConfig(c) {
  const conc = c.concurrency != null ? c.concurrency : c.decodeConcurrency != null ? c.decodeConcurrency : c.prefillConcurrency;
  const cfg = {
    baseUrl: String(c.baseUrl || '').trim(),
    apiKey: String(c.apiKey || '').trim(),
    browserDirect: c.browserDirect === true,
    model: String(c.model || '').trim(),
    format: c.format === 'anthropic' ? 'anthropic' : 'openai',
    thinkingMode: ['on', 'off'].includes(c.thinkingMode) ? c.thinkingMode : 'default',
    concurrency: Math.round(clamp(conc, 1, 64, 8)),
    contextTokens: Math.round(clamp(c.contextTokens, 1000, 262144, 16000)),
    maxTokens: Math.round(clamp(c.maxTokens, 16, 65536, 2048)),
    singleMaxTokens: Math.round(clamp(c.singleMaxTokens, 16, 65536, 2048)),
    temperature: clamp(c.temperature, 0, 2, 0.6),
    ignoreEos: !!c.ignoreEos,
    runPrefill: c.runPrefill !== false,
    runSingle: c.runSingle !== false,
    runDecode: c.runDecode !== false,
    extraBody: null,
    _noRedirect: !!c._noRedirect,
  };
  if (c.extraBody) {
    if (typeof c.extraBody === 'object') cfg.extraBody = c.extraBody;
    else {
      try {
        cfg.extraBody = JSON.parse(c.extraBody);
      } catch (_) {
        throw new Error('额外请求参数不是合法 JSON');
      }
    }
  }
  if (cfg.extraBody !== null) {
    if (typeof cfg.extraBody !== 'object' || Array.isArray(cfg.extraBody)) throw new Error('额外请求参数必须是 JSON 对象');
    const reserved = ['model', 'system', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'n', 'best_of', 'ignore_eos'];
    const conflict = reserved.find((key) => Object.hasOwn(cfg.extraBody, key));
    if (conflict) throw new Error(`额外请求参数不能覆盖测速字段：${conflict}`);
  }
  if (!/^https?:\/\//i.test(cfg.baseUrl)) throw new Error('Base URL 需以 http:// 或 https:// 开头');
  if (!cfg.model) throw new Error('请填写模型名称');
  applyThinkingMode(cfg);
  return cfg;
}

/**
 * 分词比例：每个中文字符、每个其他“词”（见 client.splitCount）各约多少 token。
 * 读取阶段结束后用 8 份资料的真实 token 数重新拟合。
 * 只在服务端不逐块返回累计 token 数时才用它估算；
 * 不能按数据块数估算：MTP 每块会带 1~5 个不等的 token，中转服务也可能把多个 token 打包成一块。
 */
function makeTokenizer() {
  return { a: 0.65, b: 0.62, fitted: false };
}
const estTokens = (tz, cjk, other) => tz.a * cjk + tz.b * other;

/** 最小二乘拟合 tokens ≈ a·中文字符 + b·其他字符；样本里中文太少或结果离谱时保持原值 */
function fitTokenizer(tz, samples) {
  if (samples.length < 2) return;
  let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
  for (const [x1, x2, y] of samples) {
    s11 += x1 * x1;
    s12 += x1 * x2;
    s22 += x2 * x2;
    t1 += x1 * y;
    t2 += x2 * y;
  }
  const det = s11 * s22 - s12 * s12;
  if (det <= 1e-6 * s11 * s22) return;
  const a = (t1 * s22 - t2 * s12) / det;
  const b = (t2 * s11 - t1 * s12) / det;
  if (a >= 0.25 && a <= 1.6 && b >= 0.2 && b <= 1.5) Object.assign(tz, { a, b, fitted: true });
}

/**
 * 把多路流式输出攒起来，每 70ms 推一次 tick 事件给前端。
 * tok 是已生成 token 数：服务端逐块给了累计数就用准确值，否则按输出文本估算。
 */
function makeTicker(n, emit, phase, tz) {
  const st = Array.from({ length: n }, () => ({ d: '', r: '', cjk: 0, other: 0, cum: null, c: 0, sent: false }));
  const t0 = performance.now();
  const est = (i) => (st[i].cum != null ? st[i].cum : Math.round(estTokens(tz, st[i].cjk, st[i].other)));
  const flush = () => {
    const lanes = [];
    st.forEach((s, i) => {
      if (s.d || s.r || s.c || !s.sent) {
        lanes.push({ i, d: s.d || undefined, r: s.r || undefined, tok: est(i), c: s.c });
        s.d = '';
        s.r = '';
        s.c = 0;
        s.sent = true;
      }
    });
    if (lanes.length) emit({ type: 'tick', phase, t: (performance.now() - t0) / 1000, lanes });
  };
  const timer = setInterval(flush, 70);
  return {
    onDelta: (i) => (content, reasoning, cum) => {
      const s = st[i];
      if (cum != null) s.cum = cum;
      const [cjk, other] = splitCount(content + reasoning);
      s.c++;
      s.cjk += cjk;
      s.other += other;
      s.r += reasoning;
      s.d += content;
    },
    stop() {
      clearInterval(timer);
      flush();
    },
  };
}

/** 解码速度只使用首末输出事件之间实际报告的 token 增量。 */
function laneResult(i, r) {
  const stopped = !r.ok && r.error === 'aborted';
  const tokens = r.ok ? r.completionTokens : null;
  const first = r.marks[0];
  const last = r.marks.at(-1);
  const dur = first && last ? (last[0] - first[0]) / 1000 : 0;
  // 同一次网络读取中的 SSE 事件拥有相同的观测时间。
  const next = dur > 0 ? r.marks.findIndex(([time]) => time > first[0]) : 0;
  const firstCount = next > 0 ? r.marks[next - 1][1] : null;
  const hasCounts = first?.[1] > 0 && r.marks.every((m, k) => Number.isSafeInteger(m[1]) && (k === 0 || m[1] >= r.marks[k - 1][1])) &&
    (r.completionTokens == null || last[1] <= r.completionTokens);
  const ok = (r.ok || stopped) && first != null;
  return {
    i,
    ok,
    stopped,
    error: ok || stopped ? null : r.error || '接口没有返回文本或推理输出',
    ttft: first ? first[0] - r.tStart : null,
    tokens,
    speed: ok && hasCounts && dur > 0 && last[1] > firstCount ? (last[1] - firstCount) / dur : null,
    decodeMarks: hasCounts ? r.marks : null,
    cachedTokens: r.cachedTokens != null && r.cachedTokens <= r.promptTokens ? r.cachedTokens : null,
    promptTokens: r.promptTokens,
    finishReason: r.finishReason,
    gaps: r.gaps,
    tStart: r.tStart,
    tEnd: r.tEnd,
  };
}
const PEAK_WIN_MS = 2000;

/** 固定窗口 (end - 2s, end]，只统计首末输出事件之间的完整窗口。 */
function peakRate(marks) {
  const earliestEnd = marks[0][0] + PEAK_WIN_MS;
  if (marks.at(-1)[0] < earliestEnd) return null;
  let best = 0;
  let left = 0;
  let right = 0;
  while (right < marks.length) {
    const end = Math.max(earliestEnd, marks[right][0]);
    while (marks[right + 1]?.[0] <= end) right++;
    while (marks[left + 1]?.[0] <= end - PEAK_WIN_MS) left++;
    best = Math.max(best, marks[right][1] - marks[left][1]);
    right++;
  }
  return best / (PEAK_WIN_MS / 1000);
}

/** 各路共用 (最后一个首包, 最早一个末包]，按该窗口内收到的累计用量差计算。 */
function overlappingDecode(marks) {
  if (!marks.length || marks.some((lane) => !lane?.length)) return null;
  const start = Math.max(...marks.map((lane) => lane[0][0]));
  const end = Math.min(...marks.map((lane) => lane.at(-1)[0]));
  const windowMs = end - start;
  if (windowMs <= 0) return null;

  let tokens = 0;
  for (const lane of marks) {
    let from = 0;
    let to = 0;
    for (const [time, count] of lane) {
      if (time > end) break;
      if (time <= start) from = count;
      to = count;
    }
    tokens += to - from;
  }
  return { tokens, windowMs, throughput: tokens / (windowMs / 1000) };
}

const publicLane = ({ decodeMarks, gaps, tStart, tEnd, ...x }) => x;

/**
 * 运行一次完整测速：延迟 → 读取 → 单发峰值 → 并发生成。
 * emit(event) 推送事件；ctl 用于外部中止（master）或提前结束当前生成阶段（stopDecode）。
 */
async function runBenchmark(rawCfg, emit, ctl) {
  const cfg = normalizeConfig(rawCfg);
  const runId = ctl.id;
  const T0 = performance.now();
  const summary = { config: { ...cfg, apiKey: undefined }, startedAt: Date.now() };
  const master = ctl.master;
  const n = cfg.concurrency;

  // ---------------- 1. 延迟 ----------------
  emit({ type: 'phase', phase: 'ping' });
  const pingSys = 'You are a helpful assistant.';
  const pings = [];
  let pingPrompt = null;
  let warmMs = null;
  let pingApprox = false; // 拿不到可见文本，退化成"首个 SSE 数据块"口径
  let pingReason = null; // 连数据块都没有时的原因
  // 探针默认只要 1 个 token：生成得越少，"排队 + prefill + 首个 token" 的时间越纯粹。
  // 但思考型模型（Qwen3 等）的第一个 token 常常是思考起始标记，会被 skip_special_tokens 过滤成
  // 空字符串，多字节字符的首字节还会被增量解码器攒住——1 个 token 时一个可见字符都拿不到。
  // 这时放宽到 16 个 token 再试：首包时间取第一个非空增量的到达时刻，与 max_tokens 无关，
  // 所以放宽只影响能不能测到，不改变这个指标的含义。
  const PING_TOKENS = 1;
  const PING_RETRY_TOKENS = 16;
  let pingTokens = PING_TOKENS;
  for (let i = 0; i < 4; i++) {
    if (master.signal.aborted) return;
    let r = await streamRequest(cfg, { system: pingSys, user: D.PING_USER, maxTokens: pingTokens }, master.signal);
    if (r.ok && r.tFirst == null && pingTokens < PING_RETRY_TOKENS) {
      pingTokens = PING_RETRY_TOKENS;
      r = await streamRequest(cfg, { system: pingSys, user: D.PING_USER, maxTokens: pingTokens }, master.signal);
    }
    // 有可见文本但缺结束事件（部分网关不发 [DONE]）仍可以用来测延迟，不当成失败
    if (!r.ok && r.tFirst == null) {
      if (master.signal.aborted) return;
      // 鉴权、路径、模型名这类错误换到别的阶段也一样失败，直接中止；
      // 超时、5xx、缺结束事件只影响延迟这一项，降级成"延迟不可用"，把吞吐测试跑完
      const fatal = [400, 401, 403, 404, 422].includes(r.status) || /非 SSE 响应|接口返回错误/.test(r.error || '');
      if (fatal) throw new Error(`连接测试失败 · ${r.error}`);
      pingReason = r.error || '连接测试没有拿到响应';
      break;
    }
    // 首选口径：第一个非空文本/推理增量
    let ms = r.tFirst != null ? r.tFirst - r.tStart : null;
    let approx = false;
    // 兜底口径：流里已经有 SSE 数据块，只是没有任何可见文本。用首块到达时间代替，
    // 含义从"第一个字到达"变成"服务端开始响应"，比整项不可用更有参考价值
    if (ms == null && r.tFirstChunk != null) {
      ms = r.tFirstChunk - r.tStart;
      approx = true;
    }
    // 连数据块都没有：延迟确实测不出来，但降级而不是中止——吞吐测试照样能跑
    if (ms == null) {
      pingReason = r.finishReason === 'length' ? `首个 token 就被 max_tokens=${pingTokens} 截断`
        : r.finishReason ? `模型直接结束（finish_reason=${r.finishReason}）`
          : '流里没有任何文本或推理增量';
      break;
    }
    if (approx) pingApprox = true;
    if (i === 0) warmMs = ms; // 第一次包含 TLS 握手，只做兜底不放样本
    else pings.push(ms);
    if (r.promptTokens) pingPrompt = r.promptTokens;
    emit({ type: 'ping_sample', i, ms, warm: i === 0, approx });
    await sleep(120);
  }
  const samples = pings.length ? pings : warmMs != null ? [warmMs] : [];
  const ps = samples.length ? stats(samples) : null;
  const jitter = pings.length > 1 ? pings.slice(1).reduce((s, x, k) => s + Math.abs(x - pings[k]), 0) / (pings.length - 1) : 0;
  summary.ping = ps
    ? { min: ps.min, avg: ps.avg, jitter, tokens: pingTokens, approx: pingApprox || undefined }
    : { min: null, avg: null, jitter: null, tokens: pingTokens, unavailable: true, reason: pingReason || '没有收到任何响应数据' };
  emit({ type: 'ping_result', ...summary.ping });

  // ---------------- 2. 校准分词比例 ----------------
  if (master.signal.aborted) return;
  emit({ type: 'phase', phase: 'calibrate' });
  const calSys = `[session ${nonce()}]\n` + D.HEADER + D.buildCorpus(8000, 'cal') + D.FOOTER;
  const cal = await streamRequest(cfg, { system: calSys, user: D.PREFILL_USER, maxTokens: 1 }, master.signal);
  if (master.signal.aborted) return;
  // 校准只用来把"字符数 → token 数"估得更准，拿不到就退回默认比例继续，
  // 不该让它把整轮测试拦下来（资料长度会因此略有偏差，结果里 usageOk 会是 false）
  let charsPerToken = 3.2;
  let usageOk = false;
  let calTtft = null;
  let estSingleTps = null;
  const pingChars = pingSys.length + D.PING_USER.length;
  const calChars = calSys.length + D.PREFILL_USER.length;
  if (cal.ok) {
    if (cal.promptTokens && pingPrompt && cal.promptTokens > pingPrompt + 100) {
      charsPerToken = clamp((calChars - pingChars) / (cal.promptTokens - pingPrompt), 1.2, 6.5, 3.2);
      usageOk = true;
    }
    const calTokens = cal.promptTokens || Math.round(calChars / charsPerToken);
    calTtft = cal.tFirst != null ? cal.tFirst - cal.tStart : null;
    estSingleTps = calTokens / Math.max(0.02, ((calTtft ?? cal.tEnd - cal.tStart) - (ps?.min ?? 0) * 0.9) / 1000);
  }
  summary.calibrate = { charsPerToken, usageOk, calTokens: cal.ok ? cal.promptTokens : null, calTtft, ...(cal.ok ? {} : { degraded: cal.error }) };
  emit({ type: 'calibrate_result', charsPerToken, usageOk, estSingleTps });

  // 每路一份领域资料：读取阶段先读一遍（顺便写入缓存），并发生成阶段原样复用作前缀
  const docs = [];
  for (let i = 0; i < n; i++) docs.push({ ...D.buildDomainDoc(i, cfg.contextTokens, charsPerToken, `${runId}-${i}-${nonce()}`), warm: false });
  const tz = makeTokenizer();
  const docCounts = docs.map((d) => splitCount(d.system + D.PREFILL_USER));

  // ---------------- 3. 读取速度 ----------------
  if (cfg.runPrefill) {
    emit({ type: 'phase', phase: 'prefill' });
    const estSeconds = Math.min(600, Math.max(1.5, (n * cfg.contextTokens) / (estSingleTps * Math.min(n, 4) * 0.8)));
    emit({
      type: 'prefill_start',
      n,
      targetTokens: cfg.contextTokens,
      estSeconds,
      lanes: docs.map((d, i) => ({ i, domain: d.domain.name, doc: d.domain.doc })),
    });
    const tStart = performance.now();
    const results = await Promise.all(
      docs.map(async (d, i) => {
        const r = await streamRequest(cfg, { system: d.system, user: D.PREFILL_USER, maxTokens: 1, cache: true }, master.signal);
        const tDone = r.tFirst;
        const ok = r.ok && tDone != null;
        const out = {
          i,
          ok,
          error: ok ? null : r.error || '接口没有返回文本或推理输出',
          ttft: tDone != null ? tDone - r.tStart : null,
          promptTokens: r.promptTokens > 0 ? r.promptTokens : null,
          cachedTokens: r.cachedTokens != null && r.cachedTokens <= r.promptTokens ? r.cachedTokens : null,
          tDone,
          tStart: r.tStart,
        };
        d.warm = ok; // 仅代表前缀已发送，实际是否命中以 Decode 用量为准
        out.speed = ok && out.promptTokens != null && out.ttft > 0 ? out.promptTokens / (out.ttft / 1000) : null;
        if (!master.signal.aborted) emit({ type: 'prefill_lane', ...out, tDone: undefined, tStart: undefined, at: tDone != null ? (tDone - tStart) / 1000 : null });
        return out;
      })
    );
    if (master.signal.aborted) return;
    const ok = results.filter((r) => r.ok);
    if (!ok.length) throw new Error(`读取测试全部失败 · ${results[0].error}`);
    const wall = Math.max(...ok.map((r) => r.tDone)) - Math.min(...results.map((r) => r.tStart));
    const withUsage = ok.filter((r) => r.promptTokens != null);
    const totalTokens = withUsage.length === n ? withUsage.reduce((s, r) => s + r.promptTokens, 0) : null;
    // 用 8 份资料（加上校准请求）的真实 token 数拟合分词比例
    const samples = withUsage.map((r) => [...docCounts[r.i], r.promptTokens]);
    if (cal.promptTokens) samples.push([...splitCount(calSys + D.PREFILL_USER), cal.promptTokens]);
    fitTokenizer(tz, samples);
    const avgSpeed = totalTokens != null ? stats(ok.map((r) => r.speed))?.avg ?? null : null;
    summary.prefill = {
      throughput: wall > 0 && totalTokens != null ? totalTokens / (wall / 1000) : null,
      // 单路平均：每路「资料 token 数 ÷ 首字时间」再取平均，是每个用户实际感受到的读取速度
      avgSpeed,
      perRequest: avgSpeed,
      totalTokens,
      avgPromptTokens: totalTokens != null ? totalTokens / n : null,
      minPromptTokens: withUsage.length ? Math.min(...withUsage.map((r) => r.promptTokens)) : null,
      maxPromptTokens: withUsage.length ? Math.max(...withUsage.map((r) => r.promptTokens)) : null,
      wallMs: wall,
      ttft: stats(ok.map((r) => r.ttft)),
      ok: ok.length,
      failed: results.length - ok.length,
      cachedTokens: totalTokens != null && ok.every((r) => r.cachedTokens != null) ? ok.reduce((s, r) => s + r.cachedTokens, 0) : null,
      errors: results.filter((r) => !r.ok).map((r) => r.error),
    };
    emit({ type: 'prefill_result', ...summary.prefill });
    await sleep(500);
  }

  // 生成阶段的“够了，直接出结果”：只结束当前阶段，不影响后续
  const stage = () => {
    const ac = new AbortController();
    const onMaster = () => ac.abort();
    master.signal.addEventListener('abort', onMaster);
    let byUser = false;
    ctl.stopDecode = () => {
      byUser = true;
      ac.abort();
    };
    return {
      signal: ac.signal,
      abort: () => ac.abort(),
      get byUser() {
        return byUser;
      },
      done() {
        master.signal.removeEventListener('abort', onMaster);
        ctl.stopDecode = null;
      },
    };
  };

  // ---------------- 4. 单发峰值 ----------------
  if (master.signal.aborted) return;
  if (cfg.runSingle) {
    emit({ type: 'phase', phase: 'single' });
    emit({ type: 'single_start', domain: 'Python 代码', maxTokens: cfg.singleMaxTokens });
    const sc = stage();
    const tk = makeTicker(1, emit, 'single', tz);
    const r = await streamRequest(cfg, { system: D.SINGLE_SYSTEM, user: D.SINGLE_TASK, maxTokens: cfg.singleMaxTokens }, sc.signal, tk.onDelta(0));
    tk.stop();
    sc.done();
    if (master.signal.aborted) return;
    const out = laneResult(0, r);
    if (!out.ok) throw new Error(`单发测试失败 · ${out.error || '没有输出'}`);
    const peak = out.speed != null ? peakRate(r.marks) : null;
    const wallMs = r.tEnd - r.tStart;
    summary.single = {
      ...publicLane(out),
      peak,
      peakExact: peak != null,
      e2eSpeed: out.tokens != null && wallMs > 0 ? out.tokens / (wallMs / 1000) : null,
      wallMs,
      chunkGap: stats(out.gaps),
      byUser: sc.byUser,
    };
    emit({ type: 'single_result', ...summary.single });
    await sleep(500);
  }

  // ---------------- 5. 并发生成 ----------------
  if (master.signal.aborted) return;
  if (cfg.runDecode) {
    emit({ type: 'phase', phase: 'decode' });
    emit({
      type: 'decode_start',
      n,
      maxTokens: cfg.maxTokens,
      lanes: docs.map((d, i) => ({ i, domain: d.domain.name, doc: d.domain.doc, reuse: d.warm })),
    });
    const sc = stage();
    const tk = makeTicker(n, emit, 'decode', tz);
    // 每一路都等它正常写完，这样每路都能拿到服务端返回的准确 token 数
    const results = await Promise.all(
      docs.map(async (d, i) => {
        const r = await streamRequest(
          cfg,
          { system: d.system, user: d.domain.task + D.LONG_SUFFIX, maxTokens: cfg.maxTokens, cache: true },
          sc.signal,
          tk.onDelta(i)
        );
        const out = laneResult(i, r);
        if (!master.signal.aborted) emit({ type: 'decode_lane', ...publicLane(out), domain: d.domain.name });
        return out;
      })
    );
    tk.stop();
    sc.done();
    if (master.signal.aborted) return;
    const ok = results.filter((r) => r.ok);
    if (!ok.length) throw new Error(`并发测试全部失败 · ${results[0].error || '没有输出'}`);
    const speeds = ok.map((r) => r.speed).filter(Number.isFinite);
    const windowMs = Math.max(...results.map((r) => r.tEnd)) - Math.min(...results.map((r) => r.tStart));
    const complete = ok.length === n && ok.every((r) => !r.stopped);
    const totalTokens = complete && ok.every((r) => r.tokens != null) ? ok.reduce((s, r) => s + r.tokens, 0) : null;
    const promptTokens = complete && ok.every((r) => r.promptTokens > 0) ? ok.reduce((s, r) => s + r.promptTokens, 0) : null;
    const cachedTokens = promptTokens != null && ok.every((r) => r.cachedTokens != null) ? ok.reduce((s, r) => s + r.cachedTokens, 0) : null;
    summary.decode = {
      n,
      overlap: complete ? overlappingDecode(results.map((r) => r.decodeMarks)) : null,
      // 整轮输出用量除以共同的端到端墙钟时间。
      throughput: totalTokens != null && windowMs > 0 ? totalTokens / (windowMs / 1000) : null,
      avgSpeed: complete && speeds.length === n ? speeds.reduce((a, b) => a + b, 0) / n : null,
      minSpeed: complete && speeds.length === n ? Math.min(...speeds) : null,
      maxSpeed: complete && speeds.length === n ? Math.max(...speeds) : null,
      totalTokens,
      windowMs,
      ttft: stats(ok.map((r) => r.ttft)),
      chunkGap: stats(ok.flatMap((r) => r.gaps)),
      cachedTokens,
      promptTokens,
      cacheHitRate: cachedTokens != null && promptTokens > 0 ? cachedTokens / promptTokens : null,
      byUser: sc.byUser,
      lanes: results.map((r) => ({ i: r.i, domain: docs[r.i].domain.name, ok: r.ok, speed: r.speed, tokens: r.tokens, ttft: r.ttft, stopped: r.stopped })),
      ok: ok.length,
      failed: results.length - ok.length,
      errors: results.filter((r) => r.error).map((r) => r.error),
    };
    emit({ type: 'decode_result', ...summary.decode });
  }

  summary.tokenizer = { cjk: tz.a, other: tz.b, fitted: tz.fitted };
  summary.totalMs = performance.now() - T0;
  emit({ type: 'phase', phase: 'done' });
  emit({ type: 'done', summary });
}

module.exports = { runBenchmark, normalizeConfig, overlappingDecode };
