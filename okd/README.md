# 在 OKD / OpenShift 上部署 TokenSpeed

两份清单：

- `okd/tokenspeed.yaml` —— 从零开始：ImageStream + BuildConfig + Deployment + Service + Route，一条命令全建出来。
- `okd/deployment.yaml` —— **Deployment + Service + Route 三合一**（`namespace: ai`，不设 resources），镜像已经做好、只想更新整套工作负载时用它：

  ```bash
  oc apply -f okd/deployment.yaml
  oc get route tokenspeed -n ai -o jsonpath='https://{.spec.host}{"\n"}'
  ```

  这个文件里的 Route **故意不写 `spec.host`**：留空时路由器会自动分配 `<route>-<namespace>.apps.<集群域名>`，该域名落在路由默认证书 `*.apps.<集群域名>` 的通配范围内，开箱即 HTTPS 可用。要固定域名就把 `host:` 取消注释，并把域名解析到路由器地址；域名不在 `*.apps.<集群域名>` 之下时还需补 `tls.certificate` / `tls.key`。

`okd/tokenspeed.yaml` 一次性创建 5 个资源：

| 资源 | 作用 |
| --- | --- |
| `ImageStream` `tokenspeed` | 存放构建出来的镜像，标签用具体版本号（当前 `:v1.2.1`），不使用 `latest` |
| `BuildConfig` `tokenspeed` | Docker 策略 + 二进制源，直接拿本地仓库目录构建，不用外部镜像仓库 |
| `Deployment` `tokenspeed` | 1 副本，restricted-v2 兼容的安全上下文，带 `/api/info` 就绪与存活探针 |
| `Service` `tokenspeed` | 5173 端口 |
| `Route` `tokenspeed` | edge TLS，HTTP 自动跳 HTTPS，超时放宽到 30 分钟 |

## 部署（集群内构建，推荐）

在**仓库根目录**执行，`--from-dir=.` 需要 Dockerfile 和源码都在当前目录：

```bash
oc login <https://api.your-cluster:6443>

oc new-project tokenspeed          # 已有项目可跳过
oc apply -f okd/tokenspeed.yaml

oc start-build tokenspeed --from-dir=. --follow   # 上传当前目录并构建，约 1 分钟
oc rollout status deploy/tokenspeed               # 等 Pod 起来

oc get route tokenspeed -o jsonpath='https://{.spec.host}{"\n"}'
```

构建完成前 Pod 会处于 `ImagePullBackOff`／`ErrImagePull`，这是正常的 —— 镜像还没推上来，构建结束后执行 `oc rollout restart deploy/tokenspeed` 或等 `imagePullPolicy: Always` 下次重建拉取。

以后改代码重新发布，只要重复这两步：

```bash
oc start-build tokenspeed --from-dir=. --follow
oc rollout restart deploy/tokenspeed
```

### 发新版怎么改标签

清单里的镜像标签是**具体版本号**（BuildConfig 输出 + Deployment 镜像两处，都在 `okd/tokenspeed.yaml` 里，`okd/deployment.yaml` 单文件版还有一处），换版本时：

```bash
VER=v1.2.1          # 带 v 前缀，与 git tag、package.json 一致
# 1) 镜像标签：BuildConfig 输出 + Deployment 镜像（deployment.yaml 单文件版还有一处）
sed -i -E "s|tokenspeed:v?[0-9]+\.[0-9]+\.[0-9]+|tokenspeed:$VER|g" okd/tokenspeed.yaml okd/deployment.yaml
# 2) BuildConfig 传给构建的 VERSION，会写进镜像的 org.opencontainers.image.version
sed -i -E "s|value: \"v?[0-9]+\.[0-9]+\.[0-9]+\"|value: \"$VER\"|" okd/tokenspeed.yaml
oc apply -f okd/tokenspeed.yaml
oc start-build tokenspeed --from-dir=. --follow
```

⚠️ 改完标签**必须**重新构建一次，否则 Deployment 要找的 `tokenspeed:$VER` 在 ImageStream 里不存在，Pod 会卡在 `ImagePullBackOff`。

不改标签也能构建 —— 会覆盖 `v1.2.1` 这个 tag，代价是「同一个版本号对应两个不同的镜像内容」，回滚时说不清回到哪个，所以建议每次都换。

