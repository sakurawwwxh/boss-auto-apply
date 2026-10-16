'use strict'

const D = window.BossDefaults

// 每个输入框对应配置里的哪个字段
const BINDINGS = [
  ['dryRun', 'dryRun', 'bool'],
  ['autoConfirm120', 'limits.autoConfirm120', 'bool'],
  ['mustKeywords', 'filters.mustKeywords', 'text'],
  ['excludeKeywords', 'filters.excludeKeywords', 'text'],
  ['excludeCompanies', 'filters.excludeCompanies', 'text'],
  ['excludeInJd', 'filters.excludeInJd', 'text'],
  ['cities', 'filters.cities', 'text'],
  ['salaryMin', 'filters.salaryMin', 'num'],
  ['salaryMax', 'filters.salaryMax', 'num'],
  ['activeWithinDays', 'filters.activeWithinDays', 'num'],
  ['sameHrDays', 'filters.sameHrDays', 'num'],
  ['skipSameHr', 'filters.skipSameHr', 'bool'],
  ['skipContacted', 'filters.skipContacted', 'bool'],
  ['excludeHeadhunter', 'filters.excludeHeadhunter', 'bool'],
  ['includeInJd', 'filters.includeInJd', 'bool'],
  ['dailyMax', 'limits.dailyMax', 'num'],
  ['maxPages', 'limits.maxPages', 'num'],
  ['delayMinMs', 'limits.delayMinMs', 'num'],
  ['delayMaxMs', 'limits.delayMaxMs', 'num']
]

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)
}

function setPath(obj, path, value) {
  const parts = path.split('.')
  let node = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {}
    node = node[parts[i]]
  }
  node[parts[parts.length - 1]] = value
}

function fillForm(cfg) {
  for (const [id, path, kind] of BINDINGS) {
    const el = document.getElementById(id)
    if (!el) continue
    const value = getPath(cfg, path)
    if (kind === 'bool') el.checked = !!value
    else el.value = value === undefined || value === null ? '' : value
  }
}

function readForm(base) {
  const out = JSON.parse(JSON.stringify(base))
  for (const [id, path, kind] of BINDINGS) {
    const el = document.getElementById(id)
    if (!el) continue
    if (kind === 'bool') setPath(out, path, el.checked)
    else if (kind === 'num') setPath(out, path, Number(el.value) || 0)
    else setPath(out, path, el.value)
  }
  return out
}

async function load() {
  const raw = await chrome.storage.local.get(D.CONFIG_KEY)
  return D.sanitizeConfig(raw[D.CONFIG_KEY])
}

async function save() {
  const current = await load()
  const next = D.sanitizeConfig(readForm(current))
  await chrome.storage.local.set({ [D.CONFIG_KEY]: next })
  fillForm(next) // 回填被夹过的值，让用户看到最终生效的配置
  const tip = document.getElementById('savedTip')
  tip.classList.add('show')
  setTimeout(() => tip.classList.remove('show'), 1500)
}

document.getElementById('saveBtn').addEventListener('click', save)

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!confirm('恢复默认配置？当前设置会丢。')) return
  const fresh = D.sanitizeConfig(null)
  await chrome.storage.local.set({ [D.CONFIG_KEY]: fresh })
  fillForm(fresh)
})

document.getElementById('exportBtn').addEventListener('click', async () => {
  const cfg = await load()
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'boss-auto-apply-config.json'
  a.click()
  URL.revokeObjectURL(url)
})

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click()
})

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    const next = D.sanitizeConfig(parsed)
    await chrome.storage.local.set({ [D.CONFIG_KEY]: next })
    fillForm(next)
  } catch (err) {
    alert('导入失败：' + err.message)
  }
  e.target.value = ''
})

load().then(fillForm)
