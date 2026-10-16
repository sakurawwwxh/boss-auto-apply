'use strict'

const D = window.BossDefaults

const LIST_URL = 'https://www.zhipin.com/web/geek/jobs'

function todayKey() {
  const d = new Date()
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

async function refresh() {
  const raw = await chrome.storage.local.get([D.CONFIG_KEY, D.STATS_KEY])
  const cfg = D.sanitizeConfig(raw[D.CONFIG_KEY])
  const stats = D.mergeStats(raw[D.STATS_KEY], todayKey())
  document.getElementById('dryRun').checked = !!cfg.dryRun
  document.getElementById('applied').textContent = stats.applied
  document.getElementById('scanned').textContent = stats.scanned
}

document.getElementById('dryRun').addEventListener('change', async (e) => {
  const raw = await chrome.storage.local.get(D.CONFIG_KEY)
  const cfg = D.sanitizeConfig(raw[D.CONFIG_KEY])
  cfg.dryRun = e.target.checked
  await chrome.storage.local.set({ [D.CONFIG_KEY]: cfg })
})

document.getElementById('openList').addEventListener('click', () => {
  chrome.tabs.create({ url: LIST_URL })
  window.close()
})

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
  window.close()
})

chrome.storage.onChanged.addListener(refresh)
refresh()
