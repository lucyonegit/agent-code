/**
 * 模版生成服务
 * 使用 Vite 脚手架动态生成 React + TypeScript 项目模版
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import type {
  WebContainerTree,
  WebContainerFile,
  WebContainerDirectory,
} from '../utils/project-merger';

export interface TemplateConfig {
  framework: 'react-ts' | 'react' | 'vue-ts' | 'vue';
  cacheTTL?: number; // 缓存有效期（毫秒），默认 24 小时
}

interface CacheEntry {
  template: WebContainerTree;
  createdAt: number;
}

// 内存缓存
const templateCache = new Map<string, CacheEntry>();

// 默认缓存有效期：24 小时
const DEFAULT_CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * 获取或生成 Vite 模版
 */
export async function getViteTemplate(
  config: TemplateConfig = { framework: 'react-ts' }
): Promise<WebContainerTree> {
  const cacheKey = config.framework;
  const cacheTTL = config.cacheTTL ?? DEFAULT_CACHE_TTL;

  // 检查缓存
  const cached = templateCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < cacheTTL) {
    console.log(`[TemplateGenerator] Using cached template for ${cacheKey}`);
    return cached.template;
  }

  // 生成新模版
  console.log(`[TemplateGenerator] Generating new template for ${cacheKey}...`);
  const template = await generateViteTemplate(config);

  // 缓存结果
  templateCache.set(cacheKey, {
    template,
    createdAt: Date.now(),
  });

  return template;
}

/**
 * 使用 Vite 脚手架生成模版
 */
async function generateViteTemplate(config: TemplateConfig): Promise<WebContainerTree> {
  const tempDir = join(tmpdir(), `vite-template-${Date.now()}`);

  try {
    // 确保临时目录存在
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    // 使用 create-vite 生成项目
    const command = `npm create vite@latest . -- --template ${config.framework}`;
    console.log(`[TemplateGenerator] Executing: ${command} in ${tempDir}`);

    execSync(command, {
      cwd: tempDir,
      stdio: 'pipe',
      timeout: 60000, // 60 秒超时
    });

    // 读取生成的文件并转换为 WebContainerTree
    const tree = directoryToTree(tempDir);

    // 注入增强的设计系统样式
    injectDesignSystem(tree);

    return tree;
  } catch (error) {
    console.error('[TemplateGenerator] Failed to generate template:', error);
    // 返回内置的备用模版
    return getFallbackTemplate();
  } finally {
    // 清理临时目录
    try {
      execSync(`rm -rf "${tempDir}"`, { stdio: 'pipe' });
    } catch {
      // 忽略清理失败
    }
  }
}

/**
 * 递归读取目录并转换为 WebContainerTree
 */
function directoryToTree(dirPath: string, basePath: string = dirPath): WebContainerTree {
  const tree: WebContainerTree = {};
  const entries = readdirSync(dirPath);

  for (const entry of entries) {
    // 跳过 node_modules 和 .git
    if (entry === 'node_modules' || entry === '.git') {
      continue;
    }

    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      tree[entry] = {
        directory: directoryToTree(fullPath, basePath),
      } as WebContainerDirectory;
    } else if (stat.isFile()) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        tree[entry] = {
          file: {
            contents: content,
          },
        } as WebContainerFile;
      } catch {
        // 跳过无法读取的文件
      }
    }
  }

  return tree;
}

/**
 * 注入增强的设计系统样式到模版
 */
function injectDesignSystem(tree: WebContainerTree): void {
  // 查找 src 目录
  const srcDir = tree['src'] as WebContainerDirectory | undefined;
  if (!srcDir?.directory) return;

  // 查找并增强 index.css
  const indexCss = srcDir.directory['index.css'] as WebContainerFile | undefined;
  if (indexCss?.file) {
    indexCss.file.contents = ENHANCED_INDEX_CSS;
  }

  // 查找并增强 App.css
  const appCss = srcDir.directory['App.css'] as WebContainerFile | undefined;
  if (appCss?.file) {
    appCss.file.contents = ENHANCED_APP_CSS;
  }
}

/**
 * 备用内置模版（当脚手架失败时使用）
 */
