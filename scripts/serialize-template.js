import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_DIR = path.join(__dirname, '../template-react-ts');
const OUTPUT_FILE = path.join(__dirname, '../src/constants/baseTemplate.json');

function buildTree(dir) {
  const tree = {};
  const files = fs.readdirSync(dir);

  for (const file of files) {
    if (file === 'node_modules' || file === '.git' || file === 'dist' || file === 'package-lock.json') continue;

    const filePath = path.join(dir, file);
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      tree[file] = {
        directory: buildTree(filePath)
      };
    } else {
      const contents = fs.readFileSync(filePath, 'utf-8');
      tree[file] = {
        file: {
          contents
        }
      };
    }
  }

  return tree;
}

function main() {
  console.log('Serializing template...');
  const tree = buildTree(TEMPLATE_DIR);
  
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(tree, null, 2));
  console.log(`Successfully generated ${OUTPUT_FILE}`);
}

main();

