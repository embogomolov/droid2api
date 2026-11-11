const hasRefusalContent = item =>
  item?.type === 'message' && Array.isArray(item.content) &&
  item.content.some(part => part?.type === 'refusal');

const hasRefusalText = value => typeof value === 'string' && value.length > 0;

export function getModelRefusal(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const message = payload.type === 'message_delta' ? payload.delta : payload;
  if (message?.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    return { category: typeof category === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(category) ? category : null };
  }

  switch (payload.type) {
    case 'response.refusal.delta':
    case 'response.refusal.done':
      return { category: null };
    case 'response.content_part.added':
    case 'response.content_part.done':
      return payload.part?.type === 'refusal' ? { category: null } : null;
    case 'response.output_item.added':
    case 'response.output_item.done':
      return hasRefusalContent(payload.item) ? { category: null } : null;
  }

  const response = payload.response ?? payload;
  if (response.incomplete_details?.reason === 'content_filter' ||
      (Array.isArray(response.output) && response.output.some(hasRefusalContent))) {
    return { category: null };
  }

  if (Array.isArray(payload.choices) && payload.choices.some(choice =>
    choice?.finish_reason === 'content_filter' ||
    hasRefusalText(choice?.message?.refusal) ||
    hasRefusalText(choice?.delta?.refusal))) {
    return { category: null };
  }
  return null;
}
