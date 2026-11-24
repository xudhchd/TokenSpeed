'use strict';
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { normalizeConfig, overlappingDecode, runBenchmark } = require('../lib/bench');
const { streamRequest } = require('../lib/client');
const { buildBrowserBundle } = require('../lib/browser-bundle');

async function withUpstream(handler, check) {
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const request = JSON.parse(Buffer.concat(parts));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event) => res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
    try {
      await handler(request, send);
    } catch (error) {
      res.destroy(error);
    } finally {
      res.end();
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await check(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    server.close();
    server.closeAllConnections?.();
    await once(server, 'close');
  }
}

async function withStatus(status, check) {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: status === 401 ? 'invalid token' : 'upstream error' } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await check(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    server.close();
    server.closeAllConnections?.();
    await once(server, 'close');
  }
}

function openAIChunk(send, count) {
  send({
    choices: [{ delta: { content: 'some text' } }],
    usage: count == null ? null : { completion_tokens: count },
  });
}

function openAIFinish(send, usage) {
  send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  if (usage) send({ choices: [], usage });
  send('[DONE]');
}

async function run(baseUrl, config = {}, onEvent) {
  const ctl = { id: 'fixture', master: new AbortController() };
  let summary;
  await runBenchmark({ baseUrl, model: 'fixture', concurrency: 2, contextTokens: 1000, ...config }, (ev) => {
    if (ev.type === 'done') summary = ev.summary;
    onEvent?.(ev, ctl);
  }, ctl);
  return summary;
}

test('uses a fixed peak window and one shared batch duration with staggered streams', async () => {
  await withUpstream(async (req, send) => {
    const system = req.messages[0].content;
    if (req.max_tokens === 1) {
      openAIChunk(send, 1);
      openAIFinish(send, { completion_tokens: 1, prompt_tokens: system.includes('<material>') ? 1500 : system.length });
    } else if (!system.includes('<material>')) {
      openAIChunk(send, 4);
      for (const [delay, count] of [[500, 7], [350, 11], [650, 16], [760, 22]]) {
        await sleep(delay);
        openAIChunk(send, count);
      }
      await sleep(400);
      openAIFinish(send, { completion_tokens: 22, prompt_tokens: 100 });
    } else {
      const slow = system.includes('前端移植题库');
      await sleep(slow ? 80 : 20);
      openAIChunk(send, 5);
      await sleep(slow ? 360 : 210);
      openAIChunk(send, 25);
      openAIFinish(send, { completion_tokens: 25, prompt_tokens: 1600, prompt_tokens_details: { cached_tokens: slow ? 0 : 800 } });
    }
  }, async (baseUrl) => {
    const s = await run(baseUrl);
    assert.equal(s.prefill.totalTokens, 3000);
    assert.equal(s.prefill.throughput, 3000 / (s.prefill.wallMs / 1000));
    assert.equal(s.prefill.cachedTokens, null);
    assert.equal(s.single.peak, 9);
    assert.equal(s.single.tokens, 22);
    assert.ok(Math.abs(s.single.speed - 18 / (s.single.chunkGap.avg * 4 / 1000)) < 1e-9);
    assert.equal(s.single.e2eSpeed, 22 / (s.single.wallMs / 1000));
    assert.ok(s.single.wallMs - s.single.chunkGap.avg * 4 >= 350);
    assert.equal(s.decode.totalTokens, 50);
    assert.equal(s.decode.throughput, 50 / (s.decode.windowMs / 1000));
    assert.ok(s.decode.throughput < s.decode.lanes.reduce((sum, lane) => sum + lane.speed, 0));
    assert.equal(s.decode.overlap.tokens, 20);
    assert.equal(s.decode.overlap.throughput, 20 / (s.decode.overlap.windowMs / 1000));
    assert.ok(s.decode.overlap.windowMs < s.decode.windowMs);
    assert.equal(s.decode.cacheHitRate, 0.25);
  });
});

