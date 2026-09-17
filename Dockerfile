# Stage 1: Build llama-server con CMake
FROM alpine:3.19 AS builder
RUN apk add --no-cache build-base cmake git linux-headers

RUN git clone https://github.com/ggerganov/llama.cpp.git /app/llama.cpp
WORKDIR /app/llama.cpp

RUN cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=ON \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF

RUN cmake --build build --config Release -j$(nproc) --target llama-server

# Prepara una directory con solo il server e tutte le librerie .so compilate
RUN mkdir -p /app/dist/bin /app/dist/lib && \
    cp /app/llama.cpp/build/bin/llama-server /app/dist/bin/ && \
    cp -d /app/llama.cpp/build/bin/*.so* /app/dist/lib/ 2>/dev/null || true

# Stage 2: Runtime Node.js
FROM node:22-alpine
RUN apk add --no-cache curl jq libstdc++ libgomp bash

# Copia l'eseguibile e le librerie condivise nelle directory di sistema
COPY --from=builder /app/dist/bin/llama-server /usr/local/bin/llama-server
COPY --from=builder /app/dist/lib/ /usr/local/lib/

# Aggiorna la cache del linker per le nuove .so
RUN ldconfig /usr/local/lib || true

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .
RUN chmod +x mcp-bridge.sh

EXPOSE 3000

CMD ["node", "server.js"]
