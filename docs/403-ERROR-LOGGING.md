# 403 错误日志记录功能

## 功能概述

当代理服务器收到上游 API 返回的 403 Forbidden 错误时，会自动记录详细的日志信息到专门的日志文件 `logs/403_errors.log`，方便排查问题。

**🔒 安全保证**：所有敏感信息（密钥ID、API Key）均已脱敏处理，不会暴露完整密钥。

## 日志内容

每次 403 错误会记录以下完整信息：

### 1. 基本信息
- **Request ID**: 请求唯一标识符
- **Key ID**: 使用的密钥ID（**已脱敏**，只显示前6位和后4位，如：`key_17...a4y`）
- **Endpoint**: 上游API端点
- **Timestamp**: 错误发生时间

### 2. 错误详情
- 上游API返回的完整错误响应内容

### 3. 原始请求（OpenAI 格式）
- **请求模型**: 使用的模型名称和是否流式传输
- **系统提示词**: 自动从请求中提取系统提示词
  - OpenAI 格式：从 `messages` 数组中提取 `role: "system"` 的内容
  - Anthropic 格式：从 `system` 字段提取
- **用户提示词**: 所有用户消息（`role: "user"`）
- **完整消息历史**: 按顺序列出所有消息（system、user、assistant）
- **其他参数**: temperature、max_tokens 等配置参数

### 4. 转换后的请求
- 如果请求格式有转换（例如 OpenAI → Anthropic），会显示实际发送给上游API的请求内容

### 5. 请求头信息
- 包含所有请求头
- **密钥已脱敏**: 
  - Authorization 头中的密钥只显示前8个字符（如：`Bearer fk-UUKEX...`）
  - x-api-key、api-key 等其他认证头也会自动脱敏

## 🔒 安全与脱敏

### 默认脱敏策略

为保护密钥安全，日志会自动对敏感信息进行脱敏：

1. **密钥ID脱敏**
   - 原始：`key_1760197036953_v0otzot5e`
   - 脱敏后：`key_17...ot5e (已脱敏)`
   - 规则：只显示前6位和后4位

2. **API Key脱敏**
   - 原始：`fk-UUKEX1DnmDf49iJhoRdk-qlm2YYKSrIC_Iyv-uTZsHZnISwRCe2wdZV-wgfLreaw`
   - 脱敏后：`fk-UUKEX... (已脱敏)`
   - 规则：只显示前8个字符

3. **Authorization头脱敏**
   - 原始：`Bearer fk-xxxxxxxxxxxxx`
   - 脱敏后：`Bearer fk-UUKEX... (已脱敏)`

### 完全隐藏密钥ID（可选）

如果你希望完全不记录密钥ID信息，可以设置环境变量：

```bash
# 完全隐藏密钥ID
export LOG_403_MASK_KEYS=false
```

设置后，密钥ID会显示为 `***HIDDEN*** (已隐藏)`，而不是部分脱敏。

## 日志格式示例

```
════════════════════════════════════════════════════════════════════════════
403 FORBIDDEN ERROR - 2025-10-13T09:50:24.425Z
════════════════════════════════════════════════════════════════════════════

【基本信息】
  Request ID: req-1728812345678
  Key ID: key_16...c123 (已脱敏)
  Endpoint: https://api.factory.ai/v1/messages
  Timestamp: 2025-10-13T09:50:24.425Z

【错误详情】
  {
    "error": {
      "type": "permission_error",
      "message": "Your API key does not have permission to use the specified model."
    }
  }

┌─────────────────────────────────────────────────────────────────────────┐
│  原始请求（OpenAI 格式）                                                  │
└─────────────────────────────────────────────────────────────────────────┘

【请求模型】
  Model: claude-sonnet-4-5-20250929
  Stream: true

【系统提示词】
  You are Droid, an AI software engineering agent built by Factory.

【用户提示词】
  [消息 1]
  Write a function to calculate fibonacci numbers

【完整消息历史】
  [1] Role: system
      Content: You are Droid, an AI software engineering agent built by Factory.
  [2] Role: user
      Content: Write a function to calculate fibonacci numbers

【其他参数】
  {
    "temperature": 0.7,
    "max_tokens": 2000
  }

┌─────────────────────────────────────────────────────────────────────────┐
│  请求头信息                                                              │
└─────────────────────────────────────────────────────────────────────────┘

{
  "authorization": "Bearer fk-UUKEX... (已脱敏)",
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "x-factory-client": "droid2api/1.4.1",
  "x-session-id": "session-12345",
  "user-agent": "Claude Code"
}

════════════════════════════════════════════════════════════════════════════
```

## 日志文件位置

```
logs/403_errors.log
```

## 影响的接口

403 错误日志功能已集成到以下三个接口：

1. **`POST /v1/chat/completions`** - 标准 OpenAI 聊天补全接口（带格式转换）
2. **`POST /v1/responses`** - OpenAI Responses API 直接转发接口
3. **`POST /v1/messages`** - Anthropic Messages API 直接转发接口

## 测试方法

运行测试脚本验证功能：

```bash
node tests/test-403-logger.js
```

测试脚本会生成三个模拟的 403 错误日志，验证不同格式的请求日志记录是否正常。

## 技术实现

### 核心模块

- **日志记录器**: `utils/error-403-logger.js`
- **路由集成**: `routes.js` 中的三个处理函数

### 关键特性

1. **智能提示词提取**
   - 自动识别 OpenAI 和 Anthropic 两种格式
   - 从不同字段提取系统提示词和用户提示词

2. **格式化输出**
   - 使用框线和标题分隔不同部分
   - JSON 内容自动美化（2空格缩进）
   - 长文本自动截断预览

3. **安全脱敏**
   - Authorization 头中的密钥自动脱敏
   - 只显示前10个字符，其余用 `...` 代替

4. **双重输出**
   - 写入日志文件：`logs/403_errors.log`
   - 输出到控制台：方便实时查看

## 常见 403 错误原因

1. **权限不足**
   - API 密钥没有访问指定模型的权限
   - 组织账户未开通某个模型

2. **认证失败**
   - API 密钥无效或已过期
   - API 密钥被禁用

3. **配额限制**
   - 超出使用配额
   - 账户被冻结

## 排查建议

查看 403 日志后，可以从以下方面排查：

1. **检查密钥状态**
   - 在管理面板查看该密钥的状态
   - 确认密钥是否被自动封禁

2. **验证模型权限**
   - 确认该密钥所属组织是否有权限访问该模型
   - 检查是否需要升级账户

3. **查看请求内容**
   - 检查系统提示词和用户提示词是否包含敏感内容
   - 确认参数配置是否符合上游API要求

4. **联系上游支持**
   - 如果无法自行解决，将日志发送给上游API支持团队

## 日志维护

403 错误日志会持续追加到同一个文件中。建议定期：

1. **备份日志**
   ```bash
   cp logs/403_errors.log logs/403_errors_backup_$(date +%Y%m%d).log
   ```

2. **清理日志**
   ```bash
   # 清空日志（谨慎操作）
   > logs/403_errors.log
   ```

3. **日志归档**
   - 可以设置 logrotate 或类似工具自动归档
   - 建议保留最近 30 天的日志

## 相关配置

### 默认配置

无需额外配置，403 错误日志功能开箱即用。

日志目录会在首次记录错误时自动创建。

### 可选环境变量

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `LOG_403_MASK_KEYS` | `true` | 是否脱敏显示密钥ID。设为 `false` 则完全隐藏密钥ID |

**示例：完全隐藏密钥ID**
```bash
export LOG_403_MASK_KEYS=false
npm start
```
