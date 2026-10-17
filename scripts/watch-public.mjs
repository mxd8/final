import { watch, cpSync } from 'fs';
import { resolve } from 'path';

console.log('👀 正在监听 public/ 目录的实时修改...');

watch(resolve('public'), { recursive: true }, (eventType, filename) => {
    if (filename) {
        console.log(`📁 检测到文件变动 [${filename}]，正在自动同步到 dist/...`);
        try {
            cpSync('public', 'dist', { recursive: true });
            console.log('✨ 同步成功！浏览器已自动热更新。');
        } catch (err) {
            console.error('❌ 同步失败:', err);
        }
    }
});
