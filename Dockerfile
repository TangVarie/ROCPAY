# 微信云托管构建文件
FROM node:22-slim

WORKDIR /app

# 先装依赖（利用缓存）。连同 lock 一起拷贝，锁定版本、构建可复现。
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

# 拷贝源码（.env 和证书通过云托管「环境变量/文件」注入，不要打进镜像）
COPY . .

# 云托管服务「监听端口」请填 3000（与此一致）
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/app.js"]
