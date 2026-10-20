import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const files = [
  'index.html',
  'styles.css',
  'app.js',
  'diary-core.js',
  'diary-services.js',
  'asset/cover.png',
  'asset/paper.png',
  'asset/icon.png',
  'asset/font.ttf',
  'asset/flip.mp3',
  'asset/close.mp3',
];

// 只整理应用实际依赖，避免把文档、依赖目录和原始备份打进安装包。
await mkdir(path.join(output, 'asset'), { recursive: true });
for (const file of files) {
  await copyFile(path.join(root, file), path.join(output, file));
}
console.log('桌面版前端已准备完成：dist');
