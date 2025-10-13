# Token 自动同步配置指南

## 📖 概述

Token 自动同步功能会定期查询 Factory API，获取每个密钥的真实 Token 使用量和剩余配额，缓存到本地 `data/token_usage.json` 文件中。

这些数据被高级轮询算法使用（如 `least-token-used`、`max-remaining`），实现基于服务商真实用量的智能密钥选择。

---

## ⚙️ 配置方式

### 方式 1: 环境变量（推荐）

在 `.env` 文件中配置：

```bash
# 是否启用Token自动同步（默认 true）
TOKEN_SYNC_ENABLED=true

# 同步间隔（分钟，默认 5）
TOKEN_SYNC_INTERVAL_MINUTES=5

# 启动时是否立即同步（默认 true）
TOKEN_SYNC_ON_STARTUP=true

# 启动时等待同步完成的超时时间（秒，默认 10）
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=10
```

### 方式 2: 配置文件

在 `data/config.json` 中配置：

```json
{
  "token_sync": {
    "enabled": true,
    "interval_minutes": 5,
    "on_startup": true,
    "startup_timeout_seconds": 10
  }
}
```

**优先级：** 环境变量 > config.json

---

## 📊 配置项详解

### 1. `TOKEN_SYNC_ENABLED`

**描述：** 是否启用 Token 自动同步

**默认值：** `true`

**可选值：**
- `true` - 启用（推荐）
- `false` - 禁用

**禁用影响：**
- 依赖 Token 使用量的轮询算法（`least-token-used`、`max-remaining` 等）将降级为简单轮询
- 管理面板的 Token 统计功能不可用

**使用场景：**
- ✅ 推荐启用：使用高级轮询算法，需要查询真实用量
- ❌ 可以禁用：只使用简单轮询算法（`round-robin`、`random`、`least-used`）

---

### 2. `TOKEN_SYNC_INTERVAL_MINUTES`

**描述：** 自动同步的间隔时间（分钟）

**默认值：** `5`

**建议范围：** 1-60 分钟

**注意事项：**
- ⚠️ 间隔太短（< 1 分钟）可能触发 Factory API 限流
- 💡 间隔太长（> 60 分钟）数据可能不够实时

**推荐配置：**
```bash
# 密钥数量较少（< 10个）- 3 分钟
TOKEN_SYNC_INTERVAL_MINUTES=3

# 密钥数量中等（10-100个）- 5 分钟（默认）
TOKEN_SYNC_INTERVAL_MINUTES=5

# 密钥数量较多（> 100个）- 10 分钟
TOKEN_SYNC_INTERVAL_MINUTES=10
```

---

### 3. `TOKEN_SYNC_ON_STARTUP`

**描述：** 服务器启动时是否立即执行一次同步

**默认值：** `true`

**可选值：**
- `true` - 立即同步（推荐⭐）
- `false` - 等待第一个定时周期

**影响：**
- `true`: 启动后 1-10 秒内完成首次同步，确保有数据
- `false`: 启动后需等待 `interval_minutes` 分钟后才开始同步

**使用场景：**
- ✅ 首次部署或新添加密钥 → 设置为 `true`
- ⚠️ 频繁重启且已有缓存 → 可设置为 `false`

---

### 4. `TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS`

**描述：** 启动时等待首次同步完成的超时时间（秒）

**默认值：** `10`

**建议范围：** 0-30 秒

**工作原理：**
- 服务器启动时会等待首次同步完成
- 如果超时，服务器继续启动（后台同步继续进行）
- 设置为 `0` 表示不等待，立即启动

**推荐配置：**
```bash
# 密钥数量较少（< 10个）- 5 秒
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=5

# 密钥数量中等（10-100个）- 10 秒（默认）
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=10

# 密钥数量较多（> 100个）- 20 秒
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=20

# 不等待，立即启动（可能导致首次请求无数据）
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=0
```

---

## 🚀 使用场景

### 场景 1：首次部署（推荐配置）

```bash
TOKEN_SYNC_ENABLED=true
TOKEN_SYNC_INTERVAL_MINUTES=5
TOKEN_SYNC_ON_STARTUP=true
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=10
```

**说明：**
- 启动时立即同步，确保首次请求就有数据
- 每 5 分钟自动更新一次
- 等待最多 10 秒完成首次同步

---

### 场景 2：高频率更新（密钥较少）

```bash
TOKEN_SYNC_ENABLED=true
TOKEN_SYNC_INTERVAL_MINUTES=3
TOKEN_SYNC_ON_STARTUP=true
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=5
```

