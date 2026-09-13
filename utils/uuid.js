/**
 * BaSui: Shared UUID generator; stop duplicating it everywhere!
 * Follow DRY - Don't Repeat Yourself.
 */

/**
 * Generate a random ID in UUID v4 format.
 * @returns {string} UUID string
 */
export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
