/**
 * 账号密码哈希：PBKDF2-SHA256（Web Crypto，Workers 与 Node ≥ 22 通用）。
 *
 * 存储格式：pbkdf2-sha256$<iterations>$<salt_b64>$<hash_b64>——迭代次数与盐
 * 随哈希一起落库，后续提升迭代次数时旧哈希仍可校验并按需重哈希。
 * Workers 的 CPU 限额内 10 万次 PBKDF2-SHA256 实测毫秒级，安全与配额兼顾。
 */

const PBKDF2_ALGO = 'SHA-256';
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const PREFIX = 'pbkdf2-sha256';

/** 校验密码强度：≥ 6 位即可用（面板自托管场景，复杂度交给用户自己权衡） */
export function validatePasswordStrength(password) {
  const value = String(password ?? '');
  if (value.length < 6) return '密码至少 6 位';
  if (value.length > 128) return '密码最长 128 位';
  return '';
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value ?? ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: PBKDF2_ALGO },
    key,
    HASH_BYTES * 8
  );
}

/** 生成哈希串：随机盐 + PBKDF2，失败抛错由调用方转 500 */
export async function hashPassword(password) {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const bits = await derive(password, salt, PBKDF2_ITERATIONS);
  return `${PREFIX}$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

/**
 * 校验密码：按存储串里的盐与迭代次数重算，逐字符累计差异比较抹平时序侧信道。
 * 格式不认识的哈希一律返回 false（不可能匹配）。
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  let salt;
  let expected;
  try {
    salt = base64ToBytes(parts[2]);
    expected = base64ToBytes(parts[3]);
  } catch {
    return false;
  }
  const bits = await derive(password, salt, iterations);
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
