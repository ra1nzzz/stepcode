/**
 * 文件 Tab IPC（P2-11，只读优先；写走乐观并发 + 临时文件 rename）。
 * 注册须在 main.ts patch ipcMain.handle 之后调用，才能走 sender 门。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IpcMain } from 'electron';
import {
  FILE_TREE_MAX_ENTRIES,
  SNIFF_WINDOW,
  humanSize,
  languageOf,
  looksBinaryByName,
  normalizeFileRead,
  normalizeFileTree,
  normalizeFileWrite,
  sniffBinary,
  sortTreeEntries,
} from './file-panel';

export function registerFilePanelIpc(ipc: IpcMain): void {
  ipc.handle('orchdesk:file-tree', async (_e, input: unknown) => {
    const norm = normalizeFileTree(input as { dir?: string; depth?: number | string });
    if (!norm.ok) return { ok: false as const, reason: norm.reason };
    try {
      const dirents = fs.readdirSync(norm.dir, { withFileTypes: true });
      const raw: Array<{ name: string; kind: 'file' | 'dir'; size: number; mtime: number }> = [];
      let overflow = false;
      // scanned 与 raw 分开计数：被跳过（符号链接/无权限）的条目也计入扫描量，
      // 否则一个 5 万条目、绝大部分是坏链接的目录会被全量 stat 一遍才肯停。
      let scanned = 0;
      for (const de of dirents) {
        if (raw.length >= FILE_TREE_MAX_ENTRIES || scanned >= FILE_TREE_MAX_ENTRIES * 4) {
          overflow = true;
          break;
        }
        scanned++;
        // 目录不 stat：渲染层不显示目录大小，省下 500 次里的大半 syscall
        // （实测 500 次 statSync ≈ 17ms，主进程同步阻塞）。
        if (de.isDirectory()) {
          raw.push({ name: de.name, kind: 'dir', size: 0, mtime: 0 });
          continue;
        }
        if (!de.isFile()) continue; // 符号链接等其它类型：跳过（防环）。
        try {
          const st = fs.statSync(path.join(norm.dir, de.name));
          raw.push({ name: de.name, kind: 'file', size: st.size, mtime: st.mtimeMs });
        } catch {
          // 无权限 / 竞态删除：跳过该条目，不让一个坏条目毁掉整棵树。
        }
      }
      return {
        ok: true as const,
        dir: norm.dir,
        entries: sortTreeEntries(raw),
        truncated: overflow,
        total: dirents.length,
      };
    } catch (err) {
      return { ok: false as const, reason: (err as Error).message };
    }
  });

  ipc.handle('orchdesk:file-read', async (_e, input: unknown) => {
    const norm = normalizeFileRead(input as { path?: string });
    if (!norm.ok) return { ok: false as const, reason: norm.reason };
    try {
      const st = fs.statSync(norm.path);
      if (st.isDirectory()) return { ok: false as const, reason: '目标是目录，不是文件' };
      // languageOf / looksBinaryByName 都接受完整路径（内部先切 basename），
      // 不在这里自己 lastIndexOf('.')——路径里有带点目录时会取错扩展名。
      const lang = languageOf(norm.path);
      const binaryByName = looksBinaryByName(norm.path);
      // 只读 maxBytes 字节；是否截断由 stat.size 与 maxBytes 比较得出（显式字段）。
      const fd = fs.openSync(norm.path, 'r');
      try {
        const want = Math.min(st.size, norm.maxBytes);
        const buf = Buffer.alloc(want);
        // readSync 不保证一次读满（大文件 / 网络盘常见短读）。循环读满 want，
        // 否则会产出「内容比磁盘短却声称完整」的假象——「截断必须显式」的底线。
        let read = 0;
        while (read < want) {
          const n = fs.readSync(fd, buf, read, want - read, read);
          if (n <= 0) break;
          read += n;
        }
        const head = buf.subarray(0, Math.min(read, SNIFF_WINDOW));
        const binary = binaryByName || sniffBinary(head);
        if (binary) {
          // 二进制文件：只给元信息，不吐内容（渲染层显示「二进制文件」占位）。
          return {
            ok: true as const, path: norm.path, binary: true, truncated: false,
            size: st.size, sizeLabel: humanSize(st.size), lang: null, content: '',
            mtimeMs: st.mtimeMs, encodingSuspicious: false, editable: false,
          };
        }
        const truncated = st.size > norm.maxBytes || read < want;
        // 编辑资格判定（P3）：截断过的文件保存会丢数据、非 UTF-8 保存即乱码
        // ——一律 editable=false 且渲染层显式给原因。
        // 严格校验用 TextDecoder(fatal) 而不是「解出 U+FFFD 就判定」：后者会把
        // 本来就合法含 U+FFFD 的文本（译不准的占位符很常见）误判成非 UTF-8，
        // 结果是可编辑的文件被禁掉编辑。
        const decoded = buf.subarray(0, read).toString('utf8');
        let encodingSuspicious = false;
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, read));
        } catch {
          encodingSuspicious = true;
        }
        return {
          ok: true as const, path: norm.path, binary: false, truncated,
          size: st.size, sizeLabel: humanSize(st.size), lang,
          content: decoded,
          mtimeMs: st.mtimeMs, encodingSuspicious,
          editable: !truncated && !encodingSuspicious,
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return { ok: false as const, reason: (err as Error).message };
    }
  });

  ipc.handle('orchdesk:file-write', async (_e, input: unknown) => {
    const norm = normalizeFileWrite(input as {
      path?: string; content?: string; expectedMtimeMs?: number | string;
    });
    if (!norm.ok) return { ok: false as const, reason: norm.reason };
    try {
      const st = fs.statSync(norm.path);
      if (st.isDirectory()) return { ok: false as const, reason: '目标是目录，不是文件' };
      // 乐观并发检查：读取之后磁盘上又被改过（编辑器 / git / Agent 工具）就拒绝。
      // mtimeMs 是浮点，不同文件系统精度不一，留 2ms 容差。
      if (Math.abs(st.mtimeMs - norm.expectedMtimeMs) > 2) {
        return {
          ok: false as const, code: 'modified-externally' as const,
          reason: '文件在读取后被外部修改过，保存会覆盖那些改动；请先重新加载',
        };
      }
      // 同目录临时文件 + rename：写一半崩溃不会留下半截文件损坏原文件。
      const tmp = path.join(path.dirname(norm.path), '.' + path.basename(norm.path) + '.orchdesk-tmp');
      fs.writeFileSync(tmp, norm.content, 'utf8');
      try {
        fs.renameSync(tmp, norm.path);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败可忽略 */ }
        throw err;
      }
      const st2 = fs.statSync(norm.path);
      return {
        ok: true as const, path: norm.path,
        size: st2.size, sizeLabel: humanSize(st2.size), mtimeMs: st2.mtimeMs,
      };
    } catch (err) {
      return { ok: false as const, reason: (err as Error).message };
    }
  });
}
