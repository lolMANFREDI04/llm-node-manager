# Stage 1: Build llama-server
FROM alpine:3.19 AS builder
RUN apk add --no-cache build-base cmake git
RUN git clone https://github.com/ggerganov/llama.cpp.git /app/llama.cpp
WORKDIR /app/llama.cpp
# Compila solo la parte server
RUN make -j4 llama-server

# Stage 2: Container Finale Node.js
FROM node:22-alpine
# Installa le dipendenze per l'MCP Bridge
RUN apk add --no-cache curl jq libstdc++ bash

# Copia l'eseguibile compilato
COPY --from=builder /app/llama.cpp/llama-server /usr/local/bin/llama-server

# Setup app Node.js
WORKDIR /app
COPY package*.json ./
RUN npm install --production

# Copia i file dell'applicazione
COPY . .
RUN chmod +x mcp-bridge.sh

EXPOSE 3000

CMD ["node", "server.js"]
