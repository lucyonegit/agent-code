/**
 * 路径验证工具
 * 检查生成代码中的 import 路径是否正确，并提供自动修复建议
 */

import { dirname, resolve, relative, extname } from 'path';

export interface ImportStatement {
  raw: string;           // 原始 import 语句
  from: string;          // import 路径
  isRelative: boolean;   // 是否为相对路径
  lineNumber: number;    // 行号
}

export interface PathError {
  file: string;
  lineNumber: number;
  importPath: string;
  expectedPath: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: PathError[];
  warnings: string[];
}

/**
 * 提取文件中的所有 import 语句
 */
export function extractImports(content: string): ImportStatement[] {
  const imports: ImportStatement[] = [];
  const lines = content.split('\n');

  // 匹配各种 import 格式
  const patterns = [
    // import x from 'path'
    /import\s+.*?\s+from\s+['"](.+?)['"]/,
    // import 'path'
    /import\s+['"](.+?)['"]/,
    // export * from 'path'
    /export\s+.*?\s+from\s+['"](.+?)['"]/,
    // require('path')
    /require\s*\(\s*['"](.+?)['"]\s*\)/,
  ];

  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const from = match[1];
        imports.push({
          raw: line.trim(),
          from,
          isRelative: from.startsWith('.') || from.startsWith('/'),
          lineNumber: index + 1,
        });
        break;
      }
    }
  });

  return imports;
}

/**
 * 判断是否为外部 npm 包
 */
export function isExternalPackage(importPath: string): boolean {
  // 相对路径
  if (importPath.startsWith('.') || importPath.startsWith('/')) {
    return false;
  }
  // 路径别名（应该被禁止）
  if (importPath.startsWith('@/') || importPath.startsWith('~/')) {
    return false;
  }
  // npm 包（包括 @scope/pkg 格式）
  return true;
}

/**
 * 解析相对路径为规范化的目标路径
 * @param fromFilePath 当前文件路径，如 'src/pages/Home.tsx'
 * @param importPath import 的路径，如 '../components/Button'
 * @returns 规范化的目标文件路径
 */
export function resolveImportPath(fromFilePath: string, importPath: string): string {
  const fromDir = dirname(fromFilePath);
  const resolved = resolve('/', fromDir, importPath).slice(1); // 移除开头的 /
  return resolved;
}

/**
 * 计算从一个文件到另一个文件的正确相对路径
 * @param fromFilePath 源文件路径，如 'src/pages/Home.tsx'
 * @param toFilePath 目标文件路径，如 'src/components/Button.tsx'
 * @returns 正确的相对路径，如 '../components/Button'
 */
export function calculateRelativePath(fromFilePath: string, toFilePath: string): string {
  const fromDir = dirname(fromFilePath);
  let relativePath = relative(fromDir, toFilePath);

  // 确保以 ./ 或 ../ 开头
  if (!relativePath.startsWith('.')) {
    relativePath = './' + relativePath;
  }

  // 移除 .tsx/.ts/.js 扩展名（组件导入不带扩展名）
  const ext = extname(relativePath);
  if (['.tsx', '.ts', '.js', '.jsx'].includes(ext)) {
    relativePath = relativePath.slice(0, -ext.length);
  }

  return relativePath;
}

/**
 * 查找目标文件（支持自动补全扩展名）
 */
export function findTargetFile(
  basePath: string,
  existingFiles: Set<string>
): string | null {
  // 直接匹配
  if (existingFiles.has(basePath)) {
    return basePath;
  }

  // 尝试补全扩展名
  const extensions = ['.tsx', '.ts', '.js', '.jsx', '.css', ''];
  for (const ext of extensions) {
    const fullPath = basePath + ext;
    if (existingFiles.has(fullPath)) {
      return fullPath;
    }
  }

  // 尝试 index 文件
  const indexPaths = [
    `${basePath}/index.tsx`,
    `${basePath}/index.ts`,
    `${basePath}/index.js`,
  ];
  for (const indexPath of indexPaths) {
    if (existingFiles.has(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

/**
 * 验证文件中的所有 import 路径
 */
export function validateFileImports(
  filePath: string,
  content: string,
  allFilePaths: Set<string>
): PathError[] {
  const errors: PathError[] = [];
  const imports = extractImports(content);

  for (const imp of imports) {
    // 跳过外部包
    if (isExternalPackage(imp.from)) {
      continue;
    }

    // 检查路径别名（应该被禁止）
    if (imp.from.startsWith('@/') || imp.from.startsWith('~/') || imp.from.startsWith('@internal/')) {
      errors.push({
        file: filePath,
        lineNumber: imp.lineNumber,
        importPath: imp.from,
        expectedPath: '禁止使用路径别名',
        message: `路径别名 "${imp.from}" 被禁止使用，请改用相对路径`,
      });
      continue;
    }

    // 解析相对路径
    const resolvedPath = resolveImportPath(filePath, imp.from);
    const targetFile = findTargetFile(resolvedPath, allFilePaths);

    if (!targetFile) {
      // 尝试找出可能的正确路径
      const possibleCorrectPath = findSimilarPath(resolvedPath, allFilePaths);

      errors.push({
        file: filePath,
        lineNumber: imp.lineNumber,
        importPath: imp.from,
        expectedPath: possibleCorrectPath || '未找到匹配文件',
        message: `import "${imp.from}" 目标文件 "${resolvedPath}" 不存在`,
      });
    }
  }

  return errors;
}

/**
 * 查找相似路径（用于建议修复）
 */
function findSimilarPath(targetPath: string, allFilePaths: Set<string>): string | null {
  const targetName = targetPath.split('/').pop()?.replace(/\.(tsx?|jsx?|css)$/, '');
  if (!targetName) return null;

  for (const filePath of allFilePaths) {
    const fileName = filePath.split('/').pop()?.replace(/\.(tsx?|jsx?|css)$/, '');
    if (fileName === targetName) {
      return filePath;
    }
  }

  return null;
}

/**
 * 验证所有生成的文件
 */
export function validateAllFiles(
  files: Array<{ path: string; content: string }>
): ValidationResult {
  const allFilePaths = new Set(files.map(f => f.path));
  const errors: PathError[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const fileErrors = validateFileImports(file.path, file.content, allFilePaths);
    errors.push(...fileErrors);
  }

  // 检查是否有重复的文件路径
  const pathCounts = new Map<string, number>();
  for (const file of files) {
    pathCounts.set(file.path, (pathCounts.get(file.path) || 0) + 1);
  }
  for (const [path, count] of pathCounts) {
    if (count > 1) {
      warnings.push(`文件路径 "${path}" 出现了 ${count} 次，可能存在覆盖问题`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 生成路径错误的修复提示（供 LLM 使用）
 */
export function generateFixPrompt(errors: PathError[]): string {
  if (errors.length === 0) return '';

  let prompt = '## 路径错误需要修复\n\n以下 import 路径存在问题:\n\n';

  for (const error of errors) {
    prompt += `- **${error.file}:${error.lineNumber}**\n`;
    prompt += `  - 错误路径: \`${error.importPath}\`\n`;
    prompt += `  - 问题: ${error.message}\n`;
    if (error.expectedPath !== '未找到匹配文件' && error.expectedPath !== '禁止使用路径别名') {
      prompt += `  - 建议路径: \`${error.expectedPath}\`\n`;
    }
    prompt += '\n';
  }

  prompt += '请修正上述 import 路径，确保编译可以通过。\n';

  return prompt;
}
