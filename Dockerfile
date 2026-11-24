# TokenSpeed 运行镜像：项目零第三方依赖，只需要 Node 运行时，因此单阶段即可
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173

WORKDIR /app

# 只拷运行期需要的文件；先拷清单，改动代码时可复用前面的层
COPY package.json LICENSE ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY data ./data

# 用镜像内置的非 root 用户运行
USER node

EXPOSE 5173

# /api/info 同时校验进程存活与静态资源可用
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/info').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM

CMD ["node", "server.js"]

# 版本信息写进镜像元数据，docker inspect 可核对；也用来区分和上游原版的不同版本。
# 放在最后：改版本号只会重建这一层（纯元数据），不会让前面 COPY 源码的层失效。
# 正常不要手填，用 `npm run image`（scripts/build-image.js）从 git tag 自动取值
ARG VERSION=v1.2.1
ARG REVISION=unknown

LABEL org.opencontainers.image.title="TokenSpeed" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.source="https://github.com/xudhchd/TokenSpeed" \
      org.opencontainers.image.licenses="MIT"
