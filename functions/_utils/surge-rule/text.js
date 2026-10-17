/**
 * 规则文本的底层切分：引号感知的逗号切分、引号剥离、注释扫描、值序列化。
 */

/**
 * 按分隔符切分并跳过引号内的分隔符：URL-REGEX 的值常含逗号，
 * 官方允许用引号包裹。只处理成对的双 / 单引号。
 */
export function splitRespectingQuotes(text, separator = ',') {
  const parts = [];
  let current = '';
  let quote = '';

  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

/** 去掉包裹字符串的首尾成对引号 */
export function stripQuotes(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && ((text[0] === '"' && text.endsWith('"')) || (text[0] === "'" && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

/** 找出注释起始位置，跳过引号内的 //、#、;；无注释返回 -1 */
export function scanCommentStart(text) {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') return i;
    if (char === '#' || char === ';') return i;
  }
  return -1;
}

/**
 * 值序列化：内含逗号必须用引号包裹，否则无法被再次按逗号切分；
 * URL-REGEX 强制加引号——正则里的逗号与规则分隔逗号无法区分。
 */
export function formatValue(typeName, value) {
  const text = String(value ?? '');
  return typeName === 'URL-REGEX' || text.includes(',') ? `"${text}"` : text;
}
