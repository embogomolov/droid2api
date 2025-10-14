/**
 * BaSui：公共UUID生成器，别tm到处重复写了！
 * 遵循DRY原则 - Don't Repeat Yourself
 */

/**
 * 生成符合UUID v4格式的随机ID
 * @returns {string} UUID字符串
 */
export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
