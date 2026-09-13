# Data directory

This directory stores runtime configuration and data files.

## 📁 Files

### Configuration files

- **config.json** - Main system configuration
  - Port, models, key selection algorithm, and other system settings
  - ⚠️ Local file; not intended for upload to the repository
  - Before first use, copy `config.json.example` to `config.json`

- **key_pool.json** - Key pool data
  - All keys, pool groups, and statistics
  - ⚠️ Contains sensitive information; excluded from the repository
  - Before first use, copy `key_pool.json.example` to `key_pool.json`

- **token_usage.json** - Token usage cache
  - Key balances, usage, and related information
  - ⚠️ Generated automatically; excluded from the repository

- **request_stats.json** - Request statistics
  - Request success rates, latency, and related statistics
  - ⚠️ Generated automatically; excluded from the repository

- **auth.json** - OAuth credentials
  - Factory API authentication tokens
  - ⚠️ Highly sensitive; excluded from the repository

### Examples and templates

- **config.json.example** - Configuration template
  - Default settings, ready to copy and use
  - ✅ Included in the repository for reference

- **key_pool.json.example** - Key pool template
  - Empty key pool structure with a default pool configured
  - ✅ Included in the repository for reference

## 🚀 Initial setup

Before first use, initialize the project as follows:

```bash
# 1. Enter the data directory
cd data

# 2. Copy the configuration template if config.json does not exist
cp config.json.example config.json

# 3. Copy the key pool template if key_pool.json does not exist
cp key_pool.json.example key_pool.json

# 4. Return to the project root
cd ..

# 5. Configure environment variables by creating .env
# See .env.example
```

## ⚙️ Default settings

### Multi-tier key pools

Multi-tier key pools are enabled by default:

```json
{
  "key_pool": {
    "multiTier": {
      "enabled": true,         // Enable multi-tier key pools
      "autoFallback": true     // Enable automatic fallback
    }
  }
}
```

**Settings**:
- **enabled**: use keys from different pools in priority order
- **autoFallback**: switch to a lower-priority pool when the higher-priority pool has no usable keys left

### Pool groups

One pool is included by default:

```json
{
  "poolGroups": [
    {
      "id": "default",
      "name": "Default pool",
      "priority": 100,
      "description": "Default key pool"
    }
  ]
}
```

Add more pools through the admin interface, for example:
- Free pool (priority 1) - Use free keys first
- Primary pool (priority 50) - Paid keys
- Backup pool (priority 100) - Used last

## 🔒 Security

**Important**: the following files contain sensitive information and must not be uploaded to public repositories:
- ❌ config.json (your configuration)
- ❌ key_pool.json (actual keys)
- ❌ token_usage.json (usage information)
- ❌ request_stats.json (statistics)
- ❌ auth.json (authentication tokens)

These files are intended to be excluded through `.gitignore` so Git ignores them automatically.

## 📖 Related documentation

- [CLAUDE.md](../CLAUDE.md) - Complete project documentation
- [MULTI_TIER_POOL.md](../docs/MULTI_TIER_POOL.md) - Detailed multi-tier key pool documentation
- [README.md](../README.md) - Project overview
