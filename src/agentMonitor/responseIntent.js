'use strict';

const USER_INPUT_TOOL_PATTERN = /^(?:request_user_input|ask_user_question|askuserquestion|request_input|get_user_input)$/i;
const STRUCTURED_REQUEST_MAX_CHARS = 420;
const STRUCTURED_REQUEST_MAX_BYTES = 32_000;
const STRUCTURED_REQUEST_MAX_ITEMS = 8;

function isUserInputTool(name) {
  return USER_INPUT_TOOL_PATTERN.test(String(name || '').trim());
}

function safeField(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  try {
    return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function normalizedStructuredText(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function structuredInputValue(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return '';
  if (!/^[{[]/.test(text)) return text;
  if (text.length > STRUCTURED_REQUEST_MAX_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Extracts only provider-owned user-input fields. This intentionally ignores
 * option descriptions and arbitrary object keys so a notification cannot leak
 * the rest of a tool payload.
 */
function structuredInputRequestText(value, maxChars = STRUCTURED_REQUEST_MAX_CHARS) {
  const limit = Math.max(1, Math.min(Number(maxChars) || STRUCTURED_REQUEST_MAX_CHARS, STRUCTURED_REQUEST_MAX_CHARS));
  const root = structuredInputValue(value);
  const parts = [];
  const seenParts = new Set();
  const seenObjects = new Set();

  const add = (candidate) => {
    const text = normalizedStructuredText(candidate);
    if (!text || seenParts.has(text)) return false;
    seenParts.add(text);
    parts.push(text);
    return true;
  };

  const extractPreferred = (candidate, depth = 0) => {
    if (depth > 4 || candidate == null) return false;
    if (typeof candidate !== 'object') return add(candidate);
    if (seenObjects.has(candidate)) return false;
    seenObjects.add(candidate);
    for (const key of ['question', 'prompt', 'message', 'header']) {
      const field = safeField(candidate, key);
      if (field == null) continue;
      if (extractPreferred(field, depth + 1)) return true;
    }
    return false;
  };

  const extractQuestions = (candidate, depth = 0) => {
    if (depth > 4 || candidate == null) return;
    if (!Array.isArray(candidate)) {
      extractPreferred(candidate, depth);
      return;
    }
    for (const item of candidate.slice(0, STRUCTURED_REQUEST_MAX_ITEMS)) {
      extractPreferred(item, depth + 1);
    }
  };

  if (Array.isArray(root)) {
    extractQuestions(root);
  } else if (root && typeof root === 'object') {
    const questions = safeField(root, 'questions');
    if (questions != null) extractQuestions(questions);
    if (!parts.length) extractPreferred(root);
  } else {
    add(root);
  }

  return parts.join('\n').slice(0, limit).trim();
}

function conversationalTail(value) {
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\r\n]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/!?(?:\[[^\]]*\])\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(-1600).trim();
}

function requestExcerpt(value) {
  const tail = conversationalTail(value);
  if (!tail) return '';
  const questions = tail.match(/(?:^|[\n.!。！？]\s*)([^\n.!?。！？]{1,420}[?？])/g);
  if (questions && questions.length) {
    return questions.at(-1).replace(/^[\n.!。！？]\s*/, '').trim();
  }
  const paragraphs = tail.split(/\n{2,}/).map(row => row.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return (paragraphs.at(-1) || tail).slice(-420).trim();
}

function optionalFollowup(value, excerpt) {
  const tail = conversationalTail(value);
  const candidate = `${tail.slice(-700)} ${excerpt}`.trim();
  return [
    /(?:필요하시면|원하시면|원한다면|원할\s*경우|원하실\s*경우|원하면|추가로).{0,260}(?:드릴까요|해\s*드릴까요|할까요|해볼까요|원하시나요|알려주세요)[?？.!]?$/i,
    /(?:파일로\s*)?(?:저장|정리|문서화|추가 작성|추가 생성).{0,50}(?:해\s*드릴까요|드릴까요)[?？]$/i,
    /\b(?:if you(?:'d| would)? like|if you want|would you like me to|shall i also|i can also)\b[\s\S]{0,260}[?!.]?$/i,
    /(?:如果需要|如有需要|要不要我|是否需要我)[\s\S]{0,220}[？?。]?$/,
  ].some(pattern => pattern.test(candidate));
}

function assistantResponseIntent(value) {
  const tail = conversationalTail(value);
  const excerpt = requestExcerpt(value);
  if (!tail) return { category: 'none', required: false, optional: false, requestText: '', confidence: 'low' };

  // A question at the end of the final prose is the strongest provider-neutral signal.
  const trailingQuestion = /[?？]\s*(?:["')\]}>*_~]|&gt;)*\s*$/.test(tail);

  const koreanRequest = /(?:선택|골라|알려|말씀|답변|확인|결정|지정|입력|보내|첨부|업로드|제공)(?:해|하여|해서|해\s*)?(?:주세요|주십시오|주실래요|바랍니다)(?:[.!:：]|\s|$)/.test(tail);
  const englishRequest = [
    // A polite request may follow introductory prose, so "please"/"kindly"
    // is a strong signal wherever it appears.
    /\b(?:please|kindly)\s+(?:choose|select|confirm|tell\s+me|let\s+me\s+know|provide|send|share|enter|upload|attach)\b/i,
    // Bare imperatives are requests only at the beginning of prose or a new
    // sentence. This avoids treating technical words such as "resend" or a
    // Korean completion report containing "attach" as user-input requests.
    /(?:^|[\r\n]+|[.!?]\s+)\s*(?:choose|select|confirm|tell\s+me|let\s+me\s+know|provide|send|share|enter|upload|attach)\b/i,
    /(?:^|[\r\n]+|[.!?]\s+)\s*(?:can|could|would|will)\s+you\s+(?:choose|select|confirm|provide|send|share|enter|upload|attach)\b/i,
  ].some(pattern => pattern.test(tail));
  const chineseRequest = /(?:请选择|请确认|请提供|请告诉|请回复|请上传)/.test(tail);
  const directRequest = koreanRequest || englishRequest || chineseRequest;
  if (!trailingQuestion && !directRequest) {
    return { category: 'none', required: false, optional: false, requestText: '', confidence: 'low' };
  }

  // Ignore common courtesy offers that do not block the task.
  if (/(?:궁금한|추가 질문|도움이 필요).{0,30}(?:알려|말씀).{0,12}주세요[.!]?$/i.test(tail)
    || /let me know if (?:you have|there are) (?:any )?(?:questions|issues)[.!]?$/i.test(tail)) {
    return { category: 'none', required: false, optional: false, requestText: '', confidence: 'high' };
  }
  if (optionalFollowup(tail, excerpt)) {
    return { category: 'optional', required: false, optional: true, requestText: excerpt, confidence: 'high' };
  }
  return {
    category: 'required',
    required: true,
    optional: false,
    requestText: excerpt,
    confidence: directRequest ? 'high' : 'medium',
  };
}

function assistantRequestsUserResponse(value) {
  return assistantResponseIntent(value).required;
}

module.exports = {
  assistantRequestsUserResponse,
  assistantResponseIntent,
  conversationalTail,
  isUserInputTool,
  requestExcerpt,
  structuredInputRequestText,
};
