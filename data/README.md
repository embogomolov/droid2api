# Data 目录说明

此目录用于存储项目运行时的配置和数据文件。

## 📁 文件说明

### 配置文件

- **config.json** - 系统主配置文件
  - 端口、模型、轮询算法等系统配置
  - ⚠️ 本地文件，不会上传到仓库
  - 首次使用请复制 `config.json.example` 并重命名为 `config.json`

- **key_pool.json** - 密钥池数据文件
  - 存储所有密钥、密钥池组、统计信息
  - ⚠️ 包含敏感信息，不会上传到仓库
  - 首次使用请复制 `key_pool.json.example` 并重命名为 `key_pool.json`

- **token_usage.json** - Token 使用量缓存
  - 存储密钥余额、使用量等信息
  - ⚠️ 自动生成，不会上传到仓库

- **request_stats.json** - 请求统计数据
  - 存储请求成功率、延迟等统计信息
  - ⚠️ 自动生成，不会上传到仓库

- **auth.json** - OAuth 认证信息
  - 存储 Factory API 的认证 Token
  - ⚠️ 高度敏感，不会上传到仓库

### 示例/模板文件

- **config.json.example** - 配置文件模板
  - 包含默认配置，可以直接复制使用
  - ✅ 会上传到仓库供参考

- **key_pool.json.example** - 密钥池文件模板
  - 空的密钥池结构，包含默认池子配置
  - ✅ 会上传到仓库供参考

## 🚀 初始化步骤

首次使用项目时，请按以下步骤初始化：

```bash
# 1. 进入 data 目录
cd data

# 2. 复制配置模板（如果 config.json 不存在）
cp config.json.example config.json

# 3. 复制密钥池模板（如果 key_pool.json 不存在）
cp key_pool.json.example key_pool.json

# 4. 返回项目根目录
cd ..

# 5. 配置环境变量（创建 .env 文件）
# 参考 .env.example
```

## ⚙️ 默认配置说明

### 多级密钥池配置

默认启用多级密钥池功能：

```json
{
  "key_pool": {
    "multiTier": {
      "enabled": true,         // 启用多级密钥池
      "autoFallback": true     // 启用自动降级
    }
  }
}
```

**功能说明**：
- **enabled**: 启用后，系统会按优先级使用不同池子的密钥
- **autoFallback**: 高优先级池子密钥用完后，自动切换到低优先级池子

### 密钥池组配置

默认包含一个池子：

```json
{
  "poolGroups": [
    {
      "id": "default",
      "name": "默认池",
      "priority": 100,
      "description": "默认密钥池"
    }
  ]
}
```

你可以通过管理面板添加更多池子，例如：
- 白嫖池（优先级 1）- 先用免费密钥
- 主力池（优先级 50）- 付费密钥
- 备用池（优先级 100）- 最后使用

## 🔒 安全提示

**重要**：以下文件包含敏感信息，请勿上传到公开仓库：
- ❌ config.json（包含你的配置）
- ❌ key_pool.json（包含真实密钥）
- ❌ token_usage.json（包含使用量信息）
- ❌ request_stats.json（包含统计数据）
- ❌ auth.json（包含认证Token）

这些文件已在 `.gitignore` 中配置，Git 会自动忽略它们。

## 📖 相关文档

- [CLAUDE.md](../CLAUDE.md) - 项目完整文档
- [MULTI_TIER_POOL.md](../docs/MULTI_TIER_POOL.md) - 多级密钥池详细说明
- [README.md](../README.md) - 项目说明
