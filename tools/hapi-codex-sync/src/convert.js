function timestampMs(event) {
  const parsed = Date.parse(event.timestamp || '');
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function textFromContent(content, inputType, outputType) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === inputType || part.type === outputType || part.type === 'text') {
        return typeof part.text === 'string' ? part.text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseArgs(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20_000;
const PREVIEW_HEAD_CHARS = 6_000;
const PREVIEW_TAIL_CHARS = 2_000;

function stringifyOutput(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewText(text, maxChars) {
  const budget = Math.max(200, maxChars);
  if (text.length <= budget) return text;

  const head = Math.min(PREVIEW_HEAD_CHARS, Math.floor(budget * 0.7));
  const tail = Math.min(PREVIEW_TAIL_CHARS, Math.max(0, budget - head - 160));
  const omitted = Math.max(0, text.length - head - tail);
  return [
    text.slice(0, head),
    `\n\n[HAPI truncated ${omitted} chars from this tool output. Full output remains in the Codex rollout/tool history.]\n\n`,
    tail > 0 ? text.slice(-tail) : ''
  ].join('');
}

function compactToolOutputForHapi(output, options = {}) {
  const maxChars = Number.isInteger(options.maxToolOutputChars) && options.maxToolOutputChars > 0
    ? options.maxToolOutputChars
    : DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const serialized = stringifyOutput(output);
  if (serialized.length <= maxChars) return output;

  return {
    type: 'hapi-tool-output-summary',
    truncated: true,
    callId: options.callId || undefined,
    toolName: options.toolName || undefined,
    originalChars: serialized.length,
    preview: previewText(serialized, maxChars),
    fullOutputRetainedBy: 'codex-rollout',
    note: 'HAPI summarized this oversized tool result to keep the chat bridge responsive; the Codex thread still retains its native tool history.'
  };
}

function hapiUser(text, createdAt) {
  if (!text) return null;
  return { role: 'user', content: { type: 'text', text }, createdAt };
}

function hapiAgent(data, createdAt) {
  return { role: 'agent', content: { type: 'codex', data }, createdAt };
}

function hapiEvent(data, createdAt) {
  return { role: 'agent', content: { type: 'event', data }, createdAt };
}

function convertCodexEvent(event, options = {}) {
  if (!event || typeof event !== 'object') return null;
  const createdAt = timestampMs(event);
  const payload = event.payload || {};

  if (event.type === 'response_item') {
    if (payload.type === 'message') {
      if (payload.role === 'user') {
        return hapiUser(textFromContent(payload.content, 'input_text', 'output_text'), createdAt);
      }
      if (payload.role === 'assistant') {
        const message = textFromContent(payload.content, 'input_text', 'output_text');
        if (!message) return null;
        return hapiAgent({ type: 'message', message, phase: payload.phase }, createdAt);
      }
    }
    if (payload.type === 'function_call') {
      return hapiAgent({
        type: 'tool-call',
        name: payload.name,
        callId: payload.call_id || payload.callId,
        input: parseArgs(payload.arguments)
      }, createdAt);
    }
    if (payload.type === 'function_call_output') {
      const callId = payload.call_id || payload.callId;
      return hapiAgent({
        type: 'tool-call-result',
        callId,
        output: compactToolOutputForHapi(payload.output, {
          ...options,
          callId
        })
      }, createdAt);
    }
    return null;
  }

  if (event.type === 'event_msg') {
    if (payload.type === 'user_message') {
      return hapiUser(payload.message || '', createdAt);
    }
    if (payload.type === 'agent_message') {
      return hapiAgent({ type: 'message', message: payload.message || '', phase: payload.phase }, createdAt);
    }
    if (payload.type === 'task_complete') {
      return hapiEvent({ type: 'ready' }, createdAt);
    }
    if (payload.type === 'context_compacted') {
      const data = { type: 'context_compacted' };
      for (const [key, value] of Object.entries(payload)) {
        if (key !== 'type') data[key] = value;
      }
      return hapiAgent(data, createdAt);
    }
    if (payload.type === 'exec_command_begin') {
      return hapiAgent({ type: 'tool-call', name: 'CodexBash', callId: payload.call_id, input: { command: payload.command, cwd: payload.cwd } }, createdAt);
    }
    if (payload.type === 'exec_command_end') {
      return hapiAgent({
        type: 'tool-call-result',
        callId: payload.call_id,
        output: compactToolOutputForHapi(payload, {
          ...options,
          callId: payload.call_id,
          toolName: 'CodexBash'
        })
      }, createdAt);
    }
    return null;
  }

  return null;
}

module.exports = { convertCodexEvent };