回滚就是把 Deployment 的镜像改回上一个标签：

```bash
oc set image deploy/tokenspeed tokenspeed=image-registry.openshift-image-registry.svc:5000/<项目名>/tokenspeed:v1.0.0
```

## 项目名不是 tokenspeed

清单里的镜像地址写死了内置仓库的集群内地址 `.../tokenspeed/tokenspeed:v1.2.1`（中间那段是 namespace）。换了项目名后修正一行即可：

```bash
oc set image deployment/tokenspeed tokenspeed="$(oc get istag tokenspeed:v1.2.1 -o jsonpath='{.image.dockerImageReference}')"
```

## 已经有镜像，不想在集群里构建（走外部/内部镜像仓库）

```bash
# 外部仓库（集群能拉到即可）
docker tag tokenspeed:v1.2.1 quay.io/<你>/tokenspeed:v1.2.1
docker push quay.io/<你>/tokenspeed:v1.2.1
oc set image deployment/tokenspeed tokenspeed=quay.io/<你>/tokenspeed:v1.2.1

# 或者推到 OKD 内置仓库
oc registry login
REG=$(oc get route default-route -n openshift-image-registry -o jsonpath='{.spec.host}')
docker tag tokenspeed:v1.2.1 "$REG/$(oc project -q)/tokenspeed:v1.2.1"
docker push "$REG/$(oc project -q)/tokenspeed:v1.2.1"
```

`oc apply` 时可以把 `okd/tokenspeed.yaml` 里的 `BuildConfig` 段删掉，只留 ImageStream/Deployment/Service/Route。

## 环境变量

在 Deployment 的 `env` 里改：

| 变量 | 清单里的值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 容器内必须监听所有网卡 |
| `PORT` | `5173` | 改端口要同时改 `containerPort` 和 `Service` 的 `targetPort` |
| `BLOCK_PRIVATE` | `1` | 拒绝把请求转发到内网/本机。公网服务别关；要测集群内模型见上面「测试集群内 / 内网模型」 |
| `SELF_IPS` | 注释掉 | 逗号分隔的公网 IP，通常填云服务器出口 IP，让它们也被视为本机而拒绝 |
| `DEMO_*` | 未设置 | 内置演示服务的模拟参数，见 `lib/mock.js` |

## 测试集群内 / 内网模型

`BLOCK_PRIVATE=1` 会把 `10.x`、`192.168.x`、`*.svc`、`169.254.x` 这些地址一律拒掉，所以想测集群里的 vLLM 就必须关掉它。但**不能只关这个开关就完事** —— 那就等于把一个无鉴权的内网请求代理挂到 Route 上。正确姿势是三件事一起做：

```bash
# 1) 关掉应用层拦截（改 Deployment 的 env，value: "0"）
oc set env deploy/tokenspeed -n ai BLOCK_PRIVATE=0

# 2) 用网络层收口：先改 okd/networkpolicy.yaml 里的模型 Pod 标签/端口，再应用
oc apply -f okd/networkpolicy.yaml

# 3) 限制谁能访问这个 Route（只放行办公网 / VPN 出口网段）
oc annotate route tokenspeed -n ai --overwrite \
  haproxy.router.openshift.io/ip_whitelist="203.0.113.0/24,198.51.100.7/32"
```

`okd/networkpolicy.yaml` 里是四条策略：默认全拒 → 放行 DNS → 放行指定模型服务 → （可选）放行公网 80/443 但 `except` 掉私有网段。改完模型那条就够用，公网那条不需要就删掉。

几点实际情况：

- **同命名空间优先用 `podSelector`**（按 Pod 标签），跨命名空间用 `namespaceSelector` + `podSelector`，集群外的内网模型用 `ipBlock` 写单个 `/32`。不要为了省事放开 `10.0.0.0/8` —— 那样策略就等于没写。
- **OVN-Kubernetes 的 egress 策略对 Service 的匹配行为**在个别版本上有差异，如果用了 `podSelector` 仍不通，先用 `oc get endpoints <svc> -n ai` 拿到 Pod IP，改成 `ipBlock` 试；同时确认模型服务的 Pod 标签没写错。
- **`ip_whitelist` 匹配的是路由器看到的客户端 IP**。前面还有一层负载均衡 / CDN / 公司出口 NAT 时，填的是那一跳的地址，不是员工电脑的地址。
- **更彻底的做法是别暴露到公网**。如果 TokenSpeed 只给内部评估模型用，让管理员把 Route 挂到 internal 的 router shard（或给集群加 internal IngressController），`BLOCK_PRIVATE=0` 的风险面就只剩集群内部了。

