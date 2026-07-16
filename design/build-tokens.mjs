#!/usr/bin/env node
/* ============================================================
   Axion Designer token compiler — 零依賴薄轉接層。
   design/tokens.json (DTCG)  ->  styles/tokens.css

   這是 repo 內的開發捷徑；唯一編譯實作在 src/core/tokens.mjs，
   供 build 命令、contract 關卡與 slop 關卡共用。
   輸出與 `node bin/dk.mjs build` 位元組相同（compile 的預設 header 逐位元組重現）。

   用法：
     node design/build-tokens.mjs           # 產生 styles/tokens.css
     node design/build-tokens.mjs --check    # 只檢查是否同步（CI 用；不同步 exit 1）
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadTokens, compile } from '../src/core/tokens.mjs';
import { safeWriteFileSync } from '../src/core/safe-write.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'design', 'tokens.json');
const OUT = join(ROOT, 'styles', 'tokens.css');

const { css, tokenCount, darkCount } = compile(loadTokens(SRC), { formats: ['css'] });

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(OUT, 'utf8'); } catch {}
  if (current !== css) {
    console.error('✗ styles/tokens.css 與 SSOT 不同步。請執行：npm run tokens:build');
    process.exit(1);
  }
  console.log('✓ tokens.css 與 SSOT 同步');
} else {
  safeWriteFileSync(ROOT, OUT, css);
  console.log(`✓ 已產生 ${OUT}（${tokenCount} tokens，${darkCount} 深色覆寫）`);
}
