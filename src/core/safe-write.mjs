/* ============================================================
   Safe write boundary for every file Axion creates or replaces.

   Invariants:
     - the destination stays inside the caller's project root;
     - no existing path component, including the final target, is a symlink;
     - missing parent directories are created one component at a time;
     - file replacement is staged beside the destination and renamed, so a
       final-target swap cannot make the write follow a symlink.

   The project root itself is the trust anchor. Callers must pass the cwd that
   owns the artifact, never a path supplied by the artifact configuration.
   ============================================================ */
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class UnsafeWriteError extends Error {
  constructor(message, root, target) {
    super(message);
    this.name = 'UnsafeWriteError';
    this.code = 'DK_UNSAFE_WRITE';
    this.root = root;
    this.target = target;
  }
}

export function isUnsafeWriteError(err) {
  return err?.code === 'DK_UNSAFE_WRITE';
}

function fail(root, target, reason) {
  throw new UnsafeWriteError(
    `Refusing unsafe write to ${target}: ${reason}`,
    root,
    target,
  );
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function inspectExistingComponents(root, target, includeFinal = true) {
  const rel = relative(root, target);
  const parts = rel === '' ? [] : rel.split(sep).filter(Boolean);
  const end = includeFinal ? parts.length : Math.max(0, parts.length - 1);
  let current = root;
  for (let i = 0; i < end; i++) {
    current = join(current, parts[i]);
    let st;
    try { st = lstatSync(current); }
    catch (err) {
      if (err?.code === 'ENOENT') break;
      throw err;
    }
    if (st.isSymbolicLink()) fail(root, target, `path component is a symbolic link (${current})`);
    if (i < end - 1 && !st.isDirectory()) fail(root, target, `parent component is not a directory (${current})`);
  }
}

/** Validate a prospective destination without writing it. Returns an absolute path. */
export function assertSafeWritePath(root, target, opts = {}) {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  if (!isInside(rootAbs, targetAbs) || targetAbs === rootAbs) {
    fail(rootAbs, targetAbs, 'destination must stay inside the project root');
  }
  inspectExistingComponents(rootAbs, targetAbs, opts.includeFinal !== false);
  return targetAbs;
}

function ensureSafeParentSync(root, target) {
  const parent = dirname(target);
  const rel = relative(root, parent);
  const parts = rel === '' ? [] : rel.split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let st;
    try { st = lstatSync(current); }
    catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      mkdirSync(current);
      st = lstatSync(current);
    }
    if (st.isSymbolicLink()) fail(root, target, `parent component is a symbolic link (${current})`);
    if (!st.isDirectory()) fail(root, target, `parent component is not a directory (${current})`);
  }
}

/**
 * Write or replace a file under root without following destination symlinks.
 * Existing regular-file mode bits are preserved.
 */
export function safeWriteFileSync(root, target, data, options = {}) {
  const rootAbs = resolve(root);
  const targetAbs = assertSafeWritePath(rootAbs, target);
  ensureSafeParentSync(rootAbs, targetAbs);
  // Recheck after creating parents. This also rejects a final symlink before staging.
  assertSafeWritePath(rootAbs, targetAbs);

  let mode = options.mode ?? 0o666;
  if (existsSync(targetAbs)) {
    const st = lstatSync(targetAbs);
    if (st.isSymbolicLink()) fail(rootAbs, targetAbs, 'final target is a symbolic link');
    if (!st.isFile()) fail(rootAbs, targetAbs, 'final target is not a regular file');
    mode = options.mode ?? (st.mode & 0o777);
  }

  const temp = join(
    dirname(targetAbs),
    `.${basename(targetAbs)}.dk-tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  let fd = null;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, mode);
    writeFileSync(fd, data, options.encoding ? { encoding: options.encoding } : undefined);
    closeSync(fd);
    fd = null;

    // If an attacker swaps the final target after the first check, reject a
    // symlink. rename replaces an entry rather than following it, so the staged
    // bytes still cannot escape even in the remaining race window.
    assertSafeWritePath(rootAbs, targetAbs);
    renameSync(temp, targetAbs);
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
  return targetAbs;
}

/** Copy the trusted bundled scaffold into a non-symlink directory under root. */
export function safeCopyDirectorySync(root, source, target, options = {}) {
  const rootAbs = resolve(root);
  const targetAbs = assertSafeWritePath(rootAbs, target);
  ensureSafeParentSync(rootAbs, targetAbs);
  if (existsSync(targetAbs)) {
    const st = lstatSync(targetAbs);
    if (st.isSymbolicLink()) fail(rootAbs, targetAbs, 'final target is a symbolic link');
    if (!st.isDirectory()) fail(rootAbs, targetAbs, 'copy target is not a directory');
  } else {
    mkdirSync(targetAbs);
  }
  assertSafeWritePath(rootAbs, targetAbs);
  cpSync(source, targetAbs, { recursive: true, ...(options.filter ? { filter: options.filter } : {}) });
  return targetAbs;
}
