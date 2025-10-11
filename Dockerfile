# Stage 1: Install dependencies and build the project
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./

# Detect architecture and install build tooling only when required
RUN if [ "$(uname -m)" != "x86_64" ]; then \
    apk add --no-cache python3 make g++ && export PYTHON="/usr/bin/python"; \
    fi

RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Create a lightweight production image
FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Start the application
CMD ["dist/server.js"]
