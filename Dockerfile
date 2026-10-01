FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=5027 NODE_ENV=production
EXPOSE 5027
USER node
CMD ["node", "src/server.js"]
