# 配置初始化机制

> 更新日期：2025-10-13  
> 版本：v1.4.2

## 🎯 设计理念

**第一次从 .env 初始化，之后所有配置都在 config.json 管理**

## 📋 配置优先级

### 首次启动（config.json 不存在）

```
.env 环境变量 → 生成 config.json
```

系统会从 `.env` 读取所有配置项，创建 `data/config.json`。

### 之后启动（config.json 已存在）

```
config.json（主要配置）+ 特定环境变量（运行时覆盖）
```

- **config.json**：所有配置项的主要来源
- **环境变量**：只有特定变量（PORT、NODE_ENV）会覆盖 config.json

## 🚀 工作流程

### 1. 初始化阶段

```bash
# 用户首次启动
npm start

# 系统检测到 config.json 不存在
[INFO] config.json 不存在，从 .env 初始化默认配置...
[INFO] ✅ 已创建 config.json，配置来自 .env
[INFO] 💡 之后修改配置请使用管理面板或直接编辑 config.json
```

生成的 `config.json` 包含：
- 端口、模型、端点（固定默认值）
- 轮询算法（从 `KEY_POOL_ALGORITHM` 读取）
- 多级密钥池（从 `KEY_POOL_MULTI_TIER_ENABLED` 读取）
- 限制配置（从 `NOTES_MAX_LENGTH` 等读取）
- 推理Token预算（从 `REASONING_BUDGET_*` 读取）
- 余额同步配置（从 `SYNC_INTERVAL_MINUTES` 等读取）

### 2. 后续启动

```bash
npm start

# 系统检测到 config.json 已存在
[INFO] Configuration loaded successfully
```

直接读取 `config.json`，忽略 .env 中的配置项。

### 3. 配置修改

**推荐方式（自动生效）**：
1. 访问管理面板 `http://localhost:3000`
2. 切换到"系统配置"Tab
3. 修改任意配置项
4. 点击"保存配置"

**手动方式**：
1. 编辑 `data/config.json`
2. 重启服务器：`npm start`

**不推荐**：
- ❌ 修改 `.env` 中的配置项（不会生效，因为 config.json 已存在）

## ⚙️ 环境变量分类

### 类型 1：运行时环境变量（始终生效）

这些变量会覆盖 config.json，适合动态环境：

```env
PORT=3000                      # 服务端口
NODE_ENV=development           # 开发/生产模式
```

**使用场景**：
- Docker 容器：通过 `-e PORT=8080` 动态设置端口
- 云平台：通过平台环境变量设置端口
- 开发/生产切换：`NODE_ENV=development` vs `production`

### 类型 2：初始化配置变量（仅首次生效）

这些变量只在首次生成 config.json 时读取：

```env
# 系统配置
USER_AGENT=factory-cli/0.19.3
SYSTEM_PROMPT=You are Droid...

# 密钥池配置
KEY_POOL_ALGORITHM=round-robin
KEY_POOL_MULTI_TIER_ENABLED=true
KEY_POOL_MULTI_TIER_AUTO_FALLBACK=true
KEY_POOL_RETRY_ENABLED=true
KEY_POOL_RETRY_MAX=3
KEY_POOL_AUTO_BAN_ENABLED=true
KEY_POOL_BAN_402=true

# 限制配置
NOTES_MAX_LENGTH=1000
MAX_JSON_LOG_SIZE=5000

# 推理Token配置
REASONING_BUDGET_LOW=4096
REASONING_BUDGET_MEDIUM=12288
REASONING_BUDGET_HIGH=24576

# 余额同步配置
SYNC_INTERVAL_MINUTES=30
BALANCE_SAVE_INTERVAL_MINUTES=5
```

**使用场景**：
- 新项目初始化：设置合适的默认值
- 团队标准化：通过 .env.example 统一默认配置
- 快速部署：克隆项目后立即可用

### 类型 3：认证变量（始终生效）

这些变量用于认证，不保存在 config.json：

```env
FACTORY_API_KEY=fk-xxx         # 固定API密钥
DROID_REFRESH_KEY=rt-xxx       # OAuth刷新Token
ADMIN_ACCESS_KEY=xxx           # 管理员密钥
API_ACCESS_KEY=xxx             # 客户端访问密钥
```

**原因**：
- 安全性：密钥不应存储在配置文件
- 灵活性：可随时通过环境变量更换
- 兼容性：支持多种认证方式

## 📝 示例场景

### 场景 1：新项目初始化

```bash
# 1. 克隆项目
git clone https://github.com/your-username/droid2api.git
cd droid2api

# 2. 安装依赖
npm install

# 3. 复制 .env 模板（可选，使用默认值也可以）
cp .env.example .env

# 4. 编辑 .env 设置初始配置（可选）
nano .env

# 5. 首次启动（自动生成 config.json）
npm start
```

输出：
```
[INFO] config.json 不存在，从 .env 初始化默认配置...
[INFO] ✅ 已创建 config.json，配置来自 .env
[INFO] 💡 之后修改配置请使用管理面板或直接编辑 config.json
[INFO] Configuration loaded successfully
[INFO] 🚀 启动密钥池管理系统...
[INFO] ✅ 多级密钥池已启用
```