### 走 Route 的 HTTPS 报 `unable to verify the first certificate`

这是最常见的坑，和 `insecureEdgeTerminationPolicy` 没关系：

- Route 用 **edge** 终止 TLS，TLS 只发生在「浏览器/客户端 → 路由器」这一段，路由器到后端 vLLM 是**明文 HTTP**。
- 集群默认的 Route 证书是 ingress operator 自己生成的**自签证书**（`*.apps.<集群域名>`，签发者 `router-ca`），不在 Node 的信任库里。于是 Node 的 fetch 拿到叶子证书后找不到可信签发者 → `unable to verify the first certificate`（OpenSSL 的 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，典型就是自签或缺中间证书）。
- 写 `http://` 能通，是因为这时根本不走 TLS：要么直接打 Service，要么 `insecureEdgeTerminationPolicy: Allow` 让路由器收明文再转发。
- `Allow` 的语义是「允许 HTTP 访问、不强制跳 HTTPS」，它**不会**让客户端跳过证书校验。

三个选择，按推荐顺序：

**1. 直接打集群内 Service，跳过路由（最推荐）**

```text
http://vllm.ai.svc.cluster.local:8000/v1
```

没有 TLS、少一跳 HAProxy、不受路由 30s 空闲超时影响，测出来的数字才接近模型真实性能。

**2. 一定要走 Route 的 https：把集群的 CA 装进容器信任库**

```bash
# 取出 ingress operator 的 CA
oc get configmap router-ca -n openshift-ingress-operator -o jsonpath='{.data.ca-bundle\.crt}' > route-ca.crt

oc create configmap route-ca -n ai --from-file=ca-bundle.crt=route-ca.crt
oc set volume  deploy/tokenspeed -n ai --add --name=route-ca --type=configmap \
  --configmap-name=route-ca --mount-path=/etc/route-ca
oc set env     deploy/tokenspeed -n ai NODE_EXTRA_CA_CERTS=/etc/route-ca/ca-bundle.crt
```

`NODE_EXTRA_CA_CERTS` 是**追加**到 Node 默认信任库，不会破坏对公网 CA 的校验。容器是只读根文件系统，configmap 以只读卷挂进去，不受影响。集群若已把默认 ingress 证书换成公网 CA 签发的，就不需要这一步。

**3. 关掉校验（不推荐）**

`oc set env deploy/tokenspeed -n ai NODE_TLS_REJECT_UNAUTHORIZED=0`。一行就能让这个报错消失，适合临时确认「失败原因确实是证书」。它会让这个服务对**所有** https 上游都不校验证书，包括你填了 Key 的公网 API，等于放弃了中间人防护，只适合临时排查——确认完就应改回方案 2。

生效后页面顶部会出现一条黄色提示（来自 `/api/info` 的 `tls.insecure`），说明当前成绩是在不校验证书的链路上测出来的。项目没把它做成界面开关：它是进程级设置，做不到只对单次请求生效；多用户共享时也不该把「关闭全站 TLS 校验」交给匿名访问者。

### 只是偶尔测一下：不用动线上部署

用端口转发把模型服务拉到本地，本机跑 TokenSpeed，请求走本地 Node 进程（本机没有 `BLOCK_PRIVATE` 限制）：

```bash
oc port-forward -n ai svc/vllm 18000:8000
npm start          # 打开 http://127.0.0.1:5173，接口地址填 http://127.0.0.1:18000/v1
```

代价是数字不准：`kubectl port-forward` 是单连接多路复用，吞吐和并发延迟都会被它拖累，只适合验证"通不通、大概多快"。要出可比较的成绩，还是得在集群内跑。

## 几个踩坑点

