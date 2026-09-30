/**
 * 打包前清理：结束正在运行的 OrchDesk 进程。
 * ----------------------------------------------------------------------------
 * BUG-016：electron-builder 删除 release/win-unpacked/ 时，若旧进程仍持有文件句柄，
 * Windows 会报 EBUSY 并导致整个打包失败。这里在打包前主动结束进程并短暂等待句柄释放。
 *
 * 零依赖（仅 node 内置模块），跨平台安全降级：非 Windows 直接跳过。
 * 注意：taskkill 的中文输出是 GBK，在此终端会乱码 —— 因此只依据退出码判定，
 * 不解析 stderr 文本。
 */

const { execSync } = require('node:child_process');

const TARGETS = ['OrchDesk.exe', 'electron.exe'];
const WAIT_MS = 1500;

/** taskkill 退出码：0=已结束；128=进程不存在；1=无匹配（部分版本）。 */
const BENIGN_EXIT_CODES = new Set([0, 1, 128]);

function killWindows(imageName) {
  try {
    execSync(`taskkill /F /IM "${imageName}" /T`, { stdio: 'ignore' });
    console.log(`[kill-running] 已结束 ${imageName}`);
    return true;
  } catch (err) {
    const code = typeof err.status === 'number' ? err.status : -1;
    if (!BENIGN_EXIT_CODES.has(code)) {
      console.warn(`[kill-running] ${imageName} 结束异常（退出码 ${code}）`);
    }
    return false;
  }
}

/** 同步休眠（不引入依赖、不空转烧 CPU）。 */
function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* 降级为空转 */ }
  }
}

function main() {
  if (process.platform !== 'win32') {
    console.log('[kill-running] 非 Windows 平台，跳过');
    return;
  }
  let killed = false;
  for (const t of TARGETS) killed = killWindows(t) || killed;
  if (killed) {
    // 给 Windows 一点时间释放文件句柄，否则仍可能撞上 EBUSY
    sleep(WAIT_MS);
    console.log(`[kill-running] 已等待 ${WAIT_MS}ms 释放文件句柄`);
  } else {
    console.log('[kill-running] 无运行中的 OrchDesk 进程');
  }
}

main();
