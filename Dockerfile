# 🐳 droid2api - Dockerfile
# Version: v1.4.0+
# Node.js version: 24 (Alpine Linux)
# Image size: ~150MB (after optimization)

# ===== Build strategy =====
#
# Single-stage build (current approach):
#   - Advantages: straightforward; suitable for rapid development and testing
#   - Limitations: somewhat larger image (includes npm cache)
#   - Image size: ~200MB
#
# Multi-stage build (production optimization):
#   - Advantages: smaller image (~150MB), faster builds through caching
#   - Limitations: slightly more complex
#   - See the "Image optimization" section in DOCKER_DEPLOY.md

# ===== Stage 1: base image =====
FROM node:24-alpine

# Set maintainer metadata
LABEL maintainer="droid2api"
LABEL version="1.4.0"
LABEL description="OpenAI-compatible API proxy with key pool management"

# Set the working directory
WORKDIR /app

# ===== Stage 2: install dependencies =====
# Copy package.json and package-lock.json
COPY package*.json ./

# Install project dependencies
# npm ci ensures consistent dependency versions (faster and more reliable than npm install)
# --only=production installs production dependencies only, reducing image size
RUN npm ci --only=production && \
    npm cache clean --force

# ===== Stage 3: copy project files =====
# Copy all project files (.dockerignore excludes unnecessary files)
COPY . .

# Create required directories
RUN mkdir -p /app/data /app/logs

# ===== Stage 4: runtime configuration =====
# Expose the port (default: 3000; configurable through PORT)
EXPOSE 3000

# Set default environment variables
ENV NODE_ENV=production
ENV PORT=3000

# ===== Stage 5: health check =====
# Docker health check (optional; also configured in docker-compose)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:${PORT}/ || exit 1

# ===== Stage 6: start the application =====
# Run node directly (faster than npm start, with one fewer process)
CMD ["node", "server.js"]

# ===== 🎯 Usage =====
#
# Build the image:
#   docker build -t droid2api:latest .
#
# Run the container:
#   docker run -d \
#     --name droid2api \
#     -p 3000:3000 \
#     -e FACTORY_API_KEY="your_key" \
#     -e ADMIN_ACCESS_KEY="your_admin_password" \
#     -v $(pwd)/data:/app/data \
#     droid2api:latest
#
# View logs:
#   docker logs -f droid2api
#
# Open a shell in the container:
#   docker exec -it droid2api sh
#
# ===== 📊 Image size optimization =====
#
# Current approach (single-stage): ~200MB
#   - Suitable for rapid development and testing
#
# Multi-stage build: ~150MB (25% smaller)
#   - Suitable for production and CI/CD
#   - See the "Image optimization" section in DOCKER_DEPLOY.md
#
# ===== 🔒 Security recommendations =====
#
# 1. Run as a non-root user (optional):
#    RUN addgroup -g 1001 -S nodejs && \
#        adduser -S nodejs -u 1001 && \
#        chown -R nodejs:nodejs /app
#    USER nodejs
#
# 2. Update the base image regularly:
#    docker pull node:24-alpine
#    docker build -t droid2api:latest .
#
# 3. Scan for vulnerabilities:
#    docker scan droid2api:latest
#
# ===== 📚 Related documentation =====
#
# - DOCKER_DEPLOY.md - Complete Docker deployment guide
# - README.md - Project documentation
# - .dockerignore - Files excluded from the Docker build context
