# Business server image: Node 22 on Alpine, tsx runs the TypeScript source directly (no build step,
# no runtime dependencies). Only package.json is copied before install so the layer caches.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
EXPOSE 8081
CMD ["npx", "tsx", "src/index.ts"]
