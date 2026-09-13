/**
 * Type checking helpers
 * Prevent null access and type errors.
 */

/**
 * Safely retrieve an object property.
 * @param {object} obj - Object
 * @param {string} path - Property path, such as 'a.b.c'
 * @param {*} defaultValue - Default value
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
 * Check whether a value is empty.
 * @param {*} value - Value to check
 */
export function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Ensure the value is an array.
 * @param {*} value - Value to check
 * @param {array} defaultValue - Default value
 */
export function ensureArray(value, defaultValue = []) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return defaultValue;
  return [value];
}

/**
 * Parse JSON with a fallback on failure.
 * @param {string} str - JSON string
 * @param {*} defaultValue - Fallback value if parsing fails
 */
export function safeJsonParse(str, defaultValue = null) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return defaultValue;
  }
}

/**
 * Serialize to JSON with a fallback on failure.
 * @param {*} obj - Object to serialize
 * @param {string} defaultValue - Fallback value on failure
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
