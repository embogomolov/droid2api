/**
 * 类型检查工具
 * 防止空指针和类型错误
 */

/**
 * 安全获取对象属性
 * @param {object} obj - 对象
 * @param {string} path - 属性路径，如 'a.b.c'
 * @param {*} defaultValue - 默认值
 */
export function safeGet(obj, path, defaultValue = undefined) {
  if (!obj) return defaultValue;
  
  const keys = path.split('.');
  let result = obj;
  
  for (const key of keys) {
    if (result === null || result === undefined) {
      return defaultValue;
    }
    result = result[key];
  }
  
  return result !== undefined ? result : defaultValue;
}

/**
 * 检查是否为空
 * @param {*} value - 要检查的值
 */
export function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * 确保是数组
 * @param {*} value - 要检查的值
 * @param {array} defaultValue - 默认值
 */
export function ensureArray(value, defaultValue = []) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return defaultValue;
  return [value];
}

/**
 * 安全的JSON解析
 * @param {string} str - JSON字符串
 * @param {*} defaultValue - 解析失败的默认值
 */
export function safeJsonParse(str, defaultValue = null) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return defaultValue;
  }
}

/**
 * 安全的JSON字符串化
 * @param {*} obj - 要字符串化的对象
 * @param {string} defaultValue - 失败的默认值
 */
export function safeJsonStringify(obj, defaultValue = '{}') {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return defaultValue;
  }
}

export default {
  safeGet,
  isEmpty,
  ensureArray,
  safeJsonParse,
  safeJsonStringify
};
