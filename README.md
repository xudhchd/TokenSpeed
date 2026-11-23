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
Dockerfile         运行镜像（Node 22 alpine，非 root，带健康检查）
docker-compose.yml 单服务编排
okd/               OKD / OpenShift 部署清单（ImageStream + BuildConfig + Deployment + Service + Route）
```

后端发起请求并记录上游事件到达时间，浏览器负责展示。

## 测试

运行 `npm test`，使用本地模拟流验证计时、吞吐计算和用量缺失等边界情况，无需 API Key。

## Docker 部署

项目零第三方依赖，镜像里不需要 `npm install`，构建只做文件拷贝（Node 22 alpine 基础镜像约 240 MB）。

```bash
docker build -t tokenspeed:1.1.0 -t tokenspeed:latest .
docker run -d --name tokenspeed -p 127.0.0.1:5173:5173 tokenspeed:1.1.0
```

或用 compose 一把起：

```bash
docker compose up -d --build
```

然后打开 http://127.0.0.1:5173 。容器内默认 `HOST=0.0.0.0`、`PORT=5173`，以非 root 的 `node` 用户运行，健康检查每 30 秒请求一次 `/api/info`。

| 环境变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 5173 |
| `HOST` | 监听地址，镜像内已设为 `0.0.0.0`，一般不用改 |
| `BLOCK_PRIVATE=1` | 拒绝把测速请求转发到内网或本机地址（含解析到内网的域名）。公网部署务必打开 |
| `SELF_IPS` | 逗号分隔的 IP，通常填云服务器的公网 IP（它不在网卡上，需要补进来才会被同样拒绝） |
| `NODE_EXTRA_CA_CERTS` | 指向一个 CA 证书文件，**追加**进 Node 信任库。访问自签名证书的内网 https 服务时用它 |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | **仅临时排查**：关闭所有 https 上游的证书校验。说明见[证书校验](#证书校验自签名证书报错) |
| `DEMO_PREFILL_TPS` / `DEMO_DECODE_TPS` / `DEMO_CHUNK` / `DEMO_MTP` / `DEMO_NO_CONT` | 内置演示服务的模拟参数，用法见 `lib/mock.js` |

镜像默认把端口发布到 `127.0.0.1`，适合前面挂一层 nginx 之类的反向代理做访问控制和限流；如果确实要直接对外，把 compose 里的 `ports` 改成 `"5173:5173"`，并同时打开 `BLOCK_PRIVATE=1`、配置 `SELF_IPS` 与出站网络策略，避免这个服务被当成访问内网的跳板。服务端无状态，配置和 Key 都存在浏览器里，因此不需要挂载卷做持久化。

在 OKD / OpenShift 上用 `okd/tokenspeed.yaml`（ImageStream + BuildConfig + Deployment + Service + Route，已按 restricted-v2 安全上下文写好），步骤见 [okd/README.md](okd/README.md)。

## 版本与发版

本仓库是 [1CatAI/TokenSpeed](https://github.com/1CatAI/TokenSpeed) 的分叉。`1.0.0` 与上游完全一致，**从 `1.1.0` 起独立演进**：版本号只描述本仓库的发布内容，不保证与上游的编号一一对应，判断是否跟上了上游要看提交历史和 tag，而不是比数字大小。

镜像标签约定两套，用途不同：

| 标签形式 | 用途 |
| --- | --- |
| `tokenspeed:1.1.0` | 固定版本，**部署清单里一律用它**。回滚、排查时能确认跑的是哪一版 |
| `tokenspeed:latest` | 移动别名，只指向最近一次本地构建，图省事在命令行随手 `docker run` 用 |

镜像的 `org.opencontainers.image.version` / `.revision` 标签由 Dockerfile 的 `ARG VERSION` / `ARG REVISION` 写入，`docker inspect` 可查：

```bash
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' tokenspeed:1.1.0
```

发版要同步改四处，缺一处就会出现「tag 是 1.2.0、镜像还是 1.1.0」这类不一致：

1. `package.json` 的 `version`
2. `Dockerfile` 里 `ARG VERSION=...` 的默认值
3. `docker-compose.yml` 里 `${TOKENSPEED_VERSION:-...}` 的默认值
4. `okd/tokenspeed.yaml` 的 BuildConfig 输出标签与 Deployment 镜像地址、`okd/deployment.yaml` 的镜像地址

然后打 tag 并推送：

```bash
git tag -a v1.2.0 -m "v1.2.0"
git push origin v1.2.0
```

`git describe --tags` 可以看当前提交相对哪个版本；镜像构建时想带上提交号，用 `--build-arg REVISION=$(git rev-parse --short HEAD)`（compose 对应 `TOKENSPEED_REVISION=$(git rev-parse --short HEAD) docker compose build`）。

## 证书校验（自签名证书报错）

当接口地址写成 `https://`，而对方用的是自签名证书（内网网关、OpenShift / OKD 的 Route 默认证书等），测速会在建连阶段就失败，页面上看到的报错是：