function getFallbackTemplate(): WebContainerTree {
  // 返回一个基础的 React + TS 模版
  return {
    'package.json': {
      file: {
        contents: JSON.stringify(
          {
            name: 'vite-react-ts',
            private: true,
            version: '0.0.0',
            type: 'module',
            scripts: {
              dev: 'vite',
              build: 'tsc -b && vite build',
              preview: 'vite preview',
            },
            dependencies: {
              react: '^18.2.0',
              'react-dom': '^18.2.0',
            },
            devDependencies: {
              '@types/react': '^18.2.66',
              '@types/react-dom': '^18.2.22',
              '@vitejs/plugin-react': '^4.2.1',
              typescript: '^5.2.2',
              vite: '^5.2.0',
            },
          },
          null,
          2
        ),
      },
    },
    'vite.config.ts': {
      file: {
        contents: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`,
      },
    },
    'tsconfig.json': {
      file: {
        contents: JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              useDefineForClassFields: true,
              lib: ['ES2022', 'DOM', 'DOM.Iterable'],
              module: 'ESNext',
              skipLibCheck: true,
              moduleResolution: 'bundler',
              allowImportingTsExtensions: true,
              noEmit: true,
              jsx: 'react-jsx',
              strict: true,
            },
            include: ['src'],
          },
          null,
          2
        ),
      },
    },
    'index.html': {
      file: {
        contents: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + React + TS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
      },
    },
    src: {
      directory: {
        'main.tsx': {
          file: {
            contents: `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`,
          },
        },
        'App.tsx': {
          file: {
            contents: `import './App.css'

function App() {
  return (
    <div className="app">
      {/* AI generated content will be injected here */}
    </div>
  )
}

export default App
`,
          },
        },
        'index.css': {
          file: {
            contents: ENHANCED_INDEX_CSS,
          },
        },
        'App.css': {
          file: {
            contents: ENHANCED_APP_CSS,
          },
        },
      },
    },
  };
}

/**
 * 清除模版缓存
 */
export function clearTemplateCache(framework?: string): void {
  if (framework) {
    templateCache.delete(framework);
  } else {
    templateCache.clear();
  }
}

// 增强的 index.css - 带完整设计系统
const ENHANCED_INDEX_CSS = `:root {
  /* 颜色系统 */
  --color-bg: #0f0f23;
  --color-surface: #1a1a2e;
  --color-surface-hover: #252542;
  --color-primary: #6366f1;
  --color-primary-hover: #818cf8;
  --color-secondary: #22d3ee;
  --color-accent: #f472b6;
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-error: #ef4444;
  --color-text: #f8fafc;
  --color-text-secondary: #94a3b8;
  --color-text-muted: #64748b;
  --color-border: #334155;
  
  /* 间距 */
  --space-xs: 0.25rem;
  --space-sm: 0.5rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2rem;
  --space-2xl: 3rem;
  
  /* 圆角 */
  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
  --radius-full: 9999px;
  
  /* 阴影 */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
  --shadow-glow: 0 0 20px rgba(99, 102, 241, 0.3);
  
  /* 过渡 */
  --transition-fast: 150ms ease-out;
  --transition-normal: 250ms ease-out;
  
  /* 字体 */
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  line-height: 1.6;
  font-weight: 400;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  background: var(--color-bg);
  color: var(--color-text);
}

a {
  color: var(--color-primary);
  text-decoration: none;
  transition: color var(--transition-fast);
}

a:hover {
  color: var(--color-primary-hover);
}

button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-lg);
  border: none;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--color-primary), var(--color-primary-hover));
  color: white;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
  box-shadow: var(--shadow-md);
}

button:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg), var(--shadow-glow);
}

button:active {
  transform: translateY(0);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

input, textarea, select {
  padding: var(--space-sm) var(--space-md);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: 1rem;
  transition: all var(--transition-fast);
}

input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
}

input::placeholder {
  color: var(--color-text-muted);
}
`;

// 增强的 App.css
const ENHANCED_APP_CSS = `#root {
  max-width: 1280px;
  margin: 0 auto;
  padding: var(--space-2xl);
  min-height: 100vh;
}

.app {
  display: flex;
  flex-direction: column;
  gap: var(--space-xl);
}

/* 卡片样式 */
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-lg);
  box-shadow: var(--shadow-md);
  transition: all var(--transition-normal);
}

.card:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-lg);
}

/* 标题样式 */
h1, h2, h3, h4, h5, h6 {
  color: var(--color-text);
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.02em;
}

h1 {
  font-size: 2.5rem;
  background: linear-gradient(135deg, var(--color-text), var(--color-primary));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

h2 {
  font-size: 1.875rem;
}

h3 {
  font-size: 1.5rem;
}

/* 列表样式 */
.list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.list-item {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-md);
  background: var(--color-surface);
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.list-item:hover {
  background: var(--color-surface-hover);
}

/* 布局工具类 */
.flex {
  display: flex;
}

.flex-col {
  flex-direction: column;
}

.items-center {
  align-items: center;
}

.justify-between {
  justify-content: space-between;
}

.gap-sm {
  gap: var(--space-sm);
}

.gap-md {
  gap: var(--space-md);
}

.gap-lg {
  gap: var(--space-lg);
}
`;
