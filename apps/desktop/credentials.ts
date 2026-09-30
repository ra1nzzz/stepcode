/**
 * 凭据加密（对齐 PRD §5 FR-5 / NFR）
 * ----------------------------------------------------------------------------
 * PRD 要求：API Key **AES-256-GCM 加密存储**，密钥派生自机器指纹。
 * 此前实现用的是 Electron `safeStorage`（依赖 OS 钥匙串）：
 *   - 语义不等价（不是 AES-256-GCM + 机器指纹派生）
 *   - 便携模式下跨机器/跨用户不可移植
 *   - Linux 等平台可能无加密后端，会退化为明文
 *
 * 本模块提供与 PRD 一致的实现：
 *   密文格式： v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *   密钥派生： scrypt(机器指纹, sha256(机器指纹)[0..16], 32) —— 不依赖外部盐文件，
 *             避免盐文件丢失导致凭据不可解
 *
 * 兼容性：历史 safeStorage 密文（无 v1: 前缀）仍走 safeStorage 解密，读取时自动
 * 升级为 v1 格式并回写（无缝迁移，不丢配置）。
 */
import * as crypto from 'node:crypto';
import * as os from 'node:os';

const CIPHER_PREFIX = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;

/** 应用常量 pepper：让派生结果与其他应用的同指纹派生区分开。 */
const PEPPER = 'orchdesk/credentials/v1';

let cachedKey: Buffer | null = null;

/**
 * 机器指纹：主机名 + 平台 + 架构 + CPU 型号 + 内存总量。
 * 不取用户名（避免同一机器多用户切换后凭据失效）。
 */
function machineFingerprint(): string {
  const cpus = os.cpus();
  return [
    PEPPER,
    os.hostname(),
    os.platform(),
    os.arch(),
    cpus.length ? cpus[0]!.model : 'unknown-cpu',
    String(os.totalmem()),
  ].join('|');
}

/** 派生 32 字节密钥（scrypt，确定性）。 */
function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fp = machineFingerprint();
  const salt = crypto.createHash('sha256').update(fp).digest().subarray(0, 16);
  cachedKey = crypto.scryptSync(fp, salt, KEY_LEN, { N: 16384, r: 8, p: 1 });
  return cachedKey;
}

/** 是否为本模块产出的 v1 密文。 */
export function isV1Cipher(enc: string | undefined): boolean {
  return typeof enc === 'string' && enc.startsWith(`${CIPHER_PREFIX}:`);
}

/** AES-256-GCM 加密，输出 base64 字符串。空串原样返回。 */
export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHER_PREFIX,
    iv.toString('base64'),
    tag.toString('base64'),
    enc.toString('base64'),
  ].join(':');
}

/**
 * AES-256-GCM 解密。
 * 失败（被篡改 / 换机器 / 格式不符）返回空串 —— 调用方须按「未配置」处理，
 * 不回落到明文、不静默。
 */
export function decryptSecret(enc: string | undefined): string {
  if (!enc) return '';
  if (!isV1Cipher(enc)) return '';
  const parts = enc.split(':');
  if (parts.length !== 4) return '';
  try {
    const iv = Buffer.from(parts[1]!, 'base64');
    const tag = Buffer.from(parts[2]!, 'base64');
    const data = Buffer.from(parts[3]!, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  } catch {
    return '';
  }
}

/** 清掉缓存的派生密钥（测试用）。 */
export function resetKeyCache(): void {
  cachedKey = null;
}

// ---------------------------------------------------------------------------
// 显式密钥版（内置凭据场景，如 TRACE TOKEN 加密内置）
// ---------------------------------------------------------------------------

function keyFromHex(keyHex: string): Buffer {
  const buf = Buffer.from(keyHex, 'hex');
  if (buf.length !== 32) throw new Error('key must be 64-char hex (32 bytes)');
  return buf;
}

/**
 * AES-256-GCM 加密（显式密钥版）：与 encryptSecret 同 v1 格式，但密钥由调用方
 * 传入（64 字符 hex = 32 字节）而非本机派生——用于「加密内置」场景：打包期以随包
 * 密钥加密 TOKEN，运行时同包解密。诚实边界：密钥与密文同包仅是混淆级保护
 * （防静态 grep / 爬仓库捡明文），不防逆向；内置 TOKEN 必须用最小权限
 * （GitHub fine-grained，仅目标仓库 issues:write）。
 */
export function encryptWithKey(plain: string, keyHex: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFromHex(keyHex), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CIPHER_PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/** 解密（显式密钥版）。失败 / 换密钥 / 格式不符返回空串——调用方按「未内置」处理。 */
export function decryptWithKey(enc: string | undefined, keyHex: string): string {
  if (!enc || !isV1Cipher(enc)) return '';
  const parts = enc.split(':');
  if (parts.length !== 4) return '';
  try {
    const iv = Buffer.from(parts[1]!, 'base64');
    const tag = Buffer.from(parts[2]!, 'base64');
    const data = Buffer.from(parts[3]!, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, keyFromHex(keyHex), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  } catch {
    return '';
  }
}
