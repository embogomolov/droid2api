# 密钥池筛选功能实现说明

## 功能概述

密钥池筛选功能允许用户在"密钥管理"页面通过下拉框筛选特定密钥池的密钥，支持查看不同池子的密钥列表。

## 实现细节

### 1. 前端实现

#### 文件位置
- **HTML**: `public/index.html` (第318行)
- **JavaScript**: `public/pool-selection-ui.js` (第64-88行)
- **事件处理**: `public/app.js` (第427行 `filterChanged()` 函数)

#### 组件结构

```html
<select id="poolGroupFilter" onchange="filterChanged()" class="filter-select">
    <option value="all">全部池子</option>
    <!-- 动态加载池子选项 -->
</select>
```

#### 初始化流程

1. **页面加载时**：`pool-selection-ui.js` 的 `initializeAllPoolSelects()` 函数被调用
2. **加载池子选项**：通过 `GET /admin/pool-groups` API 获取所有密钥池
3. **填充下拉框**：
   - 先添加"全部池子" (value="all") 选项
   - 然后添加所有具体的池子选项
   - 格式：`池子名称 (池子ID)`

#### 筛选逻辑

```javascript
function filterChanged() {
    currentStatus = document.getElementById('statusFilter').value;
    currentPoolGroup = document.getElementById('poolGroupFilter').value;  // 获取选中的池子
    currentPage = 1;  // 重置到第一页
    debouncedFetchKeys();  // 重新请求密钥列表
}
```

### 2. 后端实现

#### 文件位置
- **路由**: `api/admin-routes.js` (第61-100行)
- **筛选逻辑**: `auth.js` (第775-803行)

#### API 端点

```javascript
GET /admin/keys
Query参数:
  - page: 页码 (默认1)
  - limit: 每页数量 (默认10)
  - status: 状态筛选 (all | active | disabled | banned, 默认all)
  - poolGroup: 密钥池筛选 (all | default | 自定义池名, 默认all)
  - includeTokenUsage: 是否包含Token使用量信息 (true/false, 默认false)
```

#### 筛选实现

```javascript
getKeys(page = 1, limit = 10, status = 'all', poolGroup = 'all') {
    let filteredKeys = this.keys;

    // 按状态筛选
    if (status !== 'all') {
        filteredKeys = filteredKeys.filter(k => k.status === status);
    }

    // 按密钥池筛选
    if (poolGroup !== 'all') {
        filteredKeys = filteredKeys.filter(k => (k.poolGroup || 'default') === poolGroup);
    }

    // 分页逻辑
    const total = filteredKeys.length;
    const totalPages = Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const end = start + limit;
    const paginatedKeys = filteredKeys.slice(start, end);

    return {
        keys: paginatedKeys,
        pagination: { page, limit, total, total_pages: totalPages }
    };
}
```

## 测试验证

### 测试脚本
运行 `tests/test-pool-filter.js` 验证功能：

```bash
node tests/test-pool-filter.js
```

### 测试结果
```
🧪 开始测试密钥池筛选功能...

1️⃣ 获取池子列表...
✅ 找到 3 个密钥池:
   - 白嫖池 (freebies): 50 个密钥
   - 主力池 (main): 19 个密钥
   - 测试池 (test): 10 个密钥

2️⃣ 测试获取所有密钥（poolGroup=all）...
✅ 获取到 79 个密钥（不筛选）

3️⃣ 测试筛选池子: 白嫖池 (freebies)...
✅ 筛选正确: 50 个密钥都属于池子 freebies

3️⃣ 测试筛选池子: 主力池 (main)...
✅ 筛选正确: 19 个密钥都属于池子 main

3️⃣ 测试筛选池子: 测试池 (test)...
✅ 筛选正确: 10 个密钥都属于池子 test

4️⃣ 测试筛选默认池（poolGroup=default）...
✅ 筛选正确: 0 个密钥都属于默认池

🎉 所有测试通过！密钥池筛选功能正常工作！
```

## 使用方法

### 用户操作流程