- `连接测试失败 · 网络错误：self-signed certificate`
- `unable to verify the first certificate`
- `self signed certificate in certificate chain`
- `连接测试失败 · 网络错误：fetch failed`（底层错误码 `DEPTH_ZERO_SELF_SIGNED_CERT`、`SELF_SIGNED_CERT_IN_CHAIN`、`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）

原因跟测速逻辑无关：Node 的信任库（内置根证书 + 系统 CA）里没有签发这张证书的 CA。同一个地址在浏览器里能打开，是因为浏览器让你手动确认「继续访问」，而 Node 默认直接拒绝，没有交互余地。改成 `http://` 就正常，是因为这一步根本不做 TLS。

### 推荐：把对方的 CA 追加进信任库

```bash
NODE_EXTRA_CA_CERTS=/path/to/ca.crt npm start
```

`NODE_EXTRA_CA_CERTS` 的语义是**追加**，公网 CA 仍然照常校验，所以填了 Key 的 DeepSeek、OpenAI 这类请求不会受影响。Docker 里用 `-v /path/ca.crt:/etc/ca.crt:ro -e NODE_EXTRA_CA_CERTS=/etc/ca.crt`；OKD 上取集群路由证书的命令见 [okd/README.md](okd/README.md)。

### 临时：关掉证书校验

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 npm start
```

这是 Node 自己的环境变量（不是本项目实现的），一行就能让上面所有报错消失，用它来快速确认「失败原因确实是证书」很方便。部分报错（比如内网服务返回的内容被当成错误消息）也能靠它区分开。

代价要说清楚：**进程内所有 https 请求都不再校验证书**，包括你填了 Key 的公网 API。链路上任何一跳都能冒充目标服务，Key 和对话内容都可能被截走。所以它只适合内部排查，确认原因后应改回 `NODE_EXTRA_CA_CERTS`。

打开这个开关时，页面顶部会显示一条黄色提示，说明当前成绩是在不校验证书的链路上测出来的。项目**没有**把它做成界面上的开关，原因有三个：

1. 它是进程级设置，无法只对某一次请求生效。要按请求生效，得给这个零依赖项目引入 `undici`（Node 内置的 `fetch` 不导出 `Agent`），或者把整个请求层改成 `node:https` 重写；
2. 运行时临时改 `process.env` 会有竞态：Node 是在建立连接那一刻读取它的，32 路并发下必然出现一部分连接校验、一部分不校验；
3. 公网部署时页面没有鉴权，做了按钮等于把「关闭全站 TLS 校验」的决定权交给任何访问者。

### 最省事的办法

如果模型服务和 TokenSpeed 跑在同一台机器或同一个集群里，直接用内网 http 地址（例如 `http://vllm.ai.svc.cluster.local:8000/v1`），完全不涉及证书，还少一跳转发、不受路由空闲超时影响。

## 部署到公网

默认仅监听 `127.0.0.1`。直接用 Node 跑时，需要在隔离的容器内监听所有网卡，可用 `HOST=0.0.0.0 PORT=8080 npm start`。由于服务会向用户指定的地址发起请求，对公网提供服务时需在反向代理配置访问控制和限流，并通过出站网络策略隔离宿主机和内网服务。

## 许可证

TokenSpeed 源码采用 [MIT 许可证](LICENSE)。随附语料沿用各自的许可。

- `data/HumanEval.jsonl` 来自 OpenAI 的 HumanEval，仅解压上游文件，内容一致。 [上游项目](https://github.com/openai/human-eval) · [原始 MIT 许可证](data/LICENSE-HumanEval)
- `data/mbpp.jsonl` 原样收录 Google Research 的 Mostly Basic Python Problems 数据集，随 Austin 等人的论文发布。数据集卡标注 CC BY 4.0，同时保留原始代码仓库的 Apache 2.0 许可文本。 [原始文件](https://github.com/google-research/google-research/blob/master/mbpp/mbpp.jsonl) · [数据集卡](https://huggingface.co/datasets/google-research-datasets/mbpp) · [论文](https://arxiv.org/abs/2108.07732) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) · [上游仓库许可](data/LICENSE-MBPP-upstream)
