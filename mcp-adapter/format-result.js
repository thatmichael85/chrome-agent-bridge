// Shapes a relay command result into MCP content, guarding the consuming
// agent's context window: screenshots become real image blocks (charged as
// an image, not as base64 text), and every text result is capped so one
// unselective get_html/get_text/evaluate can't dump an entire page into
// the conversation.

const DEFAULT_MAX_CHARS = 20000;

const DATA_URL_RE = /^data:(image\/[a-z+.-]+);base64,(.*)$/s;

function formatResult(command, result, maxChars = DEFAULT_MAX_CHARS) {
  if (command === 'screenshot' && result && typeof result.dataUrl === 'string') {
    const match = result.dataUrl.match(DATA_URL_RE);
    if (match) {
      return [{ type: 'image', data: match[2], mimeType: match[1] }];
    }
  }

  const text = JSON.stringify(result) ?? 'undefined';
  if (text.length <= maxChars) {
    return [{ type: 'text', text }];
  }
  const omitted = text.length - maxChars;
  return [{
    type: 'text',
    text: `${text.slice(0, maxChars)}\n…[truncated ${omitted} of ${text.length} chars — narrow with a selector, or have evaluate return only the fields you need]`,
  }];
}

module.exports = { formatResult, DEFAULT_MAX_CHARS };