**说明：**
- 适合密钥数量少（< 10个）
- 数据更实时，适合精细化管理
- 启动快速（5秒超时）

---

### 场景 3：大规模密钥池（100+ 密钥）

```bash
TOKEN_SYNC_ENABLED=true
TOKEN_SYNC_INTERVAL_MINUTES=10
TOKEN_SYNC_ON_STARTUP=true
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=20
```

**说明：**
- 同步间隔加长，避免 API 限流
- 启动超时加长，确保首次同步完成

---

### 场景 4：禁用自动同步（仅本地统计）

```bash
TOKEN_SYNC_ENABLED=false
```

**说明：**
- 完全禁用 Factory API 查询
- 高级轮询算法降级为简单轮询
- 适合不需要真实用量的场景

---

## 📈 启动日志示例

### 成功启动

```
[INFO] 🔄 启动 Token 自动同步调度器（间隔: 5 分钟）...
[INFO] 🔄 开始同步 Factory API Token 使用量...
[INFO] ✅ Token 同步完成: 69 成功, 0 失败
[INFO] ✅ Token 自动同步调度器已启动并完成首次同步
[INFO] Server running on http://localhost:3000
```

### 超时启动（仍然正常）

```
[INFO] 🔄 启动 Token 自动同步调度器（间隔: 5 分钟）...
[INFO] 🔄 开始同步 Factory API Token 使用量...
[WARN] ⚠️ Token 首次同步超时（10秒），服务器继续启动（后台同步将继续进行）
[INFO] Server running on http://localhost:3000
```

### 禁用同步

```
[WARN] ⚠️ Token 自动同步已禁用（TOKEN_SYNC_ENABLED=false）
[INFO] 💡 依赖 Token 使用量的轮询算法（如 least-token-used）将降级为简单轮询
[INFO] Server running on http://localhost:3000
```

---

## 🔍 故障排查

### 问题 1：启动时一直等待同步

**症状：**
```
[INFO] 🔄 启动 Token 自动同步调度器（间隔: 5 分钟）...
[INFO] 🔄 开始同步 Factory API Token 使用量...
（卡住不动）
```

**原因：**
- 密钥数量太多，同步时间超过超时限制
- Factory API 响应慢

**解决方案：**
```bash
# 增加超时时间
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=30

# 或者不等待，立即启动
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=0
```

---

### 问题 2：轮询算法提示"没有 Token 使用量数据"

**症状：**
```
[WARN] ⚠️ 没有Token使用量数据，降级使用 round-robin 算法
[INFO] 💡 提示：Token 自动同步可能尚未完成，请等待几秒后重试
```

**原因：**
- 首次部署，`data/token_usage.json` 文件不存在
- 同步尚未完成

**解决方案：**
1. 等待 10-20 秒，让首次同步完成
2. 检查日志确认同步成功
3. 手动触发同步（管理面板 → Token 统计 → 手动同步）

---

### 问题 3：同步失败

**症状：**
```
[ERROR] ❌ Token 同步失败: Request timeout
```

**原因：**
- 网络问题
- Factory API 限流
- 密钥无效

**解决方案：**
1. 检查网络连接
2. 增加同步间隔，避免触发限流
3. 检查密钥是否有效（管理面板 → 密钥管理 → 测试密钥）

---

## 🎯 最佳实践

### 1. 启动时等待同步完成

```bash
TOKEN_SYNC_ON_STARTUP=true
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=10
```

**优点：**
- 首次请求就有准确数据
- 避免算法降级

---

### 2. 根据密钥数量调整间隔

```bash
# < 10个密钥
TOKEN_SYNC_INTERVAL_MINUTES=3

# 10-100个密钥
TOKEN_SYNC_INTERVAL_MINUTES=5

# > 100个密钥
TOKEN_SYNC_INTERVAL_MINUTES=10
```

---

### 3. 生产环境配置

```bash
TOKEN_SYNC_ENABLED=true
TOKEN_SYNC_INTERVAL_MINUTES=5
TOKEN_SYNC_ON_STARTUP=true
TOKEN_SYNC_STARTUP_TIMEOUT_SECONDS=15
```

**说明：**
- 稍微增加超时时间，确保稳定启动
- 保持中等同步频率，平衡实时性和性能

---

## 📚 相关文档

- [轮询算法配置](./KEY_POOL_ALGORITHMS.md)
- [管理 API 文档](./API.md)
- [架构文档](./ARCHITECTURE.md)

---

**更新时间：** 2025-01-XX  
**版本：** v1.4.1
