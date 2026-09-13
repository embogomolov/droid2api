# 🐳 Docker deployment guide

> **droid2api v1.4.0+** - A production-oriented OpenAI-compatible API proxy
>
> Updated: 2025-10-13 | Deployment options: single container → Redis cache → cluster mode → Kubernetes

---

## 📋 Contents

- [Quick start](#-quick-start)
- [Environment variables](#️-environment-variables)
- [Local Docker deployment](#-local-docker-deployment)
- [Persistent storage](#-persistent-storage)
- [Performance optimization](#-performance-optimization)
- [Cloud deployment](#️-cloud-deployment)
- [Using the admin interface](#-using-the-admin-interface)
- [Health checks and monitoring](#-health-checks-and-monitoring)
- [Troubleshooting](#-troubleshooting)
- [Security recommendations](#-security-recommendations)

---

## 🚀 Quick start

**The simplest deployment in three steps** 😎

```bash
# 1. Copy the environment variable template
cp .env.example .env

# 2. Edit .env and configure your keys (required)
# Configure at least these two settings:
#   - ADMIN_ACCESS_KEY=your-admin-password  # Admin password
#   - FACTORY_API_KEY=fk-xxx  or  DROID_REFRESH_KEY=rt-xxx  # API authentication

# 3. Start the service!
docker-compose up -d

# 🎉 Done! Open http://localhost:3000 to manage the key pool
```

**Check service status:**
```bash
# View logs
docker-compose logs -f

# Test the API
curl http://localhost:3000/v1/models

# Check the admin API (requires ADMIN_ACCESS_KEY)
curl -H "x-admin-key: your-admin-key" http://localhost:3000/admin/stats
```

---

## ⚙️ Environment variables

### 🔐 Authentication (five-level authentication system)

droid2api supports **five authentication sources**, in priority order from highest to lowest:

#### 1️⃣ FACTORY_API_KEY (highest priority, recommended for production)

```env
FACTORY_API_KEY=fk-your-factory-api-key
```

**Use cases:** single key / personal use / quick deployment
**Advantages:** simple configuration, convenient for Docker
**Limitations:** no key rotation or load balancing

---

#### 2️⃣ Key pool management (multiple keys, recommended for enterprise use ⭐)

**No environment variable required!** Add keys through the admin interface:

1. Start the server and open `http://localhost:3000/`
2. Sign in with `ADMIN_ACCESS_KEY`
3. Use "Add Key" or bulk import to add your FACTORY_API_KEY values

**Advantages:**
- ✅ No fixed key count limit
- ✅ Six key selection algorithms
- ✅ Automatic blocking of unusable keys within the proxy
- ✅ Load balancing
- ✅ 🆕 Multi-tier key pools (v1.4.0+)

**Key selection algorithms:**
- `round-robin` - Assign requests to keys in sequence
- `random` - Select a key at random
- `least-used` - Select the key with the fewest uses
- `weighted-score` - Weighted score based on success rate
- `least-token-used` - Select the key with the lowest token usage (recommended ⭐)
- `max-remaining` - Select the key with the most tokens remaining (recommended ⭐)

**🆕 Multi-tier key pools (v1.4.0+):**

Create multiple pools with automatic priority-based fallback:

```json
{
  "poolGroups": [
    { "id": "freebies", "name": "Free pool", "priority": 1 },
    { "id": "main", "name": "Primary pool", "priority": 2 }
  ],
  "config": {
    "multiTier": {
      "enabled": true,
      "autoFallback": true,
      "strictMode": false
    }
  }
}
```

**How it works:**
- Sort pools by priority (1 takes precedence over 2, then 3)
- Select a key from the highest-priority pool
- If no key is available in that pool, fall back to the next pool
- Create/delete pools and change key assignments through the admin interface

**Documentation:** `docs/MULTI_TIER_POOL.md`

---

#### 3️⃣ DROID_REFRESH_KEY (automatic OAuth refresh)

```env
DROID_REFRESH_KEY=rt-your-refresh-token-here
```

**Use cases:** automatic token refresh / compatibility with the original droid2api
**Advantages:** refreshes every 6 hours; falls back to the old token if refresh fails
**Limitations:** depends on the WorkOS API and requires a valid refresh_token

---

#### 4️⃣ File-based authentication (data/auth.json)

Create `data/auth.json`:
```json
{
  "refresh_token": "rt-your-refresh-token",
  "api_key": "fk-cached-access-token",
  "expires_at": 1234567890000
}
```

**Use cases:** backward compatibility / sharing authentication across projects

---

#### 5️⃣ Client Authorization header (pass-through mode)

**No server configuration required!** Clients send `Authorization: Bearer fk-xxx` with their requests.

---

### 🔑 Admin access (strongly recommended)

```env
ADMIN_ACCESS_KEY=your-secure-admin-password-change-me-123
```

**Purpose:** protects the `/admin/*` endpoints and the web admin interface

**Security notes:**
- ⚠️ Change the default value!
- ✅ Use a strong password (at least 16 characters, including letters, digits, and symbols)
- ✅ Avoid weak passwords such as `123` or `admin` in production

---

### 🛡️ Client access control (optional)

```env
API_ACCESS_KEY=your-api-access-key-for-clients
```

**Purpose:** clients must supply this key to access the `/v1/*` API
**Usage:** request header `Authorization: Bearer your-api-access-key-for-clients`

---

### 🚀 Server settings (optional)

```env
PORT=3000                  # Server port (default: 3000)
NODE_ENV=production        # Runtime environment (development/production)
```

**NODE_ENV values:**
- `production` (recommended) - Concise console logs and file logs in `logs/`, rotated daily
- `development` - Detailed console logs without file output

---

### 🎯 Key pool settings (optional)

```env
# Key selection algorithm (default: round-robin)
KEY_POOL_ALGORITHM=round-robin

# Retry settings
KEY_POOL_RETRY_ENABLED=true
KEY_POOL_RETRY_MAX=3
KEY_POOL_RETRY_DELAY_MS=1000

# Automatic key blocking within the proxy
KEY_POOL_AUTO_BAN_ENABLED=true
KEY_POOL_ERROR_THRESHOLD=5
KEY_POOL_BAN_402=true
KEY_POOL_BAN_401=false

# Performance settings
KEY_POOL_CONCURRENT_LIMIT=100
KEY_POOL_REQUEST_TIMEOUT_MS=10000
```

---

### 🔥 Redis caching (optional, for performance)

```env
REDIS_HOST=127.0.0.1       # Redis server address
REDIS_PORT=6379            # Redis port
REDIS_PASSWORD=            # Redis password, if configured
REDIS_DB=0                 # Redis database number (0-15)
```

**Redis can improve performance by 30-50%!** Suitable for high concurrency (more than 500,000 requests/day on average).

---

### ⚡ Cluster mode (optional, for maximum performance)

```env
CLUSTER_MODE=true          # Enable cluster mode
CLUSTER_WORKERS=4          # Worker count (defaults to CPU core count)
```

**Cluster mode can deliver N times the performance!** N is the CPU core count. Suitable for very high concurrency (more than 1,000,000 requests/day on average).

---

## 🐳 Local Docker deployment

### Method 1: Docker Compose (recommended ⭐)

**The simplest method:** start the service with one command:

```bash
# 1. Create .env using .env.example
cp .env.example .env

# 2. Edit .env and configure your keys
# Configure at least:
#   - ADMIN_ACCESS_KEY
#   - FACTORY_API_KEY or DROID_REFRESH_KEY

# 3. Start the service
docker-compose up -d

# 4. View logs
docker-compose logs -f

# 5. Stop the service
docker-compose down
```

**docker-compose.yml configuration:**
```yaml
version: '3.8'

services:
  droid2api:
    build: .
    container_name: droid2api
    ports:
      - "3000:3000"
    environment:
      # Authentication (choose one method in priority order)
      - FACTORY_API_KEY=${FACTORY_API_KEY}
      - DROID_REFRESH_KEY=${DROID_REFRESH_KEY}
      - ADMIN_ACCESS_KEY=${ADMIN_ACCESS_KEY}
      - API_ACCESS_KEY=${API_ACCESS_KEY}
      # Server settings
      - PORT=${PORT:-3000}
      - NODE_ENV=${NODE_ENV:-production}
    volumes:
      # Optional: persistent data
      - ./data:/app/data
      - ./logs:/app/logs
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3000/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

---

### Method 2: Docker commands

**Build and run the container manually:**

```bash
# 1. Build the image
docker build -t droid2api:latest .

# 2. Run the container with FACTORY_API_KEY
docker run -d \
  --name droid2api \
  -p 3000:3000 \
  -e FACTORY_API_KEY="your_factory_api_key_here" \
  -e ADMIN_ACCESS_KEY="your-admin-password" \
  -e NODE_ENV="production" \
  droid2api:latest

# Or use DROID_REFRESH_KEY
docker run -d \
  --name droid2api \
  -p 3000:3000 \
  -e DROID_REFRESH_KEY="your_refresh_token_here" \
  -e ADMIN_ACCESS_KEY="your-admin-password" \
  -e NODE_ENV="production" \
  droid2api:latest

# 3. View logs
docker logs -f droid2api

# 4. Stop the container
docker stop droid2api
docker rm droid2api
```

---

## 💾 Persistent storage

### Why use persistent storage?

**Container replacement can lose data without persistent storage!** This includes:
- `data/key_pool.json` - Key pool data (all keys you have added)
- `data/token_usage.json` - Token usage statistics
- `logs/` - Log files

**Mounting data volumes is strongly recommended for production!** 🔥

---

### Method 1: Docker Compose volumes

**Edit `docker-compose.yml`:**

```yaml
version: '3.8'

services:
  droid2api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - FACTORY_API_KEY=${FACTORY_API_KEY}
      - ADMIN_ACCESS_KEY=${ADMIN_ACCESS_KEY}
    volumes:
      # Persistent data directory (recommended)
      - data-volume:/app/data
      # Persistent log directory (optional)
      - logs-volume:/app/logs
    restart: unless-stopped

volumes:
  data-volume:
  logs-volume:
```

**Start the service:**
```bash
docker-compose up -d
```

**Inspect volumes:**
```bash
docker volume ls
docker volume inspect droid2api_data-volume
```

---

### Method 2: Docker volumes

```bash
# 1. Create volumes
docker volume create droid2api-data
docker volume create droid2api-logs

# 2. Run the container with the volumes mounted
docker run -d \
  --name droid2api \
  -p 3000:3000 \
  -e FACTORY_API_KEY="your_factory_api_key_here" \
  -e ADMIN_ACCESS_KEY="your-admin-password" \
  -v droid2api-data:/app/data \
  -v droid2api-logs:/app/logs \
  droid2api:latest

# 3. Inspect volume contents
docker exec droid2api ls /app/data
docker exec droid2api cat /app/data/key_pool.json
```

---

### Method 3: bind mounts (development)

**Mount host directories directly:**

```bash
docker run -d \
  --name droid2api \
  -p 3000:3000 \
  -e FACTORY_API_KEY="your_factory_api_key_here" \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  droid2api:latest
```

**Advantages:** view and edit files directly on the host
**Limitations:** platform-specific paths (Windows uses a different path format)

---

## 🚀 Performance optimization

droid2api supports gradual scaling from a single server to a cluster. Choose an approach based on your workload.

### 📊 Performance overview

| Deployment | Throughput (RPS) | Latency | Cost | Complexity | Average daily requests |
|----------|-------------|------|------|--------|---------------|
| **Stage 1: single container (default)** | 2000+ | 50ms | $ | ⭐ | < 500,000 |
| **Stage 2: single container + Redis** | 3000+ | 30ms | $$ | ⭐⭐ | 500,000-1,000,000 |
| **Stage 3: cluster + Redis** | 10000+ | 30ms | $$$ | ⭐⭐⭐ | 1,000,000-2,000,000 |
| **Stage 4: Nginx + multiple servers** | 20000+ | 30ms | $$$$ | ⭐⭐⭐⭐ | > 2,000,000 |

---

### ⚡ Stage 1: basic optimizations (enabled by default, no configuration)

**Built-in optimizations:**
- ✅ HTTP Keep-Alive connection pooling - Reuses TCP connections, reducing handshake overhead by 70%
- ✅ Asynchronous batch file writes - Avoids blocking the main thread and eliminates disk I/O wait there

**Performance improvements:**
- Lower latency: 250ms → 50ms (⬇️ 80%)
- Higher throughput: 500 → 2000+ RPS (⬆️ 300%)
- Lower CPU utilization: 60-80% → 40-60%

**Deployment:**
```bash
docker-compose up -d  # No additional configuration required!
```

**Use cases:** personal use / small projects (< 500,000 requests/day)

---

### 🔥 Stage 2: Redis caching (high concurrency)

**Use case:** more than 500,000 requests/day on average

**docker-compose.yml configuration:**
```yaml
version: '3.8'

services:
  droid2api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - FACTORY_API_KEY=${FACTORY_API_KEY}
      - ADMIN_ACCESS_KEY=${ADMIN_ACCESS_KEY}
      # Enable Redis caching
      - REDIS_HOST=redis
      - REDIS_PORT=6379
    depends_on:
      - redis
    volumes:
      - data-volume:/app/data
      - logs-volume:/app/logs

  redis:
    image: redis:alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes

volumes:
  data-volume:
  logs-volume:
  redis-data:
```

**Start the service:**
```bash
# 1. Install the Redis package before building the image
npm install redis

# 2. Start the service (connects to Redis automatically)
docker-compose up -d

# 3. Verify the Redis configuration
docker exec droid2api sh -c 'echo "Redis enabled: $(env | grep REDIS)"'
```

**Benefits:**
- 90% lower key pool access latency (5-10ms → 0.5-1ms)
- Throughput increases to 3000+ RPS (⬆️ 50%)
- Shared state for cluster mode

**Graceful fallback:** if Redis is unavailable, the system switches to file storage and continues running ✅

---

### 🚄 Stage 3: cluster mode (very high concurrency)

**Use case:** more than 1,000,000 requests/day on average

#### Option 1: Docker Swarm cluster

**docker-stack.yml：**
```yaml
version: '3.8'

services:
  droid2api:
    image: droid2api:latest
    ports:
      - "3000:3000"
    environment:
      - FACTORY_API_KEY=${FACTORY_API_KEY}
      - ADMIN_ACCESS_KEY=${ADMIN_ACCESS_KEY}
      - REDIS_HOST=redis
      - CLUSTER_MODE=true  # Enable cluster mode
      - CLUSTER_WORKERS=4
    deploy:
      replicas: 4  # Four container instances
      resources:
        limits:
          cpus: '1'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M
    depends_on:
      - redis

  redis:
    image: redis:alpine
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes

volumes:
  redis-data:
```

**Deployment:**
```bash
# 1. Initialize Swarm
docker swarm init

# 2. Deploy the cluster
docker stack deploy -c docker-stack.yml droid2api

# 3. Check status
docker service ls
docker service ps droid2api_droid2api

# 4. Scale up to 8 instances
docker service scale droid2api_droid2api=8

# 5. View logs
docker service logs -f droid2api_droid2api
```

**Benefits:**
- Throughput increases to 10000+ RPS
- Automatic load balancing
- Automatic recovery from failures

---

#### Option 2: Kubernetes deployment (recommended for enterprise use ⭐)

**droid2api-deployment.yaml：**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: droid2api
spec:
  replicas: 4
  selector:
    matchLabels:
      app: droid2api
  template:
    metadata:
      labels:
        app: droid2api
    spec:
      containers:
      - name: droid2api
        image: droid2api:latest
        ports:
        - containerPort: 3000
        env:
        - name: FACTORY_API_KEY
          valueFrom:
            secretKeyRef:
              name: droid2api-secrets
              key: factory-api-key
        - name: ADMIN_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: droid2api-secrets
              key: admin-access-key
        - name: REDIS_HOST
          value: "redis-service"
        - name: CLUSTER_MODE
          value: "true"
        - name: CLUSTER_WORKERS
          value: "4"
        resources:
          limits:
            cpu: "1"
            memory: "512Mi"
          requests:
            cpu: "0.5"
            memory: "256Mi"
        livenessProbe:
          httpGet:
            path: /v1/models
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /v1/models
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: droid2api-service
spec:
  type: LoadBalancer
  selector:
    app: droid2api
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
```

**redis-deployment.yaml：**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:alpine
        ports:
        - containerPort: 6379
        volumeMounts:
        - name: redis-storage
          mountPath: /data
        command: ["redis-server", "--appendonly", "yes"]
      volumes:
      - name: redis-storage
        persistentVolumeClaim:
          claimName: redis-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: redis-service
spec:
  selector:
    app: redis
  ports:
  - protocol: TCP
    port: 6379
    targetPort: 6379
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: redis-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

**Deployment:**
```bash
# 1. Create a Secret
kubectl create secret generic droid2api-secrets \
  --from-literal=factory-api-key='your_factory_api_key' \
  --from-literal=admin-access-key='your-admin-password'

# 2. Deploy Redis
kubectl apply -f redis-deployment.yaml

# 3. Deploy droid2api
kubectl apply -f droid2api-deployment.yaml

# 4. Check status
kubectl get pods
kubectl get svc droid2api-service

# 5. View logs
kubectl logs -f deployment/droid2api

# 6. Scale up to 8 instances
kubectl scale deployment/droid2api --replicas=8

# 7. Get the external IP address
kubectl get svc droid2api-service
```

**Benefits:**
- Throughput increases to 10000+ RPS
- Automatic load balancing (Kubernetes Service)
- Rolling updates (zero-downtime deployment)
- Autoscaling (HPA)

---

### 🌐 Stage 4: Nginx load balancing with multiple servers

**Use case:** more than 2,000,000 requests/day on average

**nginx.conf：**
```nginx
upstream droid2api_cluster {
  least_conn;  # Least-connections algorithm

  # Multiple droid2api instances
  server droid2api-1:3000;
  server droid2api-2:3000;
  server droid2api-3:3000;
  server droid2api-4:3000;
}

server {
  listen 80;
  server_name api.example.com;

  location / {
    proxy_pass http://droid2api_cluster;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Timeouts
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;

    # Buffer settings
    proxy_buffering on;
    proxy_buffer_size 4k;
    proxy_buffers 8 4k;
  }

  # Health check endpoint
  location /health {
    access_log off;
    return 200 "OK\n";
    add_header Content-Type text/plain;
  }
}
```

**docker-compose-nginx.yml：**
```yaml
version: '3.8'

services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - droid2api-1
      - droid2api-2
      - droid2api-3
      - droid2api-4
    restart: unless-stopped

  droid2api-1:
    image: droid2api:latest
    environment:
      - FACTORY_API_KEY=${FACTORY_API_KEY}
      - ADMIN_ACCESS_KEY=${ADMIN_ACCESS_KEY}
      - REDIS_HOST=redis
      - CLUSTER_MODE=true
      - CLUSTER_WORKERS=4

  droid2api-2:
    image: droid2api:latest
    environment:
      - FACTORY_API_KEY=${FACTORY_API_KEY}
      - ADMIN_ACCESS_KEY=${ADMIN_ACCESS_KEY}
      - REDIS_HOST=redis
      - CLUSTER_MODE=true
      - CLUSTER_WORKERS=4

  droid2api-3:
    image: droid2api:latest
    environment:
      - FACTORY_API_KEY=${FACTORY_API_KEY}
      - ADMIN_ACCESS_KEY=${ADMIN_ACCESS_KEY}
      - REDIS_HOST=redis
      - CLUSTER_MODE=true
      - CLUSTER_WORKERS=4

  droid2api-4:
    image: droid2api:latest
    environment:
      - FACTORY_API_KEY=${FACTORY_API_KEY}
      - ADMIN_ACCESS_KEY=${ADMIN_ACCESS_KEY}
      - REDIS_HOST=redis
      - CLUSTER_MODE=true
      - CLUSTER_WORKERS=4

  redis:
    image: redis:alpine
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes

volumes:
  redis-data:
```

**Start the service:**
```bash
docker-compose -f docker-compose-nginx.yml up -d
```

**Benefits:**
- Throughput above 20000 RPS
- Disaster recovery across data centers
- Horizontal scaling

---

### 💡 Image optimization: multi-stage builds

**An optimized Dockerfile for a smaller image:**

```dockerfile
# Stage 1: build dependencies
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Stage 2: production runtime
FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

**Benefits:**
- Image size decreases from 500MB to 150MB (⬇️ 70%)
- Builds are 50% faster through caching
- Security: excludes development dependencies

---

## ☁️ Cloud deployment

### Render.com deployment (simplest ⭐)

**One-click deployment with automatic Dockerfile detection!**

1. Create a new Web Service on Render
2. Connect your GitHub repository
3. Configure:
   - **Environment**: Docker
   - **Branch**: main (or your branch)
   - **Port**: 3000
4. Add environment variables:
   - `FACTORY_API_KEY`: fixed API key (recommended)
   - `ADMIN_ACCESS_KEY`: admin password
5. Click "Create Web Service"

**Render provides automatically:**
- ✅ HTTPS certificates with automatic renewal
- ✅ Health checks
- ✅ Automatic restarts
- ✅ A free domain

---

### Railway deployment

1. Create a new Railway project
2. Select "Deploy from GitHub repo"
3. Select your repository
4. Railway detects the Dockerfile automatically
5. Add environment variables:
   - `FACTORY_API_KEY`: fixed API key (recommended)
   - `ADMIN_ACCESS_KEY`: admin password
6. A domain is assigned automatically after deployment

---

### Fly.io deployment

```bash
# 1. Install the Fly CLI
curl -L https://fly.io/install.sh | sh

# 2. Sign in
fly auth login

# 3. Initialize the application from the project directory
fly launch

# 4. Set environment variables
fly secrets set FACTORY_API_KEY="your_factory_api_key_here"
fly secrets set ADMIN_ACCESS_KEY="your-admin-password"

# 5. Deploy
fly deploy

# 6. Check status
fly status
fly logs
```

---

### Google Cloud Run deployment

```bash
# 1. Build and push the image
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/droid2api

# 2. Deploy to Cloud Run
gcloud run deploy droid2api \
  --image gcr.io/YOUR_PROJECT_ID/droid2api \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars FACTORY_API_KEY="your_factory_api_key_here" \
  --set-env-vars ADMIN_ACCESS_KEY="your-admin-password" \
  --port 3000 \
  --memory 512Mi \
  --cpu 1

# 3. Get the URL
gcloud run services describe droid2api --region us-central1
```

---

### AWS ECS deployment

```bash
# 1. Create an ECR repository
aws ecr create-repository --repository-name droid2api

# 2. Build and push the image
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com
docker build -t droid2api .
docker tag droid2api:latest YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/droid2api:latest
docker push YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/droid2api:latest

# 3. Create the ECS task definition
aws ecs register-task-definition --cli-input-json file://ecs-task-definition.json

# 4. Create the ECS service
aws ecs create-service \
  --cluster your-cluster-name \
  --service-name droid2api \
  --task-definition droid2api:1 \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}"
```

**ecs-task-definition.json：**
```json
{
  "family": "droid2api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "droid2api",
      "image": "YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/droid2api:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "FACTORY_API_KEY",
          "value": "your_factory_api_key_here"
        },
        {
          "name": "ADMIN_ACCESS_KEY",
          "value": "your-admin-password"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/droid2api",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

---

## 🎮 Using the admin interface

### Web admin interface

**Address:** `http://localhost:3000/` or `http://your-domain.com/`

**Sign in:** use `ADMIN_ACCESS_KEY` as the password (sent in the `x-admin-key` header)

**Main features:**
- 📊 **Key pool statistics** - Counts of total, available, disabled, and proxy-blocked keys
- 🆕 **Multi-tier key pools** - Create/delete pools and change key assignments
- 🎯 **Token usage monitoring** - Live total usage, today's usage, and request statistics
- ➕ **Add keys** - Add individually or import in bulk (provider type detected automatically)
- 🧪 **Test keys** - Check key availability individually or in batches
- 📤 **Export keys** - Filter by status and export to a txt file
- 🗑️ **Delete keys** - Delete individually or bulk-delete disabled/proxy-blocked keys
- ⚙️ **Configuration** - Adjust key selection, retries, and performance settings
- 📈 **Usage statistics** - Token usage heatmaps, success-rate rankings, and daily/hourly statistics

---

### Admin API

**All admin endpoints require the `x-admin-key` authentication header:**

```bash
curl -H "x-admin-key: your-admin-key" http://localhost:3000/admin/stats
```

#### Key pool endpoints

```bash
# Get key pool statistics
curl -H "x-admin-key: your-admin-key" http://localhost:3000/admin/stats

# List keys (supports pagination and status filtering)
curl -H "x-admin-key: your-admin-key" "http://localhost:3000/admin/keys?status=active&page=1&limit=20"

# Add one key
curl -X POST -H "x-admin-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"key": "fk-xxx", "notes": "Primary key", "poolGroup": "main"}' \
  http://localhost:3000/admin/keys

# Import keys in bulk
curl -X POST -H "x-admin-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"keys": ["fk-xxx", "fk-yyy"], "poolGroup": "freebies"}' \
  http://localhost:3000/admin/keys/batch

# Delete a key
curl -X DELETE -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/keys/key_1234567890

# Toggle key status (active/disabled)
curl -X PATCH -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/keys/key_1234567890/toggle

# Test one key
curl -X POST -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/keys/key_1234567890/test

# Batch-test all keys
curl -X POST -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/keys/test-all

# Export keys to a txt file, filtered by status
curl -H "x-admin-key: your-admin-key" \
  "http://localhost:3000/admin/keys/export?status=active"
```

#### 🆕 Multi-tier key pool endpoints (v1.4.0+)

```bash
# Get all pools and their statistics
curl -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/pool-groups

# Create a pool
curl -X POST -H "x-admin-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"id": "premium", "name": "Paid pool", "priority": 3}' \
  http://localhost:3000/admin/pool-groups

# Delete a pool (keys move to the default pool automatically)
curl -X DELETE -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/pool-groups/premium

# Change a key's pool
curl -X PATCH -H "x-admin-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"poolGroup": "main"}' \
  http://localhost:3000/admin/keys/key_1234567890/pool
```

#### Configuration endpoints

```bash
# Get key selection settings
curl -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/config

# Update key selection settings
curl -X PUT -H "x-admin-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "algorithm": "max-remaining",
    "retry": {"enabled": true, "max": 3},
    "autoBan": {"enabled": true, "ban_402": true}
  }' \
  http://localhost:3000/admin/config
```

#### Token usage endpoints

```bash
# Get token usage statistics
curl -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/token/usage

# Get a usage summary
curl -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/token/summary

# Trigger synchronization manually
curl -X POST -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/token/sync

# Clean up expired data
curl -X POST -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/token/cleanup
```

---

## 🩺 Health checks and monitoring

### Health check endpoints

**After the container starts, use these endpoints to check service status:**

```bash
# Check basic service availability
curl http://localhost:3000/

# List available models
curl http://localhost:3000/v1/models

# Check the admin API (requires ADMIN_ACCESS_KEY)
curl -H "x-admin-key: your-admin-key" http://localhost:3000/admin/stats
```

---

### Logging

droid2api logs according to its runtime mode:

**Production mode (NODE_ENV=production):**
- Console: concise logs
- Files: detailed logs in `logs/droid2api_YYYY-MM-DD.log`
- Automatic daily rotation

**Development mode (NODE_ENV=development):**
- Console: detailed logs
- Files: no file output

---

### Viewing logs

#### Docker Compose

```bash
# Follow container logs in real time
docker-compose logs -f

# View the last 100 lines
docker-compose logs --tail=100

# View logs for a specific service
docker-compose logs -f droid2api

# Read log files if a volume is mounted
docker exec droid2api ls /app/logs
docker exec droid2api cat /app/logs/droid2api_2025-10-13.log
```

#### Docker commands

```bash
# Follow container logs in real time
docker logs -f droid2api

# View the last 100 lines
docker logs --tail=100 droid2api

# Export logs to a file
docker logs droid2api > droid2api.log 2>&1

# Access log files inside the container
docker exec -it droid2api sh
cd logs
ls -lh
cat droid2api_2025-10-13.log
```

---

### Monitoring integrations

**Suggested integrations:**

- **Prometheus + Grafana** - Metrics monitoring
- **Datadog** - Full-stack monitoring
- **New Relic** - Application performance monitoring
- **Sentry** - Error tracking
- **ELK Stack** - Log aggregation and analysis

**Example Prometheus configuration:**
```yaml
scrape_configs:
  - job_name: 'droid2api'
    static_configs:
      - targets: ['localhost:3000']
```

---

## 🔧 Troubleshooting

### Container fails to start

**Check logs:**
```bash
docker logs droid2api
# Or
docker-compose logs
```

**Common issues:**
1. ❌ Missing authentication configuration (`FACTORY_API_KEY` or `DROID_REFRESH_KEY`)
   - **Resolution:** configure at least one authentication method in `.env`

2. ❌ API key or refresh token is invalid or expired
   - **Resolution:** verify the key and obtain a new one

3. ❌ Port 3000 is already in use
   - **Resolution:** change the port mapping in `docker-compose.yml` to `"3001:3000"`

4. ❌ `ADMIN_ACCESS_KEY` is unset or still has its default value
   - **Resolution:** set a strong password; avoid weak values such as `123` or `admin`

5. ❌ Volume permission issues
   - **Resolution:** `chmod -R 777 data logs`

---

### API requests return 401

**Cause:** API key or refresh token is expired or invalid

**Resolution:**
1. With `FACTORY_API_KEY`, check whether the key is valid
2. With `DROID_REFRESH_KEY`, obtain a new refresh token
3. Update the environment variables in `.env`
4. Restart the container: `docker-compose restart`

---

### Container restarts frequently

**Inspect health check and application logs:**
```bash
docker inspect droid2api | grep -A 10 "Health"
docker logs --tail=50 droid2api
```

**Possible causes:**
- Out of memory (OOM)
  - **Resolution:** increase the memory limit to `memory: 1024M`

- API key refresh fails
  - **Resolution:** check network connectivity or switch to `FACTORY_API_KEY`

- Invalid configuration file
  - **Resolution:** check the format of `data/config.json`

---

### Redis connection fails

**Symptom:** logs show `Redis connection error`

**Resolution:**
1. Check that the Redis container is running:
   ```bash
   docker ps | grep redis
   ```

2. Check the Redis connection settings:
   ```bash
   docker exec droid2api env | grep REDIS
   ```

3. Test the Redis connection manually:
   ```bash
   docker exec redis redis-cli ping
   ```

4. If Redis is unavailable, the system automatically falls back to file storage ✅

---

### Key pool data is lost

**Cause:** the container was replaced without persistent storage

**Resolution:**
1. Back up `data/key_pool.json` immediately:
   ```bash
   docker cp droid2api:/app/data/key_pool.json ./backup_key_pool.json
   ```

2. Edit `docker-compose.yml` to mount a volume:
   ```yaml
   volumes:
     - data-volume:/app/data
   ```

3. Restore the backup:
   ```bash
   docker cp ./backup_key_pool.json droid2api:/app/data/key_pool.json
   docker-compose restart
   ```

---

## 🔒 Security recommendations

### 🚨 High priority (required)

1. **Do not commit `.env` to Git**
   ```bash
   # Make sure .gitignore contains:
   .env
   data/
   logs/
   ```

2. **Set a strong `ADMIN_ACCESS_KEY`**
   - ✅ At least 16 characters
   - ✅ Include letters, digits, and symbols
   - ❌ Avoid weak passwords such as `123`, `admin`, or `password`

3. **Use secrets management for sensitive information**
   - Docker Secrets
   - Kubernetes Secrets
   - GitHub Secrets（CI/CD）

4. **Back up `data/key_pool.json` regularly** to preserve key pool data
   ```bash
   # Automatic daily backup
   0 2 * * * docker cp droid2api:/app/data/key_pool.json /backup/key_pool_$(date +\%Y\%m\%d).json
   ```

---

### 🔐 Medium priority (recommended)

5. **Use `FACTORY_API_KEY` in production** for greater stability without refresh

6. **Enable HTTPS** (often provided automatically by cloud platforms)
   - Nginx with Let's Encrypt certificates
   - Cloudflare CDN
   - Built-in cloud platform SSL

7. **Restrict access to the admin interface**
   - Configure a firewall allowlist
   - Configure a cloud platform IP allowlist
   - Access the admin interface through a VPN

8. **Use volumes to persist** key pool data and logs

---

### 🛡️ Low priority (best practices)

9. **Rotate API keys and refresh tokens regularly**

10. **Enable container resource limits**
    ```yaml
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 512M
    ```

11. **Update Docker images regularly**
    ```bash
    docker-compose pull
    docker-compose up -d
    ```

12. **Enable audit logging**
    - Record all admin operations
    - Record key usage
    - Review logs regularly

---

## 📚 Related documentation

- **Main documentation** - [README.md](README.md)
- **Architecture overview** - [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Multi-tier key pools** - [docs/MULTI_TIER_POOL.md](docs/MULTI_TIER_POOL.md)
- **AI context documentation** - [CLAUDE.md](CLAUDE.md)

---

## 🎉 Wrap-up

You now know how to deploy droid2api with Docker! 🚀

**Quick recap:**

| Requirement | Suggested deployment |
|------|----------|
| Personal use | Docker Compose + FACTORY_API_KEY |
| Multiple keys | Docker Compose + key pool |
| High concurrency (< 500,000/day) | Single container with default optimizations |
| High concurrency (500,000-1,000,000/day) | Single container + Redis |
| Very high concurrency (> 1,000,000/day) | Cluster mode + Redis |
| Enterprise production | Kubernetes + Redis + multi-tier key pools |

**Best-practice checklist:**
- [ ] Configure a strong `ADMIN_ACCESS_KEY`
- [ ] Configure at least one API authentication method
- [ ] Mount volumes for persistent storage
- [ ] Enable HTTPS
- [ ] Back up `key_pool.json` regularly
- [ ] Monitor service health through logs

**Need help?**
- Read [Troubleshooting](#-troubleshooting)
- Open an issue in the project repository
- Join the community discussion

Enjoy using droid2api! 💪🎊
