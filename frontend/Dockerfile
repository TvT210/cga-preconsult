# 老人端 / 医护端前端镜像（多阶段）
# 产物只拷 .next/standalone：Next 15 会把运行期必需的 node_modules 子集打包进去，
# 镜像里不需要 pnpm 与源码，也不需要 devDependencies。

FROM node:20-alpine AS base
RUN npm i -g pnpm@10
WORKDIR /app

# ---- 依赖层：只在 lockfile 变化时重装 ----
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- 构建层 ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* 是构建期内联的，运行期改环境变量不会生效，
# 所以必须在 build 时通过 build-arg 注入。
ARG NEXT_PUBLIC_API_BASE=http://127.0.0.1:8000/api/v1
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
# 只有容器构建才产出 standalone 目录（本地 Windows 无符号链接特权）
ENV NEXT_OUTPUT=standalone
# 只有容器构建才产出 standalone 目录（本地 Windows 无符号链接特权）
ENV NEXT_OUTPUT=standalone
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

# ---- 运行层 ----
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
