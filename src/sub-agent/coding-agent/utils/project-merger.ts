export interface FileNode {
  path: string;
  content: string;
  npm_dependencies?: Record<string, string>;
}

export interface WebContainerFile {
  file: {
    contents: string;
  };
}

export interface WebContainerDirectory {
  directory: {
    [key: string]: WebContainerFile | WebContainerDirectory;
  };
}

export type WebContainerTree = {
  [key: string]: WebContainerFile | WebContainerDirectory;
};

/**
 * 将平坦路径转换为树形结构
 */
export function buildFileSystemTree(files: FileNode[]): WebContainerTree {
  const root: WebContainerTree = {};

  for (const file of files) {
    const parts = file.path.split('/');
    let current: any = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        current[part] = {
          file: {
            contents: file.content,
          },
        };
      } else {
        if (!current[part]) {
          current[part] = {
            directory: {},
          };
        }
        current = current[part].directory;
      }
    }
  }

  return root;
}

/**
 * 深度合并两个文件树
 */
export function mergeProject(
  baseTree: WebContainerTree,
  aiTree: WebContainerTree
): WebContainerTree {
  const merged = JSON.parse(JSON.stringify(baseTree));

  function mergeRecursive(target: any, source: any) {
    for (const key in source) {
      if (source[key].directory) {
        if (!target[key]) {
          target[key] = { directory: {} };
        } else if (!target[key].directory) {
          // 如果原来是文件现在是目录，覆盖
          target[key] = { directory: {} };
        }
        mergeRecursive(target[key].directory, source[key].directory);
      } else if (source[key].file) {
        target[key] = source[key];
      }
    }
  }

  mergeRecursive(merged, aiTree);
  return merged;
}

/**
 * 合并依赖到 package.json
 */
export function patchPackageJson(tree: WebContainerTree, aiFiles: FileNode[]): WebContainerTree {
  const packageJsonNode = tree['package.json'] as any;
  if (!packageJsonNode || !packageJsonNode.file) return tree;

  try {
    const packageJson = JSON.parse(packageJsonNode.file.contents);
    if (!packageJson.dependencies) packageJson.dependencies = {};

    for (const file of aiFiles) {
      if (file.npm_dependencies) {
        for (const [pkg, version] of Object.entries(file.npm_dependencies)) {
          // 简单的合并策略，如果已有依赖则不覆盖，或者可以根据版本号合并
          // 这里简单起见直接覆盖或添加
          packageJson.dependencies[pkg] = version;
        }
      }
    }

    packageJsonNode.file.contents = JSON.stringify(packageJson, null, 2);
  } catch (e) {
    console.error('Failed to patch package.json', e);
  }

  return tree;
}

/**
 * 主合并函数
 */
export function processProjectForWebContainer(
  baseTemplate: WebContainerTree,
  aiOutputFiles: FileNode[]
): WebContainerTree {
  const aiTree = buildFileSystemTree(aiOutputFiles);
  let finalTree = mergeProject(baseTemplate, aiTree);
  finalTree = patchPackageJson(finalTree, aiOutputFiles);
  return finalTree;
}