### 场景 2：修改配置（推荐）

```bash
# 1. 访问管理面板
# http://localhost:3000

# 2. 登录并切换到"系统配置"Tab

# 3. 修改配置项（例如修改轮询算法）
# 轮询算法: round-robin → least-token-used

# 4. 点击"保存配置"
```

配置立即生效，无需重启服务器。

### 场景 3：Docker 部署

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app
COPY . .
RUN npm install

# 不需要复制 config.json，首次启动自动生成
CMD ["npm", "start"]
```

```bash
# docker-compose.yml
version: '3.8'
services:
  droid2api:
    build: .
    ports:
      - "3000:3000"
    environment:
      PORT: 3000                           # 运行时覆盖
      NODE_ENV: production                 # 运行时覆盖
      ADMIN_ACCESS_KEY: secure-password    # 认证密钥
      KEY_POOL_ALGORITHM: least-token-used # 首次初始化配置
      KEY_POOL_MULTI_TIER_ENABLED: "true"  # 首次初始化配置
    volumes:
      - ./data:/app/data                   # 持久化配置文件
```

首次启动：
1. 容器启动，检测到 `/app/data/config.json` 不存在
2. 从环境变量读取配置，生成 `config.json`
3. 保存到 volume，持久化

后续启动：
1. 容器启动，读取 `/app/data/config.json`
2. `PORT` 和 `NODE_ENV` 仍从环境变量读取（运行时覆盖）

### 场景 4：团队协作

**项目维护者**：

```bash
# 更新 .env.example，调整默认配置
# 提交到 Git
git add .env.example
git commit -m "chore: 更新默认轮询算法为 least-token-used"
```

**团队成员**：

```bash
# 拉取最新代码
git pull

# 删除本地 config.json（可选，如果想使用新默认值）
rm data/config.json

# 重新启动（自动生成新的 config.json）
npm start
```

## 🔧 高级用法

### 强制重新初始化

如果想重新从 .env 生成配置：

```bash
# 备份现有配置（可选）
cp data/config.json data/config.json.backup

# 删除配置文件
rm data/config.json

# 重新启动（从 .env 重新生成）
npm start
```

### 混合模式（不推荐）

如果确实需要某些配置项始终从 .env 读取，可以修改 `config.js`：

```javascript
export function getKeyPoolConfig() {
  const cfg = getConfig();
  const keyPoolCfg = cfg.key_pool || {};

  return {
    // 这个字段始终从环境变量读取（如果存在）
    algorithm: process.env.KEY_POOL_ALGORITHM || keyPoolCfg.algorithm || 'round-robin',
    
    // 其他字段优先使用 config.json
    retry: keyPoolCfg.retry || { ... },
  };
}
```

### 配置迁移

从旧版本（没有 config.json）迁移：

```bash
# 1. 确保 .env 包含所有配置
cat .env

# 2. 删除旧的配置缓存（如果存在）
rm -rf data/*.json

# 3. 启动服务器（自动生成 config.json）
npm start

# 4. 验证配置
curl http://localhost:3000/admin/config -H "x-admin-key: your-key"
```

## ⚠️ 注意事项

1. **配置文件不上传**：
   - `data/config.json` 已在 `.gitignore`
   - 每个环境都有自己的 `config.json`

2. **敏感信息不存储**：
   - API 密钥不保存在 `config.json`
   - 始终使用环境变量或 `data/auth.json`

3. **端口冲突**：
   - `PORT` 环境变量优先级高于 `config.json`
   - 适合云平台动态分配端口

4. **开发模式**：
   - `NODE_ENV=development` 始终从环境变量读取
   - 不保存在 `config.json`

## 🎯 最佳实践

### ✅ 推荐做法

1. **首次部署**：
   - 创建 `.env` 文件，设置初始配置
   - 启动服务器，自动生成 `config.json`

2. **日常配置修改**：
   - 使用管理面板的"系统配置"页面
   - 或直接编辑 `config.json`

3. **团队协作**：
   - 通过 `.env.example` 同步默认配置
   - 每个成员维护自己的 `config.json`

4. **生产部署**：
   - Docker: 挂载 volume 持久化 `config.json`
   - 云平台: 使用环境变量设置 `PORT` 和 `NODE_ENV`

### ❌ 避免做法

1. **不要混淆配置来源**：
   - ❌ `config.json` 存在后仍然期望 `.env` 生效

2. **不要提交敏感配置**：
   - ❌ `git add data/config.json`
   - ❌ `.env` 包含真实密钥

3. **不要手动合并配置**：
   - ❌ 同时修改 `.env` 和 `config.json`
   - 容易造成混淆

## 📚 相关文档

- [data/README.md](../data/README.md) - 配置文件说明
- [README.md](../README.md) - 项目主文档
- [CLAUDE.md](../CLAUDE.md) - 完整架构文档

---

**作者**：BaSui  
**更新时间**：2025-10-13 13:30:00  
**版本**：v1.4.2
