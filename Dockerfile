# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S mcpuser && \
    adduser -S mcpuser -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm install --omit=dev && \
    npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Set ownership
RUN chown -R mcpuser:mcpuser /app

# Switch to non-root user
USER mcpuser

# Environment variables (to be overridden at runtime)
ENV WHMCS_API_URL=""
ENV WHMCS_API_IDENTIFIER=""
ENV WHMCS_API_SECRET=""
ENV WHMCS_ACCESS_KEY=""
ENV MCP_HTTP_PORT="3000"
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_AUTH_TOKEN=""
ENV MCP_ALLOWED_HOSTS=""

# HTTP transport listens on this port
EXPOSE 3000

# Health check - hit the HTTP health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Run the MCP server over HTTP
CMD ["node", "dist/http.js"]
