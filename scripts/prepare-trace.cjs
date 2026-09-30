#!/usr/bin/env node
/**
 * prepare-trace.cjs —— TRACE TOKEN 加密内置（打包前手动执行一次）
 * ----------------------------------------------------------------------------
 * 用法：
 *   1. 生成 fine-grained GitHub TOKEN（仅 ra1nzzz/orchdesk 的 issues:write 权限）：
 *      https://github.com/settings/personal-access-tokens/new
 *   2. 把 TOKEN 写入 apps/desktop/build/trace-token.local.txt（一行，gitignore 内）
 *   3. node scripts/prepare-trace.cjs
 *   4. 正常打包（electron-builder）——build/trace-token.enc.json 与
 *      build/trace-key.local 会随包进入安装目录，运行时解密注入 trace 插件
 *
 * 诚实边界：密钥与密文同包 = 混淆级保护（防静态 grep / 爬仓库捡明文），
 * 不防逆向。请务必使用最小权限 TOKEN。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CIPHER_PREFIX = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;

const buildDir = path.join(__dirname, '..', 'apps', 'desktop', 'build');
const tokenFile = path.join(buildDir, 'trace-token.local.txt');
const keyFile = path.join(buildDir, 'trace-key.local');
const outFile = path.join(buildDir, 'trace-token.enc.json');

const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf-8').trim() : '';
if (!token) {
  console.log('[prepare-trace] 未找到 build/trace-token.local.txt —— 跳过（TRACE 将只缓冲不上传，属安全降级）');
  process.exit(0);
}
if (!/^gh[pousr]_/.test(token) && token.length < 20) {
  console.error('[prepare-trace] TOKEN 形状不像 GitHub token，请检查文件内容');
  process.exit(1);
}

// 随包密钥：存在则复用，否则生成（64 hex 字符 = 32 字节）
let keyHex = '';
if (fs.existsSync(keyFile)) {
  keyHex = fs.readFileSync(keyFile, 'utf-8').trim();
}
if (!/^[0-9a-f]{64}$/.test(keyHex)) {
  keyHex = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, keyHex, 'utf-8');
  console.log('[prepare-trace] 已生成随包密钥 build/trace-key.local');
}

const iv = crypto.randomBytes(IV_LEN);
const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(keyHex, 'hex'), iv);
const enc = Buffer.concat([cipher.update(token, 'utf-8'), cipher.final()]);
const tag = cipher.getAuthTag();
const encStr = [CIPHER_PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');

fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ v: 1, enc: encStr }, null, 2), 'utf-8');
console.log('[prepare-trace] 完成：build/trace-token.enc.json 已生成（TOKEN 已 AES-256-GCM 加密内置）');
console.log('[prepare-trace] 自检（同包解密）：', (() => {
  const p = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  const parts = p.enc.split(':');
  const d = crypto.createDecipheriv(ALGORITHM, Buffer.from(keyHex, 'hex'), Buffer.from(parts[1], 'base64'));
  d.setAuthTag(Buffer.from(parts[2], 'base64'));
  const plain = Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf-8');
  return plain === token ? 'OK' : 'MISMATCH';
})());