test('counts only token arrivals within one common 8-lane decode window', () => {
  const fast = [[0, 4], [1000, 14], [1000, 19], [2000, 39], [3000, 59]];
  const lastToStart = [[1000, 6], [1500, 11], [2500, 21], [4000, 63]];
  const longTail = [[500, 3], [1000, 8], [2500, 28], [8000, 300]];
  const lanes = [fast, lastToStart, ...Array(6).fill(longTail)];
  assert.deepEqual(overlappingDecode(lanes), { tokens: 175, windowMs: 2000, throughput: 87.5 });
  assert.deepEqual(overlappingDecode([fast, lastToStart, ...Array(6).fill([...longTail, [30000, 800]])]), overlappingDecode(lanes));
  assert.equal(overlappingDecode([fast, [[3000, 5], [4000, 20]]]), null);
  assert.equal(overlappingDecode([fast, null]), null);
});

test('missing and final-only usage produce different available metrics', async () => {
  await withUpstream(async (req, send) => {
    openAIChunk(send);
    if (req.max_tokens > 1) {
      await sleep(20);
      openAIChunk(send);
      openAIFinish(send, { completion_tokens: 32, prompt_tokens: 1000 });
    } else {
      openAIFinish(send);
    }
  }, async (baseUrl) => {
    const s = await run(baseUrl);
    assert.equal(s.prefill.ok, 2);
    assert.equal(s.prefill.throughput, null);
    assert.equal(s.prefill.totalTokens, null);
    assert.equal(s.single.peak, null);
    assert.equal(s.single.speed, null);
    assert.ok(s.single.e2eSpeed > 0);
    assert.equal(s.decode.totalTokens, 64);
    assert.ok(s.decode.throughput > 0);
    assert.equal(s.decode.overlap, null);
    assert.equal(s.decode.avgSpeed, null);
    assert.equal(s.decode.cacheHitRate, null);
  });
});

test('final-only usage falls back to a character-estimated curve, never to the exact fields', async () => {
  // 官方 OpenAI / DeepSeek 的流只在最后一块带 usage，中间块 usage 为 null
  await withUpstream(async (req, send) => {
    const prompt = req.messages[0].content.length;
    if (req.max_tokens <= 1) {
      openAIChunk(send);
      openAIFinish(send, { completion_tokens: 1, prompt_tokens: prompt });
      return;
    }
    for (let k = 0; k < 6; k++) {
      if (k) await sleep(500);
      send({ choices: [{ delta: { content: '中文输出内容示例abc' } }], usage: null });
    }
    openAIFinish(send, { completion_tokens: 120, prompt_tokens: prompt });
  }, async (baseUrl) => {
    const s = await run(baseUrl);
    // 精确口径保持不可用，估算口径单独给出
    assert.equal(s.single.speed, null);
    assert.equal(s.single.peak, null);
    assert.ok(s.single.speedEst > 0);
    assert.ok(s.single.peakEst > 0);
    // 6 块 × 500ms 覆盖了完整 2 秒窗口
    assert.ok(s.single.speedEst < s.single.peakEst);
    assert.equal(s.decode.overlap, null);
    assert.equal(s.decode.avgSpeed, null);
    assert.ok(s.decode.overlapEst.throughput > 0);
    assert.ok(s.decode.avgSpeedEst > 0);
    assert.ok(s.decode.minSpeedEst <= s.decode.maxSpeedEst);
    // 估算曲线的终点必须严格等于上游报告的总用量
    assert.equal(s.decode.totalTokens, 240);
  });
});

test('an estimated curve is dropped when the total usage is missing', async () => {
  await withUpstream(async (req, send) => {
    if (req.max_tokens <= 1) {
      openAIChunk(send);
      openAIFinish(send, { completion_tokens: 1, prompt_tokens: 100 });
      return;
    }
    openAIChunk(send);
    await sleep(30);
    openAIChunk(send);
    openAIFinish(send); // 连末尾汇总都没有
  }, async (baseUrl) => {
    const s = await run(baseUrl);
    assert.equal(s.single.speed, null);
    assert.equal(s.single.speedEst, null);
    assert.equal(s.decode.avgSpeedEst, null);
  });
});


