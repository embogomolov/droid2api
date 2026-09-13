import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { compressDroidImage, prepareFactoryRequest, prepareAnthropicImages } from '../utils/factory-images.js';

const png = new PNG({ width: 2048, height: 4 });
for (let i = 0; i < png.data.length; i += 4) {
  const x = i / 4 % png.width;
  png.data[i] = x % 256; png.data[i + 1] = 30; png.data[i + 2] = 70; png.data[i + 3] = x % 2 ? 255 : 0;
}
const input = PNG.sync.write(png);
const compressed = compressDroidImage(input, 'image/png');
assert.equal(compressed.width, 1024); assert.equal(compressed.height, 2);
assert.ok(compressed.buffer.length <= 204800);
const decoded = PNG.sync.read(compressed.buffer);
assert.deepEqual([...decoded.data.subarray(0, 4)], [1, 30, 70, 128], 'alpha-weighted area resize');
const jpegInput = Buffer.from(jpeg.encode(png, 95).data);
const result = compressDroidImage(jpegInput, 'image/jpeg');
assert.equal(result.contentType, 'image/jpeg'); assert.ok(result.buffer.length <= 204800);
assert.equal(jpeg.decode(result.buffer).width, 1024);
const original = { input: [{ role: 'user', content: [{ type: 'input_text', text: 'Keep all instructions.' },
  { type: 'input_image', image_url: 'data:image/png;base64,' + input.toString('base64'), detail: 'high' }] }] };
const saved = JSON.stringify(original), prepared = prepareFactoryRequest(original, 'task');
assert.equal(JSON.stringify(original), saved, 'no mutation of caller history');
assert.equal(prepared.body.input[0].content[0].text, 'Keep all instructions.');
assert.equal(prepared.body.input[0].content[1].detail, 'auto');
assert.equal(prepared.body.prompt_cache_retention, '24h');
assert.deepEqual(prepareFactoryRequest(original, 'task'), prepared, 'stable cached preparation');
assert.throws(() => compressDroidImage(Buffer.from('broken'), 'image/png'));
const attachment = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: input.toString('base64') }, cache_control: { type: 'ephemeral' } };
const anthropic = { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_image', content: [attachment] }] }] };
const originalAnthropic = JSON.stringify(anthropic), transformed = prepareAnthropicImages(anthropic);
assert.equal(JSON.stringify(anthropic), originalAnthropic);
const image = transformed.body.messages[0].content[0].content[0];
assert.deepEqual(image.cache_control, attachment.cache_control);
assert.equal(transformed.images.count, 1);
assert.equal(PNG.sync.read(Buffer.from(image.source.data, 'base64')).width, 1024);
assert.deepEqual(prepareAnthropicImages(anthropic), transformed);
console.log('PASS: native image sizing, alpha-weighted pixels, PNG/JPEG, stable cache, intact caller history and cache parameters');
