# TokenSpeed · 大模型 API 测速

一键测出大模型 API 的 **响应延迟**、**读取速度（Prefill）**、**单发峰值速度** 和 **并发生成速度**。零依赖，Node.js 18+ 即可运行。

```bash
git clone https://github.com/1CatAI/TokenSpeed.git
cd TokenSpeed
npm start          # 打开 http://127.0.0.1:5173
```

没有 API Key 也可以点「没有 Key？先看演示」，使用内置的模拟服务体验完整流程。

## 测什么

| 项目 | 做法 | 指标 |
| --- | --- | --- |
| 响应延迟 | 串行发 4 个短请求，首个用于预热 | 请求发出至收到首个文本或推理输出块。统计后 3 次的最快、平均和相邻样本的平均绝对差。探针默认只要 1 个 token（思考型模型的首个 token 常被过滤成空，此时自动放宽到 16 个重试）；仍拿不到可见文本则退化为「首个 SSE 数据块到达时间」并标注口径，连数据块都没有时只把延迟标为不可用，继续跑后面的吞吐测试 |
| 读取速度 | 默认 8 路，每路输入目标约 16K tokens，带独立随机前缀，输出上限 1 token | 有效输入吞吐 = 上游报告的输入 token 总量 ÷ 首个请求至最后一路首包的时间，另列实际输入长度范围和已命中缓存量 |
| 单发峰值 | 1 路短提示词写代码，默认最多 2048 tokens | 最快完整 2 秒窗口的逐块 token 增量 ÷ 2，解码平均使用首末输出块的累计 token 差 ÷ 时间差。另列端到端输出吞吐及输出块间隔 P50/P99 |
| 并发生成 | 默认 8 路，各写一个领域，复用读取阶段的前缀以测试缓存，默认每路最多 2048 tokens | 主成绩是所有路共同解码期间的输出 token 增量 ÷ 窗口时长。详情提供整轮端到端输出吞吐、单路解码速度和缓存命中率 |

并发解码的共同窗口从最晚收到的首个输出块开始，到最早结束输出的一路的最后一个输出块为止。用各路在窗口起止点的累计 token 差计算吞吐，复用同一轮请求。整轮端到端输出吞吐按首个请求发出至最后一个响应流结束的用时计算。

时间由测速后端以单调时钟测量，包含测速机与上游之间的网络、排队及可能的代理缓冲。读取测试报告含缓存的 API 有效输入吞吐。GPU 内部 Prefill/Decode 性能需要结合上游的服务端计时或 profiler。资料长度是构造目标，实际长度取决于模型分词器和领域。

最终吞吐使用上游报告的用量。仅有最终用量时，仍可计算端到端输出吞吐。解码平均、共同窗口吞吐和峰值需要有效的逐块累计用量，峰值另需至少 2 秒的观测跨度。缺少共同窗口、整轮失败或提前中止、用量数据不完整时，对应成绩显示为不可用。未报告的缓存命中率也显示为不可用。实时曲线可能使用文本估算。

测试使用 HumanEval（164 题）、MBPP（974 题）和 `lib/dataset.js` 按模板生成的订单、新闻、数学题及客服对话。语料来源和许可见下文。

## 支持的服务

内置 DeepSeek、Kimi、通义千问、智谱、硅基流动、火山方舟、OpenAI、Claude、OpenRouter 预设；其余任意 OpenAI 兼容接口（vLLM / SGLang / Ollama 等）选「自定义」填地址即可。高级设置里可以调资料长度、并发数、并发输出上限、要跑的测试项目、`ignore_eos` 和额外请求参数。

首页可为自定义 OpenAI 格式、通义千问和 DeepSeek 选择思考模式。「跟随接口」保留原有请求参数。「开启」和「关闭」对本轮全部测试发送对应控制参数，自定义接口使用 `chat_template_kwargs.enable_thinking`。上游模型需要支持该开关。

从 HTTPS 站点打开 TokenSpeed 时，填写 `localhost`、`127.0.0.1` 或 `[::1]` 可由浏览器直连访客自己的模型服务。点击「获取列表」或「开始测速」时，请在提示中允许本机网络访问，并在模型服务的 CORS 设置中允许 TokenSpeed 的 HTTPS 来源。该模式不经过公网 TokenSpeed 的请求转发。浏览器可能对 HTTP/1.1 本机接口的连接排队，导致高并发下没有全部路都在解码的共同窗口。

## 结构

```
server.js          静态页面 + /api/run（NDJSON 事件流）+ /api/models + /demo/v1 演示服务
lib/bench.js       测速流程与统计
lib/client.js      OpenAI / Anthropic 流式请求封装
lib/dataset.js     代码语料与 prompt 构造
lib/mock.js        内置演示服务
public/            前端（原生 HTML/CSS/JS）
```

后端发起请求并记录上游事件到达时间，浏览器负责展示。

## 测试

运行 `npm test`，使用本地模拟流验证计时、吞吐计算和用量缺失等边界情况，无需 API Key。

## 部署到公网

默认仅监听 `127.0.0.1`。需要在隔离的容器内监听所有网卡时，可用 `HOST=0.0.0.0 PORT=8080 npm start`。由于服务会向用户指定的地址发起请求，对公网提供服务时需在反向代理配置访问控制和限流，并通过出站网络策略隔离宿主机和内网服务。

## 许可证

TokenSpeed 源码采用 [MIT 许可证](LICENSE)。随附语料沿用各自的许可。

- `data/HumanEval.jsonl` 来自 OpenAI 的 HumanEval，仅解压上游文件，内容一致。 [上游项目](https://github.com/openai/human-eval) · [原始 MIT 许可证](data/LICENSE-HumanEval)
- `data/mbpp.jsonl` 原样收录 Google Research 的 Mostly Basic Python Problems 数据集，随 Austin 等人的论文发布。数据集卡标注 CC BY 4.0，同时保留原始代码仓库的 Apache 2.0 许可文本。 [原始文件](https://github.com/google-research/google-research/blob/master/mbpp/mbpp.jsonl) · [数据集卡](https://huggingface.co/datasets/google-research-datasets/mbpp) · [论文](https://arxiv.org/abs/2108.07732) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) · [上游仓库许可](data/LICENSE-MBPP-upstream)