1. **登录管理面板**
   - 访问 `http://localhost:3000`
   - 输入管理员密钥登录

2. **进入密钥管理页面**
   - 点击顶部导航栏的"🔑 密钥管理"标签

3. **使用密钥池筛选器**
   - 在"状态筛选"旁边找到"🎯 密钥池筛选"下拉框
   - 选择要查看的密钥池：
     - **全部池子**: 显示所有密钥（不筛选）
     - **白嫖池 (freebies)**: 只显示白嫖池的密钥
     - **主力池 (main)**: 只显示主力池的密钥
     - **测试池 (test)**: 只显示测试池的密钥
     - **...其他自定义池子**

4. **自动刷新列表**
   - 选择池子后，页面会自动重新加载密钥列表
   - 页码会自动重置为第1页
   - 分页和状态筛选器继续有效

### 组合筛选

可以同时使用多个筛选器：

- **密钥池 + 状态**：例如查看"主力池"中"已封禁"的密钥
- **密钥池 + 分页**：例如查看"白嫖池"的第2页密钥
- **密钥池 + 每页显示数量**：例如一次显示"测试池"的50个密钥

### 筛选后的操作

筛选后的密钥列表支持所有常规操作：

- ✅ 查看密钥详情
- 🧪 测试密钥有效性
- ✏️ 编辑密钥（修改备注、池子等）
- 🔄 启用/禁用/解封密钥
- 🗑️ 删除密钥
- 📥 批量导入（新密钥会加到选中的池子）
- 📤 批量导出（导出选中池子的密钥）

## 技术亮点

### 1. 性能优化

- **防抖处理**: 使用 `debouncedFetchKeys()` 避免频繁请求
- **分页支持**: 后端自动分页，前端只加载当前页数据
- **缓存策略**: 池子列表只在初始化时加载一次

### 2. 用户体验

- **自动重置页码**: 切换筛选条件时自动回到第1页
- **实时更新**: 筛选器变化立即生效
- **状态保持**: 筛选条件在页面刷新后保持（如果使用localStorage）

### 3. 扩展性

- **支持任意池子**: 无论有多少个池子，筛选器都能正确加载
- **兼容性**: 兼容旧版本数据（无 `poolGroup` 字段的密钥默认为 `default`）
- **灵活配置**: 可轻松添加新的筛选维度

## 故障排查

### 问题1: 下拉框没有显示池子选项

**原因**: 池子选项加载失败

**解决方案**:
1. 检查浏览器控制台是否有错误
2. 确认 `/admin/pool-groups` API 是否正常工作
3. 验证管理员密钥是否有效
4. 检查 `pool-selection-ui.js` 是否正确加载

### 问题2: 筛选后列表为空

**原因**: 选中的池子可能没有密钥

**解决方案**:
1. 在"仪表盘"页面查看"多级密钥池"统计
2. 确认选中的池子是否有密钥
3. 尝试选择"全部池子"查看所有密钥
4. 检查 `poolGroup` 参数是否正确传递

### 问题3: 筛选不生效

**原因**: 前端或后端筛选逻辑问题

**解决方案**:
1. 运行测试脚本: `node tests/test-pool-filter.js`
2. 检查浏览器网络请求，确认 `poolGroup` 参数是否正确
3. 查看服务器日志，确认后端是否收到筛选参数
4. 检查 `filterChanged()` 函数是否被正确调用

## 相关文档

- [多级密钥池文档](MULTI_TIER_POOL.md)
- [密钥管理API文档](ARCHITECTURE.md#管理后台-api)
- [前端UI组件文档](../public/README.md)

## 更新日志

### 2025-01-XX (当前版本)
- ✅ 修复池子筛选器初始化逻辑
- ✅ 添加"全部池子"选项到筛选器
- ✅ 创建池子筛选功能测试脚本
- ✅ 验证前后端筛选功能正常工作

---

**作者**: BaSui  
**最后更新**: 2025-01-XX  
**状态**: ✅ 已完成并测试通过
