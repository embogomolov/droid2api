import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

// Droid CLI 0.213.0: ZY/qWn/YWn, default attachment preparation.
const MAX_BYTES = 204800, MAX_DIMENSION = 1024;
const cache = new Map();
let cacheBytes = 0;

function resize(image, limit) {
  const { width, height, data } = image;
  const scale = limit / Math.max(width, height);
  if (scale >= 1) return image;
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const top = Math.min(height - 1, Math.floor(y * height / h));
    const bottom = Math.max(top + 1, Math.min(height, Math.floor((y + 1) * height / h)));
    for (let x = 0; x < w; x++) {
      const left = Math.min(width - 1, Math.floor(x * width / w));
      const right = Math.max(left + 1, Math.min(width, Math.floor((x + 1) * width / w)));
      let red = 0, green = 0, blue = 0, alpha = 0, count = 0;
      for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
        const i = (row * width + col) * 4, a = data[i + 3];
        red += data[i] * a; green += data[i + 1] * a; blue += data[i + 2] * a; alpha += a; count++;
      }
      const i = (y * w + x) * 4;
      if (alpha) {
        pixels[i] = Math.round(red / alpha); pixels[i + 1] = Math.round(green / alpha);
        pixels[i + 2] = Math.round(blue / alpha); pixels[i + 3] = Math.round(alpha / count);
      }
    }
  }
  return { data: pixels, width: w, height: h };
}

export function compressDroidImage(buffer, mime, { maxSizeBytes = MAX_BYTES, maxDimensionPx = MAX_DIMENSION } = {}) {
  mime = mime.toLowerCase().replace('image/jpg', 'image/jpeg');
  let image;
  if (mime === 'image/png') {
    // Bound decompression, matching jpeg-js's default 100-megapixel ceiling.
    if (buffer.length < 24 || buffer.readUInt32BE(16) * buffer.readUInt32BE(20) > 100_000_000) throw new Error('Invalid or oversized PNG dimensions');
    image = PNG.sync.read(buffer);
  } else if (mime === 'image/jpeg') image = jpeg.decode(buffer, { useTArray: true });
  else throw new Error('Droid image preparation supports PNG and JPEG only');
  image = resize(image, maxDimensionPx);
  const encodeJPEG = quality => Buffer.from(jpeg.encode(image, quality).data);
  let output;
  if (mime === 'image/png') {
    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.data); output = PNG.sync.write(png);
  } else output = encodeJPEG(100);
  if (output.length <= maxSizeBytes) return { buffer: output, contentType: mime, width: image.width, height: image.height };
  let quality = 100;
  output = encodeJPEG(quality);
  for (let attempt = 0; output.length > maxSizeBytes && quality > 20 && attempt < 8; attempt++) {
    const nextQuality = Math.max(20, Math.floor(quality * 0.8));
    if (nextQuality >= quality) break;
    quality = nextQuality;
    const next = encodeJPEG(quality);
    if (next.length >= output.length) break;
    output = next;
  }
  if (output.length > maxSizeBytes) throw new Error('Unable to compress image below Droid provider size limit');
  return { buffer: output, contentType: 'image/jpeg', width: image.width, height: image.height };
}

export function prepareFactoryImages(body) {
  let imageCount = 0, originalBytes = 0, preparedBytes = 0;
  const prepare = content => {
    if (content?.type !== 'input_image' || typeof content.image_url !== 'string' || !content.image_url.startsWith('data:')) return content;
    const match = /^data:(image\/(?:png|jpeg|jpg));base64,([\s\S]+)$/i.exec(content.image_url);
    if (!match) throw new Error('Droid image preparation requires a PNG/JPEG base64 data URL');
    const id = createHash('sha256').update(content.image_url).digest('hex');
    let prepared = cache.get(id);
    if (prepared) { cache.delete(id); cache.set(id, prepared); }
    else {
      const input = Buffer.from(match[2], 'base64');
      const result = compressDroidImage(input, match[1]);
      prepared = { url: `data:${result.contentType};base64,${result.buffer.toString('base64')}`, originalBytes: input.length, bytes: result.buffer.length };
      cache.set(id, prepared); cacheBytes += prepared.url.length;
      // Cache only prepared bytes and a digest, never all original image data.
      while (cacheBytes > 32 * 1024 * 1024) { const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).url.length; cache.delete(oldest); }
    }
    imageCount++; originalBytes += prepared.originalBytes; preparedBytes += prepared.bytes;
    return { ...content, image_url: prepared.url, detail: 'auto' };
  };
  const input = Array.isArray(body.input) ? body.input.map(item => {
    let result = item;
    for (const field of ['content', 'output']) if (Array.isArray(item[field])) result = { ...result, [field]: item[field].map(prepare) };
    return result;
  }) : body.input;
  return { body: { ...body, input }, images: { count: imageCount, originalBytes, preparedBytes } };
}

export function prepareFactoryRequest(body, sessionId) {
  const prepared = prepareFactoryImages(body);
  const request = prepared.body;
  request.prompt_cache_key ||= sessionId;
  if (request.prompt_cache_key) request.prompt_cache_retention ??= '24h';
  request.parallel_tool_calls ??= true;
  request.tool_choice ??= 'auto';
  request.safety_identifier ??= sessionId;
  request.text = { verbosity: 'low', ...request.text };
  if (request.reasoning?.effort && !['none', 'dynamic'].includes(request.reasoning.effort)) {
    request.reasoning = { summary: 'auto', ...request.reasoning };
    request.include = [...new Set([...(request.include || []), 'reasoning.encrypted_content'])];
  }
  return prepared;
}

export function prepareAnthropicImages(body) {
  const images = { count: 0, originalBytes: 0, preparedBytes: 0 };
  const prepare = block => {
    if (block?.type === 'image' && block.source?.type === 'base64' && /^image\/(png|jpeg|jpg)$/i.test(block.source.media_type)) {
      const prepared = prepareFactoryImages({ input: [{ content: [{ type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}` }] }] });
      for (const field of Object.keys(images)) images[field] += prepared.images[field];
      const url = prepared.body.input[0].content[0].image_url;
      const comma = url.indexOf(',');
      return { ...block, source: { ...block.source, media_type: url.slice(5, url.indexOf(';')), data: url.slice(comma + 1) } };
    }
    if (block?.type === 'tool_result' && Array.isArray(block.content)) return { ...block, content: block.content.map(prepare) };
    return block;
  };
  return { body: { ...body, messages: body.messages?.map(message => Array.isArray(message.content) ? { ...message, content: message.content.map(prepare) } : message) }, images };
}
