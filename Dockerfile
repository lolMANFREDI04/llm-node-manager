# Stage 1: Build llama-server con CMake
FROM alpine:3.19 AS builder
RUN apk add --no-cache build-base cmake git linux-headers

RUN git clone https://github.com/ggerganov/llama.cpp.git /app/llama.cpp
WORKDIR /app/llama.cpp

# Configura CMake per compilare solo llama-server
RUN cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=ON \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF

RUN cmake --build build --config Release -j$(nproc) --target llama-server

# Installa in una cartella di staging prefissata (copia binari e tutte le .so necessarie)
RUN cmake --install build --prefix /app/install

# Stage 2: Container Finale Node.js
FROM node:22-alpine
RUN apk add --no-cache curl jq libstdc++ bash

# Copia tutti gli eseguibili e le librerie condivise collegate
COPY --from=builder /app/install/ /usr/local/

# Registra le librerie condivise nel runtime Alpine
RUN ldconfig /usr/local/lib || true

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .
RUN chmod +x mcp-bridge.sh

EXPOSE 3000

CMD ["node", "server.js"]
