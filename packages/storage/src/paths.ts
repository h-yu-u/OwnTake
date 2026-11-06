import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AppError, invariant } from '../../contracts/src/errors.ts';
import { validateId } from './validation.ts';

export function relativeAssetPath(value: unknown): string {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 1024, 'INVALID_PATH', '无效的素材相对路径。');
  const parts = value.split('/');
  invariant(!isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && !/^[a-zA-Z]:/.test(value), 'INVALID_PATH', '素材必须使用项目内相对路径。');
  invariant(parts.every(part => part !== '' && part !== '.' && part !== '..'), 'INVALID_PATH', '素材路径不能越出项目目录。');
  return value;
}

export function artifactRelativePath(value: unknown, artifactId: string): string {
  const path = relativeAssetPath(value);
  const [area, id, ...file] = path.split('/');
  invariant((area === 'assets' || area === 'exports') && id === artifactId && file.length > 0, 'INVALID_PATH', '素材必须存放在以素材版本 ID 命名的 assets 或 exports 子目录中。');
  return path;
}

export function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function projectDirectory(projectsDir: string, id: string): string {
  validateId(id);
  const result = resolve(projectsDir, id);
  try {
    const stat = lstatSync(result);
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'INVALID_PATH', '项目目录不能是符号链接。');
    invariant(inside(projectsDir, realpathSync(result)), 'INVALID_PATH', '项目目录越界。');
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('PROJECT_DIRECTORY_MISSING', '项目目录不存在或无法访问，请检查配置或恢复备份。', 409);
  }
}

export function existingProjectFile(root: string, relativePath: string): string {
  const safe = relativeAssetPath(relativePath);
  const candidate = resolve(root, safe);
  invariant(inside(root, candidate), 'INVALID_PATH', '素材路径不能越出项目目录。');
  try {
    const actual = realpathSync(candidate);
    invariant(inside(realpathSync(root), actual), 'INVALID_PATH', '素材链接指向项目目录外。');
    invariant(statSync(actual).isFile(), 'ASSET_UNAVAILABLE', '素材不是普通文件。', 409);
    return actual;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('ASSET_UNAVAILABLE', '素材文件不存在或无法读取，请重新关联或恢复备份。', 409);
  }
}
