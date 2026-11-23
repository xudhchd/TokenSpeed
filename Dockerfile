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