test('empty and truncated streams degrade to a first-chunk latency instead of aborting', async () => {
  // 流完整但没有任何可见文本：放宽到 16 token 也拿不到，退化成"首个 SSE 数据块到达"
  await withUpstream((_, send) => openAIFinish(send, { prompt_tokens: 20, completion_tokens: 1 }), async (baseUrl) => {
    const s = await run(baseUrl, { runPrefill: false, runSingle: false, runDecode: false });
    assert.equal(s.ping.tokens, 16);
    assert.equal(s.ping.approx, true);
    assert.ok(Number.isFinite(s.ping.min));
  });
  // 有内容但缺结束事件：首包时间已经拿到，按可用处理，不因此中止整轮
  await withUpstream((_, send) => openAIChunk(send, 1), async (baseUrl) => {
    const s = await run(baseUrl, { runPrefill: false, runSingle: false, runDecode: false });
    assert.equal(s.ping.tokens, 1);
    assert.ok(Number.isFinite(s.ping.min));
  });
});

test('auth failures abort the run, transient upstream errors only degrade the latency', async () => {
  // 401 换到哪个阶段都不会成功，直接中止
  await withStatus(401, async (baseUrl) => {
    await assert.rejects(run(baseUrl), /连接测试失败/);
  });
  // 500 只让延迟这一项不可用，后面的阶段照常尝试
  await withStatus(500, async (baseUrl) => {
    const s = await run(baseUrl, { runPrefill: false, runSingle: false, runDecode: false });
    assert.equal(s.ping.unavailable, true);
    assert.match(s.ping.reason, /HTTP 500/);
  });
});

test('a last partial counter is not used as final request usage', async () => {
  await withUpstream(async (_, send) => {
    openAIChunk(send, 2);
    await sleep(30);
    openAIChunk(send, 9);
    openAIFinish(send);
  }, async (baseUrl) => {
    const r = await streamRequest(normalizeConfig({ baseUrl, model: 'fixture' }), { system: 'test', user: 'test', maxTokens: 16 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.marks.map((mark) => mark[1]), [2, 9]);
    assert.equal(r.completionTokens, null);
  });
});

test('an interrupted generation stage cannot publish a batch throughput', async () => {
  await withUpstream(async (req, send) => {
    openAIChunk(send, 1);
    if (req.max_tokens > 1) await sleep(200);
    openAIFinish(send, { completion_tokens: 1, prompt_tokens: 20 });
  }, async (baseUrl) => {
    const s = await run(baseUrl, { runPrefill: false, runSingle: false }, (ev, ctl) => {
      if (ev.type === 'tick' && ev.phase === 'decode' && ev.lanes.some((lane) => lane.c > 0)) ctl.stopDecode();
    });
    assert.equal(s.decode.byUser, true);
    assert.equal(s.decode.overlap, null);
    assert.equal(s.decode.totalTokens, null);
    assert.equal(s.decode.throughput, null);
  });
});

test('Anthropic cache input is included once, with cumulative message_delta usage', async () => {
  await withUpstream((_, send) => {
    send({ type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 15, cache_read_input_tokens: 25 } } });
    send({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'thought' } });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 11, input_tokens: 12 } });
    send({ type: 'message_stop' });
  }, async (baseUrl) => {
    const r = await streamRequest(normalizeConfig({ baseUrl, model: 'fixture', format: 'anthropic' }), { system: 'test', user: 'test', maxTokens: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.promptTokens, 52);
    assert.equal(r.cachedTokens, 25);
    assert.equal(r.completionTokens, 11);
    assert.equal(r.marks[0][1], null);
  });
});

