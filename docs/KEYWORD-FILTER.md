# 关键词过滤系统文档

> **功能版本**: v1.4.2  
> **最后更新**: 2025-01-13

---

## 目录

1. [功能概述](#功能概述)
2. [核心功能](#核心功能)
3. [配置说明](#配置说明)
4. [管理 API](#管理-api)
5. [使用示例](#使用示例)
6. [测试验证](#测试验证)

---

## 功能概述

关键词过滤系统是 droid2api 的重要安全功能，用于在请求发送到上游 LLM API 之前，对客户端发送的系统提示词和用户提示词进行关键词检测和替换。

### 主要特点

- ✅ **多种匹配模式**：支持包含、精确、正则等多种匹配方式
- ✅ **多种处理动作**：支持替换、删除、阻止等操作
- ✅ **智能过滤**：自动过滤 system 和 user 消息
- ✅ **规则管理**：支持动态添加、修改、删除过滤规则
- ✅ **性能优化**：高效的文本匹配算法
- ✅ **详细日志**：记录所有过滤操作

---

## 核心功能

### 1. 过滤范围

系统会自动过滤以下内容：

- **系统提示词** (`system` 参数)
- **系统消息** (`messages` 中 `role: system`)
- **用户消息** (`messages` 中 `role: user`)
- **复杂内容块** (支持多模态内容，只过滤 `text` 类型)

**注意**：不过滤 `assistant` 角色的消息。

### 2. 匹配模式

| 模式 | 说明 | 示例 |
|------|------|------|
| `contains` | 包含匹配（大小写可选） | "xx" 匹配 "这是xx测试" |
| `exact` | 精确匹配 | "关键词" 只匹配 "关键词" |
| `startsWith` | 开头匹配 | "禁止" 匹配 "禁止访问" |
| `endsWith` | 结尾匹配 | "密码" 匹配 "请输入密码" |
| `regex` | 正则表达式 | `\b(密码|密钥)\b` 匹配单词边界 |

### 3. 处理动作

| 动作 | 说明 | 示例 |
|------|------|------|
| `replace` | 替换为指定文本 | "xx" → "**" |
| `remove` | 删除匹配内容 | "xx" → "" |
| `block` | 阻止整个请求（返回空字符串） | - |

---

## 配置说明

### 配置文件位置

```
data/keyword-filter.json
```

### 配置文件结构

```json
{
  "enabled": true,
  "rules": [
    {
      "id": "rule-1",
      "name": "黑名单提示词",
      "enabled": true,
      "pattern": {
        "type": "contains",
        "value": "敏感词",
        "caseSensitive": false
      },
      "action": {
        "type": "replace",
        "replacement": "***"
      },
      "description": "过滤敏感词"
    }
  ],
  "logging": {
    "enabled": true,
    "logMatches": true,
    "logActions": true
  }
}
```

### 配置字段说明

#### 全局配置

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | boolean | 全局开关（false 则不执行任何过滤） |
| `rules` | array | 过滤规则列表 |
| `logging.enabled` | boolean | 是否启用日志 |
| `logging.logMatches` | boolean | 是否记录匹配日志 |
| `logging.logActions` | boolean | 是否记录操作日志 |

#### 规则配置

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 规则唯一标识 |
| `name` | string | 是 | 规则名称 |
| `enabled` | boolean | 是 | 规则开关 |
| `description` | string | 否 | 规则描述 |
| `pattern.type` | string | 是 | 匹配类型 |
| `pattern.value` | string | 是 | 匹配值/正则表达式 |
| `pattern.caseSensitive` | boolean | 否 | 是否区分大小写（默认 false） |
| `action.type` | string | 是 | 处理动作类型 |
| `action.replacement` | string | 否 | 替换文本（仅 replace 动作需要） |

---

## 管理 API

所有管理 API 都需要在请求头中携带 `x-admin-key`。

### 基础路径

```
/admin/keyword-filter
```

### API 端点

#### 1. 获取配置

```http
GET /admin/keyword-filter/config
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "enabled": true,
    "rules": [...],
    "logging": {...}
  }
}
```

---

#### 2. 更新配置

```http
PUT /admin/keyword-filter/config
Content-Type: application/json

{
  "enabled": true,
  "rules": [...],
  "logging": {...}
}
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "message": "Configuration updated successfully"
  }
}
```

---

#### 3. 获取所有规则

```http
GET /admin/keyword-filter/rules
```

**响应示例**：
```json
{
  "success": true,
  "data": [
    {
      "id": "rule-1",
      "name": "黑名单提示词",
      "enabled": true,
      ...
    }
  ]
}
```

---

#### 4. 添加规则

```http
POST /admin/keyword-filter/rules
Content-Type: application/json

{
  "name": "新规则",
  "enabled": true,
  "pattern": {
    "type": "contains",
    "value": "关键词",
    "caseSensitive": false
  },
  "action": {
    "type": "replace",
    "replacement": "***"
  },
  "description": "规则描述"
}
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "message": "Rule added successfully",
    "rule": {
      "id": "rule-1736781234567",
      ...
    }
  }
}
```

---

#### 5. 更新规则

```http
PUT /admin/keyword-filter/rules/{ruleId}
Content-Type: application/json

{
  "name": "更新后的规则",
  "enabled": true,
  ...
}
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "message": "Rule updated successfully",
    "rule": {...}
  }
}
```

---

#### 6. 删除规则

```http
DELETE /admin/keyword-filter/rules/{ruleId}
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "message": "Rule deleted successfully",
    "rule": {...}
  }
}
```

---

#### 7. 切换规则状态

```http
PATCH /admin/keyword-filter/rules/{ruleId}/toggle
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "message": "Rule toggled successfully",
    "rule": {
      "id": "rule-1",
      "enabled": false,
      ...
    }
  }
}
```

---

#### 8. 切换全局过滤

```http
PATCH /admin/keyword-filter/toggle
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "message": "Global filter toggled successfully",
    "enabled": false
  }
}
```

---

#### 9. 获取统计信息

```http
GET /admin/keyword-filter/stats
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "enabled": true,
    "totalRules": 5,
    "enabledRules": 3,
    "lastLoadTime": 1736781234567,
    "configPath": "F:\\...\\data\\keyword-filter.json"
  }
}
```

---

#### 10. 测试规则

```http
POST /admin/keyword-filter/test
Content-Type: application/json

{
  "text": "这是一个测试文本，包含关键词",
  "ruleId": "rule-1"  // 可选，不提供则测试所有规则
}
```

**响应示例（单个规则）**：
```json
{
  "success": true,
  "data": {
    "matched": true,
    "original": "这是一个测试文本，包含关键词",
    "filtered": "这是一个测试文本，包含***",
    "rule": "黑名单提示词"
  }
}
```

**响应示例（所有规则）**：
```json
{
  "success": true,
  "data": {
    "original": "这是一个测试文本，包含关键词",
    "filtered": "这是一个测试文本，包含***",
    "changed": true
  }
}
```

---

#### 11. 重新加载配置

```http
POST /admin/keyword-filter/reload
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "message": "Configuration reloaded successfully",
    "stats": {...}
  }
}
```

---

## 使用示例

### 示例 1：过滤敏感词

**配置**：
```json
{
  "id": "rule-sensitive",
  "name": "敏感词过滤",
  "enabled": true,
  "pattern": {
    "type": "contains",
    "value": "敏感",
    "caseSensitive": false
  },
  "action": {
    "type": "replace",
    "replacement": "***"
  }
}
```

**原始请求**：
```json
{
  "model": "claude-sonnet-4",
  "messages": [
    {
      "role": "user",
      "content": "这是一个包含敏感词的请求"
    }
  ]
}
```

**过滤后**：
```json
{
  "model": "claude-sonnet-4",
  "messages": [
    {
      "role": "user",
      "content": "这是一个包含***词的请求"
    }
  ]
}
```

---

### 示例 2：使用正则表达式

**配置**：
```json
{
  "id": "rule-regex",
  "name": "邮箱地址过滤",
  "enabled": true,
  "pattern": {
    "type": "regex",
    "value": "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
    "caseSensitive": false
  },
  "action": {
    "type": "replace",
    "replacement": "[邮箱已隐藏]"
  }
}
```

**原始请求**：
```json
{
  "role": "user",
  "content": "请发送到 user@example.com"
}
```

**过滤后**：
```json
{
  "role": "user",
  "content": "请发送到 [邮箱已隐藏]"
}
```

---

### 示例 3：阻止请求

**配置**：
```json
{
  "id": "rule-block",
  "name": "阻止特定关键词",
  "enabled": true,
  "pattern": {
    "type": "contains",
    "value": "违禁词",
    "caseSensitive": false
  },
  "action": {
    "type": "block"
  }
}
```

**效果**：包含 "违禁词" 的消息会被完全清空。

---

## 测试验证

### 运行测试脚本

```bash
node tests/test-keyword-filter.js
```

### 测试覆盖

1. ✅ 基本文本过滤
2. ✅ system 消息过滤
3. ✅ user 消息过滤
4. ✅ 完整请求体过滤
5. ✅ 复杂内容块过滤（多模态）
6. ✅ 统计信息查询

### 使用 curl 测试 API

```bash
# 获取配置
curl -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/keyword-filter/config

# 测试规则
curl -X POST \
  -H "x-admin-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"text": "测试文本包含敏感词"}' \
  http://localhost:3000/admin/keyword-filter/test

# 添加规则
curl -X POST \
  -H "x-admin-key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "新规则",
    "enabled": true,
    "pattern": {
      "type": "contains",
      "value": "关键词",
      "caseSensitive": false
    },
    "action": {
      "type": "replace",
      "replacement": "***"
    }
  }' \
  http://localhost:3000/admin/keyword-filter/rules

# 切换全局过滤
curl -X PATCH \
  -H "x-admin-key: your-admin-key" \
  http://localhost:3000/admin/keyword-filter/toggle
```

---

## 性能说明

- **匹配性能**：contains/exact/startsWith/endsWith 使用原生字符串方法，性能优异
- **正则性能**：正则表达式会被缓存，避免重复编译
- **内存占用**：配置文件按需加载，占用内存极小
- **并发安全**：单例模式，全局共享一个过滤器实例

---

## 安全建议

1. **定期审查规则**：定期检查过滤规则是否仍然适用
2. **测试后启用**：新规则建议先测试，确认无误后再启用
3. **备份配置**：定期备份 `keyword-filter.json`
4. **监控日志**：关注过滤日志，发现异常及时调整
5. **避免过度过滤**：过于严格的规则可能影响正常使用

---

## 故障排查

### Q: 规则不生效？

**检查**：
1. 全局开关 `enabled: true`
2. 规则开关 `rule.enabled: true`
3. 匹配模式和值是否正确
4. 是否调用了 `reload` 重新加载配置

### Q: 正则表达式报错？

**解决**：
1. 使用在线工具测试正则表达式
2. 注意转义字符（JSON 中使用双反斜杠）
3. 检查正则表达式语法是否正确

### Q: 性能影响？

**优化**：
1. 减少正则表达式规则数量
2. 优先使用 contains/exact 等简单匹配
3. 禁用不必要的日志记录

---

## 更新日志

### v1.4.2 (2025-01-13)

- ✨ 新增关键词过滤系统
- ✅ 支持多种匹配模式和处理动作
- ✅ 完整的管理 API
- ✅ 自动过滤 system 和 user 消息
- ✅ 集成到所有请求转换层

---

**文档结束**
