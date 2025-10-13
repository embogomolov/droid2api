# 导入密钥自动测试功能说明

## 功能概述

在批量导入密钥时，支持自动测试新导入的密钥，可以：
- ✅ 自动验证密钥有效性
- 🚫 **402错误自动拉黑** - 检测到余额不足的密钥自动封禁
- ⚡ 并发测试提高效率（默认10个并发）
- 📊 详细的测试结果统计

## 使用方法

### 1. 通过管理面板（推荐）

1. 打开管理面板，进入"密钥管理"Tab
2. 点击"📥 批量导入"按钮
3. 选择目标密钥池（可选）
4. 粘贴密钥列表（每行一个）
5. **勾选"🧪 自动测试新导入的密钥"**（默认勾选，推荐开启）
6. 点击"📥 开始导入"

**结果显示**：
```
✅ 成功导入 10 个密钥！
📊 总数: 10
✅ 成功: 10
🔄 重复: 0
❌ 无效: 0
🎯 导入到池: main

─────────────────────
🧪 自动测试结果
🔍 已测试: 10
✅ 成功: 8
❌ 失败: 2
🚫 已拉黑: 2 (402错误)
```

### 2. 通过API调用

**请求示例**：
```bash
curl -X POST http://localhost:3000/admin/keys/batch \
  -H "x-admin-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "keys": ["fk-xxx1", "fk-xxx2", "fk-xxx3"],
    "poolGroup": "main",
    "autoTest": true
  }'
```

**参数说明**：
- `keys`: 密钥数组（必需）
- `poolGroup`: 目标密钥池（可选，默认default）
- `autoTest`: 是否自动测试（可选，默认false）

**响应示例**：
```json
{
  "success": true,
  "message": "Batch import completed with auto-test",
  "data": {
    "import": {
      "success": 10,
      "duplicate": 0,
      "invalid": 0,
      "errors": [],
      "importedKeyIds": ["key_xxx1", "key_xxx2", ...]
    },
    "test": {
      "tested": 10,
      "success": 8,
      "failed": 2,
      "banned": 2
    }
  }
}
```

## 402错误自动拉黑机制

### 触发条件
当密钥测试时收到 **HTTP 402 Payment Required** 错误，表示密钥余额不足。

### 自动处理
1. 密钥状态自动设为 `banned`（封禁）
2. 记录封禁时间 `banned_at`
3. 记录封禁原因 `banned_reason`: "Payment Required - No Credits"
4. 增加错误计数 `error_count`
5. 记录最后错误 `last_error`: "402: xxx"

### 配置选项
在 `data/config.json` 或环境变量中配置：

```json
{
  "key_pool": {
    "autoBan": {
      "enabled": true,          // 启用自动封禁
      "ban402": true,           // 封禁402错误（余额不足）
      "ban401": false,          // 封禁401错误（认证失败）
      "errorThreshold": 5       // 错误阈值（其他错误累计达到此值后封禁）
    }
  }
}
```

**环境变量**：
```bash
KEY_POOL_AUTO_BAN_ENABLED=true    # 启用自动封禁
KEY_POOL_BAN_402=true             # 封禁402错误
KEY_POOL_BAN_401=false            # 不封禁401错误
```

## 测试流程

### 并发控制
- 默认并发数：10个密钥同时测试
- 可通过配置调整：`key_pool.performance.concurrentLimit`
- 批次之间延迟1秒，避免速率限制

### 测试过程
1. 筛选未测试的密钥（`last_test_at` 为空）
2. 跳过已封禁的密钥（`status === 'banned'`）
3. 分批并发测试
4. 记录测试时间 `last_test_at`
5. 更新测试结果 `last_test_result`

### 测试请求
使用真实的API请求进行测试：
```javascript
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 10,
  "messages": [{"role": "user", "content": "test"}],
  "stream": false
}
```

## 日志记录

**导入日志**：
```
[INFO] Admin batch imported keys: 10 success, 0 duplicate, 0 invalid (pool: main)
```

**测试日志**：
```
[INFO] Starting auto-test for 10 untested keys (10 concurrent)...
[INFO] Testing key: key_xxx1
[ERROR] Key test failed (402): key_xxx1
[INFO] 🚫 Key banned: key_xxx1 - Payment Required - No Credits
[INFO] Auto-test completed: 8 success, 2 failed, 2 banned (402 auto-banned)
```

## 性能优化

### 并发测试
- 批量导入10个密钥，自动测试仅需约2-3秒
- 并发数可配置，最大50个

### 超时控制
- 每个测试请求超时时间：10秒
- 使用 `AbortController` 实现超时控制

### HTTP连接池
- 复用TCP连接，减少握手开销
- Keep-Alive 连接提升性能

## 常见问题

### Q: 导入时必须开启自动测试吗？
A: 不必须，但**强烈推荐**。自动测试可以立即发现无效或余额不足的密钥，避免在实际使用时出错。

### Q: 402错误的密钥会被永久拉黑吗？
A: 密钥被标记为 `banned` 状态，但可以通过管理面板手动解禁（点击"🔓 解禁"按钮）。

### Q: 自动测试会消耗密钥额度吗？
A: 会消耗极少的额度（每个密钥约10个tokens），但相比实际使用可以忽略不计。

### Q: 可以测试所有未测试的密钥吗？
A: 可以，通过API调用：
```bash
# 测试所有未测试的密钥
curl -X POST http://localhost:3000/admin/keys/test-untested \
  -H "x-admin-key: your-admin-key"
```

### Q: 测试失败会影响导入吗？
A: 不会。导入和测试是两个独立的过程，即使测试失败，密钥仍然会被导入到密钥池。

## 与其他功能的关系

### 批量操作
- 导入后可使用批量操作功能（批量改池、批量启用/禁用、批量删除）

### 实时监控
- 被拉黑的密钥会在管理面板的统计中显示
- 可通过 `/admin/stats` API 查看密钥池状态

### Token使用量追踪
- 测试消耗的Token会被记录到 `token_usage.json`
- 可通过 `/admin/token/summary` API 查看详细使用量

## 技术实现

### 核心代码位置
- **后端逻辑**: `auth.js` → `testUntestedKeys()` 方法
- **API接口**: `api/admin-routes.js` → `/keys/batch` 路由
- **前端UI**: `public/index.html` + `public/pool-selection-ui.js`

### 数据流
```
用户导入 → importKeys() → 返回importedKeyIds
         ↓
    autoTest=true → testUntestedKeys(importedKeyIds)
         ↓
    testKey() → 检测402错误 → banKey()
         ↓
    返回测试结果统计
```

## 更新日志

### 2025-01-XX
- ✨ 新增导入密钥自动测试功能
- 🚫 支持402错误自动拉黑
- 📊 完善测试结果统计和显示
- 🎨 优化前端UI，默认勾选自动测试

---

**相关文档**：
- [403错误日志功能](./403-ERROR-LOGGING.md)
- [架构总览](./ARCHITECTURE.md)
- [配置初始化](./CONFIG_INITIALIZATION.md)