test('extra parameters cannot change the workload being measured', () => {
  const config = { baseUrl: 'http://127.0.0.1:12345', model: 'fixture' };
  assert.throws(() => normalizeConfig({ ...config, extraBody: '{"max_tokens":1000}' }), /不能覆盖测速字段/);
  assert.throws(() => normalizeConfig({ ...config, extraBody: '{"n":2}' }), /不能覆盖测速字段/);
  assert.deepEqual(normalizeConfig({ ...config, extraBody: '{"enable_thinking":false}' }).extraBody, { enable_thinking: false });
});

test('the thinking switch sends the selected vLLM template setting for every stage', async () => {
  const requests = [];
  await withUpstream((request, send) => {
    requests.push(request);
    openAIChunk(send, 1);
    openAIFinish(send, { prompt_tokens: 30, completion_tokens: 1 });
  }, async (baseUrl) => {
    const extraBody = { temperature: 0.7, enable_thinking: true, chat_template_kwargs: { enable_thinking: true, other_option: 'keep' } };
    await run(baseUrl, { thinkingMode: 'off', extraBody });
    assert.equal(requests.length, 10);
    assert.ok(requests.some((request) => request.max_tokens === 1));
    assert.ok(requests.some((request) => request.max_tokens === 2048));
    for (const request of requests) {
      assert.equal(request.temperature, 0.7);
      assert.equal(request.enable_thinking, undefined);
      assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false, other_option: 'keep' });
    }
    assert.equal(extraBody.chat_template_kwargs.enable_thinking, true);
  });
});

test('default preserves advanced parameters and official endpoints use their own thinking formats', () => {
  const config = { baseUrl: 'http://127.0.0.1:12345', model: 'fixture' };
  assert.equal(normalizeConfig(config).extraBody, null);
  assert.deepEqual(normalizeConfig({ ...config, thinkingMode: 'default', extraBody: { reasoning_effort: 'low' } }).extraBody, { reasoning_effort: 'low' });
  assert.deepEqual(normalizeConfig({ ...config, thinkingMode: 'on' }).extraBody, { chat_template_kwargs: { enable_thinking: true } });
  assert.deepEqual(normalizeConfig({ ...config, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', thinkingMode: 'off' }).extraBody, { enable_thinking: false });
  assert.deepEqual(normalizeConfig({ ...config, baseUrl: 'https://api.deepseek.com/v1', thinkingMode: 'on' }).extraBody, { thinking: { type: 'enabled' } });
});

test('the browser bundle lists models and completes a benchmark over loopback fetch', async () => {
  const requests = [];
  const browser = {
    AbortController, AbortSignal, TextDecoder, URL, crypto: webcrypto, performance, setTimeout, setInterval, clearInterval,
    fetch: (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/models')) return Promise.resolve(new Response('{"data":[{"id":"fixture"}]}'));
      return fetch(url, options);
    },
  };
  const bundle = buildBrowserBundle().plain.toString('utf8');
  assert.match(bundle, /Copyright \(c\) OpenAI/);
  assert.match(bundle, /MBPP dataset by Google Research/);
  runInNewContext(bundle, browser);
  await withUpstream((request, send) => {
    openAIChunk(send, 1);
    openAIFinish(send, { completion_tokens: 1, prompt_tokens: 30 });
  }, async (baseUrl) => {
    const client = browser.TokenSpeedDirect;
    const cfg = { baseUrl, model: 'fixture', thinkingMode: 'off', contextTokens: 1000, concurrency: 1, runPrefill: false, runSingle: false };
    assert.equal((await client.listModels(cfg)).join(), 'fixture');
    let summary;
    await client.runBenchmark(cfg, (ev) => {
      if (ev.type === 'done') summary = ev.summary;
    }, { id: 'browser', master: new AbortController() });
    assert.equal(summary.decode.ok, 1);
    assert.equal(summary.config.extraBody.chat_template_kwargs.enable_thinking, false);
    assert.equal(requests.length, 7);
    for (const { url, options } of requests) {
      assert.ok(url.startsWith(baseUrl + '/'));
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.targetAddressSpace, 'loopback');
    }
  });
});