1. **副本数必须保持 1**。`/api/stop` 通过进程内的 `runs` 表找对应的测速任务，扩到 2 个 Pod 后停止请求可能落到另一个实例上而 404。要横向扩展得先把这个状态外置。
2. **Route 超时要放宽**。长资料读取、长输出解码时事件流可能安静很久，默认 30s 空闲超时会把连接掐断，清单里已加 `haproxy.router.openshift.io/timeout: 1800s`。如果你的路由器全局配置更严，需要集群管理员配合调整。
3. **集群要能出网**。测速是服务端向用户填写的模型接口发请求，集群出站被限制或强制走代理时，测速会连不上上游；同时 `oc start-build` 也要能拉 `node:22-alpine`。离线环境请先在能出网的机器上 `docker build` 再推内部仓库。
4. **安全上下文已验证可用**。镜像文件对任意 UID 可读，已用 `--user 1000670000:0 --read-only --tmpfs /tmp` 实测：随机 UID + 只读根文件系统下页面、`/api/info`、完整测速流程都正常，所以 `restricted-v2` 不需要额外授权（无需 `anyuid`）。
5. **浏览器直连功能**。Route 是 HTTPS，页面里对 `localhost` / `127.0.0.1` 的模型服务会启用浏览器直连模式，需要用户在浏览器的本机网络提示里允许，并在自己的模型服务上放开本 Route 域名的 CORS。
6. 健康检查打的是 `/api/info`，只是进程存活 + 静态数据可读，不会真的发一次上游请求，不会产生费用。
7. **「连接测试未收到文本或推理输出」**：说明接口通了、SSE 也收到了，但 ping 请求里没有任何非空文本/推理增量。ping 默认只要 1 个 token（生成越少，首包时间越纯粹），遇到思考型模型时这一个 token 往往是思考起始标记，被 `skip_special_tokens` 过滤成空字符串，于是拿不到任何可见字符——这种情况下工具会自动放宽到 16 个 token 重试一次，成功后在结果里标注「延迟探针已自动放宽」。放宽后仍拿不到可见文本的，会退化成「首个 SSE 数据块到达时间」并标注口径；连数据块都收不到时只把延迟标为不可用（结果里写明原因），**读取/单发/并发照常继续跑**，不会再因为延迟测不出而中止整轮。真正会中止的是 401/403/404 这类换阶段也不会成功的错误。要核对原始流就先看有没有 `delta.content`：

   ```bash
   curl -sN http://vllm.ai.svc.cluster.local:8000/v1/chat/completions \
     -H 'content-type: application/json' -H 'authorization: Bearer x' \
     -d '{"model":"你的模型","messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"ping，请只回复 pong。"}],"max_tokens":1,"stream":true,"stream_options":{"include_usage":true}}'
   ```

   自动放宽后仍失败的情况：给 vLLM 加 `--reasoning-parser`（如 `qwen3`）让思考内容走 `reasoning_content`，或把首页「思考模式」设为「关闭」（自定义 OpenAI 格式会发 `chat_template_kwargs.enable_thinking=false`）；是空回复就换模型或检查 chat template。
8. **`HTTP 403：Insufficient user quota, remaining quota: ¥0.000000`**：这句是上游网关（one-api / new-api 一类中转）自己返回的，不是测速服务报的，原样透传而已。含义是网关侧账户余额或令牌额度为 0，请求在到达模型之前就被拦下了。带上 `(request id: …)` 的都可以直接到网关后台的「日志」页按 id 搜，能看到命中的令牌、渠道和计费明细。注意测速本身很费额度：16K 资料 × 8 并发一次就是十几万输入 tokens，256K × 64 并发接近 1700 万，跑几次就能把赠送额度烧干，所以常见表现是「前面几个模型能测，后面突然全是 403」。要么给账户充值，要么把该令牌设为无限额度，要么直连模型服务绕开网关。
9. **`HTTP 500：upstream error: do request failed`**：同样是网关文案，表示网关去请求真正的上游时失败了——渠道里的 base url 写错、上游服务不可达或被防火墙拦、TLS 证书不受信（自签证书）、或者上游超时（长资料、高并发时最容易超时）。先在网关后台点该渠道的「测试」按钮，不通就是渠道配置问题；测得出但测速失败，多半是超时，去调大渠道的超时设置。
