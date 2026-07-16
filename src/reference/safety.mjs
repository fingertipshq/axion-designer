import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ReferenceSystemError } from './errors.mjs';

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function unsafe(message, root, target) {
  throw new ReferenceSystemError('DK_REFERENCE_UNSAFE_PATH', message, { root, target });
}

export function fixProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
    throw new ReferenceSystemError('DK_REFERENCE_ROOT', 'projectRoot must be a non-empty path');
  }
  let root;
  try { root = realpathSync(resolve(projectRoot)); }
  catch (error) {
    throw new ReferenceSystemError('DK_REFERENCE_ROOT', `projectRoot must exist and be readable: ${projectRoot}`, { cause: error });
  }
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new ReferenceSystemError('DK_REFERENCE_ROOT', 'projectRoot must resolve to a regular directory');
  }
  return root;
}

export function resolveInsideProject(root, candidate, label = 'path', { allowRoot = false } = {}) {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) {
    unsafe(`${label} must be a non-empty path without NUL bytes`, root, candidate);
  }
  const target = resolve(root, candidate);
  if (!inside(root, target) || (!allowRoot && target === root)) {
    unsafe(`${label} must stay inside the fixed project root`, root, target);
  }
  return target;
}

export function relativeProjectPath(root, candidate, label = 'path') {
  const target = resolveInsideProject(root, candidate, label);
  return relative(root, target).split(sep).join('/');
}

export function assertNoSymlinkComponents(root, target, label = 'path', { includeFinal = true } = {}) {
  const absolute = resolveInsideProject(root, target, label);
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  const count = includeFinal ? parts.length : Math.max(0, parts.length - 1);
  let current = root;
  for (let index = 0; index < count; index++) {
    current = resolve(current, parts[index]);
    let st;
    try { st = lstatSync(current); }
    catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (st.isSymbolicLink()) unsafe(`${label} contains a symbolic link: ${relative(root, current)}`, root, absolute);
    if (index < count - 1 && !st.isDirectory()) unsafe(`${label} has a non-directory parent`, root, absolute);
  }
  return absolute;
}

export function readRegularFileInside(root, candidate, options = {}) {
  const label = options.label ?? 'file';
  const absolute = assertNoSymlinkComponents(root, candidate, label);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = openSync(absolute, constants.O_RDONLY | noFollow);
    const st = fstatSync(fd);
    if (!st.isFile()) unsafe(`${label} must be a regular file`, root, absolute);
    if (options.maxBytes != null && st.size > options.maxBytes) {
      throw new ReferenceSystemError(
        'DK_REFERENCE_FILE_SIZE',
        `${label} is ${st.size} bytes; maximum is ${options.maxBytes}`,
        { path: absolute, bytes: st.size, maxBytes: options.maxBytes },
      );
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) {
      throw new ReferenceSystemError('DK_REFERENCE_FILE_CHANGED', `${label} changed while it was being read`, { path: absolute });
    }
    return { absolute, relative: relativeProjectPath(root, absolute, label), bytes, stat: st };
  } catch (error) {
    if (error?.code === 'ELOOP') unsafe(`${label} must not be a symbolic link`, root, absolute);
    throw error;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

export function validateProjectRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || isAbsolute(value)) {
    return `${label} must be a non-empty project-relative path`;
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return `${label} must not traverse outside the project root`;
  }
  return null;
}

export function scopeAllowsProjectPath(scope, projectPath) {
  const normalized = projectPath.replaceAll('\\', '/').replace(/^\.\//, '');
  return (scope?.projectPaths ?? []).some((entry) => {
    const allowed = entry.replaceAll('\\', '/').replace(/^\.\//, '');
    if (allowed.endsWith('/**')) {
      const prefix = allowed.slice(0, -3).replace(/\/$/, '');
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    return normalized === allowed;
  });
}

export function scopeAllowsRoute(scope, route) {
  return route == null || (scope?.routes ?? []).includes('*') || (scope?.routes ?? []).includes(route);
}

