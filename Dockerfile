# Stage 1: Install dependencies and build the project
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./

# Detect architecture and install dependencies only if not amd64 (x86_64)
RUN if [ "$(uname -m)" != "x86_64" ]; then \
    apk add --no-cache python3 make g++ && export PYTHON="/usr/bin/python"; \
    fi

RUN npm install
COPY . .
RUN npm run build

# Stage 2: Install production dependencies
FROM node:20-alpine AS prod-dependencies
WORKDIR /app
COPY package*.json ./

# Detect architecture and install dependencies only if not amd64 (x86_64)
RUN if [ "$(uname -m)" != "x86_64" ]; then \
    apk add --no-cache python3 make g++ && export PYTHON="/usr/bin/python"; \
    fi

RUN npm install --omit=dev

# Stage 3: Create a lightweight production image
FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=prod-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Start the application
CMD ["dist/server.js"]
