/**
 * 把扩展版的三段源码拼成单文件油猴脚本。
 *
 * 关键点：拼的是**同一份** defaults.js / filters.js / panel.js，不重写、不复制。
 * 面板代码只通过 window.__BOSS_EXT__ 这个口用扩展能力，shim 把这个口实现出来，
 * 于是两版行为一致、改一处两边都改到。
 *
 *   node tools/build-userscript.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(ROOT, 'dist')
const OUT_FILE = join(OUT_DIR, 'boss-auto-apply.user.js')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const HEADER = `// ==UserScript==
// @name         BOSS直聘 自动投递助手
// @namespace    boss-auto-apply
// @version      ${pkg.version}
// @description  按你的条件筛选 BOSS 直聘岗位并自动投递。默认试运行，带随机延迟与每日上限，纯本地运行。
// @match        https://*.zhipin.com/web/geek/*
// @match        https://*.zhipin.com/job_detail/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @homepageURL  https://github.com/sakurawwwxh/boss-auto-apply
// @supportURL   https://github.com/sakurawwwxh/boss-auto-apply/issues
// @updateURL    https://raw.githubusercontent.com/sakurawwwxh/boss-auto-apply/main/dist/boss-auto-apply.user.js
// @downloadURL  https://raw.githubusercontent.com/sakurawwwxh/boss-auto-apply/main/dist/boss-auto-apply.user.js
// @license      MIT
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 这个文件是构建产物，不要直接改。
 *   源码：src/shared/defaults.js、src/content/filters.js、src/content/panel.js
 *   适配层：tools/userscript-shim.js
 *   重新生成：node tools/build-userscript.mjs
 */
`

const PARTS = [
  ['适配层（油猴环境）', 'tools/userscript-shim.js'],
  ['配置默认值与合并', 'src/shared/defaults.js'],
  ['筛选判定（纯逻辑）', 'src/content/filters.js'],
  ['面板与投递主流程', 'src/content/panel.js']
]

const chunks = [HEADER]
for (const [title, rel] of PARTS) {
  const code = readFileSync(join(ROOT, rel), 'utf8').trimEnd()

  // 这几段都是 IIFE。前一段结尾要是没有分号，下一段开头的 "(function" 会被 JS 当成
  // 「调用上一段的结果」——就是 ASI 陷阱，产物会报 "is not a function"。
  // 这里直接卡住，别让坏产物生成出来。
  if (!code.endsWith(';')) {
    throw new Error(rel + ' 的结尾不是分号，拼接后会踩 ASI 陷阱（产物会报 is not a function）。请在文件末尾补 ";"')
  }

  chunks.push(`\n/* ==========================================================================\n * ${title}  ←  ${rel}\n * ========================================================================== */\n\n${code}\n`)
}

const out = chunks.join('\n')
// --check：只校验产物是否与源码同步，不写文件。
// 防止「改完源码忘了重新构建」就把旧逻辑发出去。
if (process.argv.includes('--check')) {
  let existing = ''
  try {
    existing = readFileSync(OUT_FILE, 'utf8')
  } catch (e) {
    console.error('✗ 产物不存在，先跑一次 npm run build:userscript')
    process.exit(1)
  }
  if (existing !== out) {
    console.error('✗ dist/boss-auto-apply.user.js 与源码不一致（改完源码忘了重新构建？）')
    console.error('  跑 npm run build:userscript 重新生成后再发布。')
    process.exit(1)
  }
  console.log('✓ 产物与源码一致（' + Buffer.byteLength(out) + ' 字节）')
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT_FILE, out)
console.log('已生成 ' + OUT_FILE + '（' + Buffer.byteLength(out) + ' 字节，' + out.split('\n').length + ' 行）')
