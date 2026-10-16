/**
 * Service worker。
 *
 * 只干两件事：
 *  1. 用 chrome.cookies 读 BOSS 的 bst token（HttpOnly 也能读到，因此内容脚本
 *     不需要往页面里注入脚本、也不用手动复制 token）。
 *  2. 给内容脚本兜一个 fetch 中继：万一页面 CSP 拦掉了内容脚本的请求，改由
 *     扩展上下文发出（带 host_permissions 就不受页面 CORS 约束）。
 */
'use strict'

const TOKEN_NAME = 'bst'
const TOKEN_PROBE_URLS = [
  'https://www.zhipin.com/wapi/zpgeek/job/card.json',
  'https://www.zhipin.com/web/geek/jobs',
  'https://www.zhipin.com/'
]

async function readToken() {
  for (const url of TOKEN_PROBE_URLS) {
    try {
      const cookie = await chrome.cookies.get({ url, name: TOKEN_NAME })
      if (cookie && cookie.value) return cookie.value
    } catch (e) {
      /* 换下一个探测地址 */
    }
  }
  try {
    const all = await chrome.cookies.getAll({ domain: 'zhipin.com' })
    const hit = all.find((c) => c.name === TOKEN_NAME && c.value)
    if (hit) return hit.value
  } catch (e) {
    /* 落空 */
  }
  return null
}

// 中继只允许打 BOSS 自己的读接口：消息载荷里的 URL 不做白名单就等于把
// 带 cookie 的任意请求能力开给了内容脚本，没必要。
const RELAY_ALLOWED_PATHS = ['/wapi/zpgeek/job/card.json']

function isRelayAllowed(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch (e) {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.zhipin.com') return false
  return RELAY_ALLOWED_PATHS.includes(parsed.pathname)
}

async function relayFetch({ url, method = 'GET', headers = {} }) {
  if (method !== 'GET') return { blocked: true, reason: '中继只用于 GET' }
  if (!isRelayAllowed(url)) return { blocked: true, reason: '目标不在白名单内' }

  const res = await fetch(url, { method: 'GET', headers, credentials: 'include', redirect: 'follow' })
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined

  if (msg.type === 'getToken') {
    readToken()
      .then((token) => sendResponse({ token }))
      .catch((e) => sendResponse({ token: null, error: String(e && e.message) }))
    return true
  }

  if (msg.type === 'relayFetch') {
    relayFetch(msg.payload || {})
      .then((r) => sendResponse({ result: r }))
      .catch((e) => sendResponse({ error: String((e && e.message) || e) }))
    return true
  }

  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage()
    sendResponse({ ok: true })
    return undefined
  }

  return undefined
})
