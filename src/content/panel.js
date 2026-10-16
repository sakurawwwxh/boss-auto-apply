/**
 * 内容脚本：在 BOSS 直聘岗位列表页上挂一个悬浮控制面板，并驱动自动投递主流程。
 *
 * 数据来源分两层：
 *  - DOM 只用来「枚举岗位」和读猎头/已沟通这类视觉线索（锚点 href 里的
 *    /job_detail/<encryptJobId>.html 是站点自己 SEO 依赖的，最不容易变）；
 *  - 筛选要用的数据（薪资/活跃度/是否已沟通/JD 正文）全部走 card.json 接口取，
 *    这样即使页面改版，筛选判定也不会跟着坏。
 */
;(function () {
  'use strict'

  var F = window.BossFilters
  var D = window.BossDefaults
  if (!F || !D) return

  // 面板挂载用的 id。刻意取一个中性的名字：BOSS 有安全脚本在做指纹采集与上报，
  // 没必要把 "boss-auto-apply" 这种自报家门的字符串留在它的 DOM 里。
  var HOST_ID = '__aa_panel'
  var API = {
    // 岗位列表：带搜索词走 search，不带（首页推荐流）走 recommend。两者都按 page 翻页。
    searchList: 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json',
    recommendList: 'https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json',
    // 岗位详情：列表接口不给活跃度和 JD 正文，只有这个接口给
    card: 'https://www.zhipin.com/wapi/zpgeek/job/card.json',
    addFriend: 'https://www.zhipin.com/wapi/zpgeek/friend/add.json',
    chatRemind: 'https://www.zhipin.com/wapi/zpCommon/actionLog/geek/chatremind.json'
  }
  var LIST_PAGE_SIZE = 30
  var MAX_LOG_LINES = 300

  /**
   * 扩展能力的取用口。Chrome 扩展版直接用 chrome.*；油猴版会在这段代码之前
   * 挂好 window.__BOSS_EXT__，提供等价实现（storage 用 GM/localStorage、token 读 cookie）。
   * 两边共用同一份面板代码，不会变成两套各自漂移的实现。
   */
  var EXT =
    (typeof window !== 'undefined' && window.__BOSS_EXT__) ||
    (typeof globalThis !== 'undefined' && globalThis.__BOSS_EXT__) || {
    storageGet: function (keys) {
      return chrome.storage.local.get(keys)
    },
    storageSet: function (obj) {
      return chrome.storage.local.set(obj)
    },
    storageRemove: function (key) {
      return chrome.storage.local.remove(key)
    },
    onStorageChanged: function (fn) {
      chrome.storage.onChanged.addListener(fn)
    },
    getToken: function () {
      return chrome.runtime.sendMessage({ type: 'getToken' }).then(function (r) {
        return (r && r.token) || null
      })
    },
    relayFetch: function (payload) {
      return chrome.runtime.sendMessage({ type: 'relayFetch', payload: payload })
    },
    openOptions: function () {
      return chrome.runtime.sendMessage({ type: 'openOptions' })
    }
  }

  /**
   * 标签页级稳定 id，用来做「同一时间只允许一个标签页在投递」的互斥。
   * 用 sessionStorage 而不是每次加载都随机：sessionStorage 是按标签页存的、跨整页重载保留，
   * 所以「切页面导致重载」之后本页能认出那把锁是自己的，不会自己把自己挡在门外。
   * （扩展和油猴两种形态都适用，不用去问后台要 tabId。）
   */
  var MY_TAB_ID = (function () {
    var KEY = '__aa_tab_id'
    try {
      var v = sessionStorage.getItem(KEY)
      if (!v) {
        v = 'tab-' + Math.random().toString(36).slice(2, 10)
        sessionStorage.setItem(KEY, v)
      }
      return v
    } catch (e) {
      return 'tab-' + Math.random().toString(36).slice(2, 10)
    }
  })()
  var LOCK_KEY = 'bossAutoApply.runLock'
  var HR_KEY = 'bossAutoApply.hrLedger'
  var LOCK_TTL_MS = 120000

  var state = {
    cfg: D.mergeConfig(null),
    stats: D.emptyStats(F.todayKey()),
    ui: null,
    running: false,
    aborted: false,
    token: null,
    tokenAt: 0,
    progress: '空闲',
    probed: false,
    resumeScheduled: false,
    userStopped: false,
    run: null,
    hrLedger: {},
    // 日志留在内存里，面板被卸载再挂回来时能补齐，不会丢掉半程的运行记录
    logs: []
  }

  /* ---------------------------------------------------------------- 存储 */

  async function loadState() {
    var raw = await EXT.storageGet([D.CONFIG_KEY, D.STATS_KEY, D.RUN_KEY, HR_KEY])
    state.cfg = D.sanitizeConfig(raw[D.CONFIG_KEY])
    state.stats = D.mergeStats(raw[D.STATS_KEY], F.todayKey())
    var run = raw[D.RUN_KEY]
    state.run = run && typeof run === 'object' ? run : null
    var ledger = raw[HR_KEY]
    state.hrLedger = ledger && typeof ledger === 'object' ? ledger : {}
  }

  async function saveConfig() {
    await EXT.storageSet({ [D.CONFIG_KEY]: state.cfg })
  }

  /**
   * 写统计时先读出来合并再写（appliedIds 取并集、计数取大），
   * 不要整份覆盖——否则另一个标签页刚写的计数会被抹掉。
   */
  async function persistStats() {
    var raw = await EXT.storageGet(D.STATS_KEY)
    var stored = D.mergeStats(raw[D.STATS_KEY], F.todayKey())
    var mine = state.stats
    if (stored.date === mine.date) {
      var ids = {}
      stored.appliedIds.concat(mine.appliedIds).forEach(function (id) {
        ids[id] = true
      })
      mine.appliedIds = Object.keys(ids).slice(-3000)
      mine.scanned = Math.max(stored.scanned, mine.scanned)
      mine.applied = Math.max(stored.applied, mine.applied)
      mine.skipped = Math.max(stored.skipped, mine.skipped)
      mine.failed = Math.max(stored.failed, mine.failed)
    }
    await EXT.storageSet({ [D.STATS_KEY]: mine })
  }

  var saveStatsTimer = null
  function saveStatsSoon() {
    if (saveStatsTimer) return
    saveStatsTimer = setTimeout(function () {
      saveStatsTimer = null
      persistStats()
    }, 400)
  }

  /* ------------------------------------------------------------ token/API */

  async function getToken(force) {
    var now = Date.now()
    if (!force && state.token && now - state.tokenAt < 60000) return state.token
    state.token = (await EXT.getToken()) || null
    state.tokenAt = now
    return state.token
  }

  /**
   * 请求 BOSS 自己的 wapi 接口。
   * 优先在页面上下文发（Origin/Referer 天然正确）；只有 GET 才允许兜到扩展上下文中继——
   * 投递是 POST，若"请求已到服务端但响应阶段才出错"，重发会重复发起一次沟通。
   */
  async function request(url, options) {
    options = options || {}
    var token = await getToken()
    if (!token) {
      state.aborted = true
      throw new Error('读不到 bst token：可能没登录 BOSS 直聘，或登录已过期')
    }

    var method = options.method || 'GET'
    var headers = { Zp_token: token }
    var raw
    try {
      var res = await fetch(url, { method: method, credentials: 'include', headers: headers })
      raw = { status: res.status, text: await res.text() }
    } catch (e) {
      if (method !== 'GET') throw new Error('请求发不出去：' + e.message)
      var relay = await EXT.relayFetch({ url: url, method: method, headers: headers })
      if (!relay || relay.error || !relay.result || relay.result.blocked) {
        throw new Error(
          '页面侧请求失败，且中继也不可用（' +
            ((relay && (relay.error || relay.result.reason)) || e.message) +
            '）。常见原因：网络不通、或该地址不在中继白名单内。'
        )
      }
      raw = { status: relay.result.status, text: relay.result.text }
    }

    if (raw.status === 401 || raw.status === 403) {
      state.token = null
      // 登录失效后继续跑只会把本页剩下的岗位全部刷成失败，直接停
      state.aborted = true
      throw new Error('登录态失效（HTTP ' + raw.status + '），刷新页面重登一次')
    }
    try {
      return JSON.parse(raw.text)
    } catch (e) {
      throw new Error('接口没返回 JSON（HTTP ' + raw.status + '）：' + raw.text.slice(0, 120))
    }
  }

  /* -------------------------------------------------------------- 页面读取 */

  function toUrl(href) {
    if (!href) return null
    try {
      return new URL(href, location.href)
    } catch (e) {
      return null
    }
  }

  /**
   * 是不是岗位列表页。先卡路径（列表页是 /web/geek/job 或 /web/geek/jobs），
   * 再卡有没有岗位链接——不卡路径的话，详情页的「相似职位」推荐位也会被当成本页岗位，
   * 那样点「开始」其实是在投推荐位。
   */
  /** 路径上是不是岗位列表页（/web/geek/job 或 /web/geek/jobs） */
  function isGeekJobPath() {
    return /^\/web\/geek\/jobs?(\/|$)/.test(location.pathname)
  }

  function hasJobLinks() {
    return document.querySelectorAll('a[href*="/job_detail/"]').length >= 1
  }

  function isJobListPage() {
    return isGeekJobPath() && hasJobLinks()
  }

  /** 只要是 BOSS 的 geek 后台页面（职位/推荐/消息/简历…）就算「同一片场地」 */
  function isGeekPage() {
    return /^\/web\/geek\//.test(location.pathname)
  }

  /** 枚举当前页的岗位卡片；只认主列表，侧栏「相似职位」不进队 */
  function collectCards() {
    var anchors = Array.prototype.slice.call(document.querySelectorAll('a[href*="/job_detail/"]'))
    var seen = {}
    var out = []
    anchors.forEach(function (a) {
      var url = toUrl(a.getAttribute('href'))
      if (!url) return
      var m = url.pathname.match(/\/job_detail\/([^/]+?)\.html$/)
      if (!m) return
      var id = m[1]
      if (seen[id]) return

      // 不能用 closest('[class*="job-card"]')：锚点自己的 class 里就常带
      // "job-card-left" 这类字样，closest 会把锚点自己选中。往上走，取最外层那一段。
      var card = null
      var node = a.parentElement
      while (node && node !== document.body) {
        if (/job-card|job-item|job-list-item/.test(node.className || '')) {
          card = node
        } else if (card) {
          break
        }
        node = node.parentElement
      }
      if (!card) {
        var li = a.closest('li')
        if (li && li.querySelector('[class*="job-name"], [class*="job-title"]')) card = li
      }
      // 不在任何卡片容器里的岗位链接（侧栏推荐位、页脚之类）不进队
      if (!card) return

      seen[id] = true
      out.push({
        id: id,
        href: url.href,
        securityId: url.searchParams.get('securityId'),
        lid: url.searchParams.get('lid'),
        card: card
      })
    })
    return out
  }

  function pickText(root, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = root.querySelector(selectors[i])
      if (el && el.textContent.trim()) return el.textContent.trim()
    }
    return ''
  }

  /** 卡片 DOM 上的补充线索（card.json 里没有的部分），只用来兜底和判断猎头 */
  function readHint(card) {
    if (!card) return {}
    var text = (card.innerText || '').replace(/\s+/g, ' ')
    return {
      jobName: pickText(card, ['.job-name', '.job-title', '[class*="job-name"]']),
      companyName: pickText(card, ['.company-name', '[class*="company-name"]']),
      cardText: text,
      goldHunter: /猎头/.test(text)
    }
  }

  /* ---------------------------------------------------------- 岗位列表接口 */

  /**
   * 从当前页面地址读搜索条件。用户在页面上选的筛选（城市/薪资/经验/学历…）本来就
   * 都在 query 里，直接沿用——插件不另开一套筛选 UI，避免两处口径打架。
   */
  function searchContext() {
    // 运行中必须用「开始那一刻冻结的条件」：切页面之后地址栏变了（比如变成 /web/geek/chat），
    // 如果继续按地址栏读，续跑时会莫名其妙从"搜索结果"漂移成"推荐流"。
    if (state.run && state.run.active && state.run.ctx) return state.run.ctx
    var q = new URLSearchParams(location.search)
    var ctx = {}
    var keys = ['query', 'city', 'experience', 'salary', 'degree', 'industry', 'scale', 'jobType', 'position']
    keys.forEach(function (k) {
      var v = q.get(k)
      if (v) ctx[k] = v
    })
    return ctx
  }

  function buildListUrl(page) {
    var ctx = searchContext()
    var url = new URL(ctx.query ? API.searchList : API.recommendList)
    if (ctx.query) {
      url.searchParams.set('query', ctx.query)
    } else {
      url.searchParams.set('encryptExpectId', '')
      url.searchParams.set('mixExpectType', '')
      url.searchParams.set('expectInfo', '')
    }
    ;['city', 'experience', 'salary', 'degree', 'industry', 'scale', 'jobType', 'position'].forEach(function (k) {
      if (ctx[k]) url.searchParams.set(k, ctx[k])
    })
    url.searchParams.set('page', String(page))
    url.searchParams.set('pageSize', String(LIST_PAGE_SIZE))
    url.searchParams.set('_', String(Date.now()))
    return url.toString()
  }

  async function fetchJobPage(page) {
    var data = await request(buildListUrl(page))
    if (data.code !== 0) throw new Error(F.stripTags(data.message) || 'code=' + data.code)
    var zp = data.zpData || {}
    return {
      jobs: zp.jobList || zp.list || [],
      hasMore: !!zp.hasMore,
      source: searchContext().query ? '搜索' : '推荐'
    }
  }

  /** 拉单个岗位的详情（含列表接口不提供的活跃度与 JD 正文） */
  async function fetchCardBy(params) {
    if (!params.securityId) throw new Error('缺少 securityId，取不了岗位详情')
    var url = new URL(API.card)
    url.searchParams.set('securityId', params.securityId)
    if (params.lid) url.searchParams.set('lid', params.lid)
    // 岗位 id 也带上，免得接口只靠 securityId 定位到另一个岗位（筛的是 A、投的是 B）
    if (params.jobId) url.searchParams.set('jobId', params.jobId)
    url.searchParams.set('_', String(Date.now()))

    var data = await request(url.toString())
    if (data.code !== 0) throw new Error(F.stripTags(data.message) || 'code=' + data.code)
    if (!data.zpData) return null
    return data.zpData.jobCard || data.zpData
  }

  /** DOM 兜底路径用：参数来自页面上的卡片链接 */
  function fetchCardByItem(item) {
    return fetchCardBy({ securityId: item.securityId, lid: item.lid, jobId: item.id })
  }

  /* ---------------------------------------------------------------- 翻页 */

  function isDisabled(el) {
    if (!el) return true
    if (el.disabled) return true
    if (el.getAttribute('aria-disabled') === 'true') return true
    var node = el
    for (var i = 0; i < 3 && node; i++) {
      if (/disabled/.test(node.className || '')) return true
      node = node.parentElement
    }
    return false
  }

  function findNextButton() {
    var byAttr = document.querySelector('a[ka="page-next"]')
    if (byAttr && !isDisabled(byAttr)) return byAttr

    var candidates = Array.prototype.slice.call(
      document.querySelectorAll('.options-pages a, .pagination a, [class*="page"] a, a, button')
    )
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i]
      if (/下一页/.test((el.textContent || '').trim()) && !isDisabled(el)) return el
    }

    var arrow = document.querySelector('.ui-icon-arrow-right')
    if (arrow && !isDisabled(arrow) && !isDisabled(arrow.parentElement)) return arrow
    return null
  }

  function waitForListChange(prevIds, timeoutMs) {
    var prev = {}
    prevIds.forEach(function (id) {
      prev[id] = true
    })
    return new Promise(function (resolve) {
      var started = Date.now()
      var timer = setInterval(function () {
        if (state.aborted) {
          clearInterval(timer)
          resolve(false)
          return
        }
        var now = collectCards()
        var changed = now.length !== prevIds.length
        if (!changed) {
          for (var i = 0; i < now.length; i++) {
            if (!prev[now[i].id]) {
              changed = true
              break
            }
          }
        }
        if (changed) {
          clearInterval(timer)
          resolve(true)
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer)
          resolve(false)
        }
      }, 300)
    })
  }

  /* ---------------------------------------------------------------- 投递 */

  /** DOM 路径：卡片链接给 securityId/lid，岗位 id 来自链接路径 */
  function applyTargetOfItem(item, card) {
    return {
      securityId: (card && card.securityId) || item.securityId,
      encryptJobId: (card && card.encryptJobId) || item.id,
      lid: item.lid || (card && card.lid)
    }
  }

  /** 接口路径：三个字段列表接口一次就给全了 */
  function applyTargetOfJob(job) {
    return { securityId: job.securityId, encryptJobId: job.encryptJobId, lid: job.lid }
  }

  /** target = { securityId, encryptJobId, lid }，两条路径都归一成这个形状 */
  async function submitApplication(target, extraParams) {
    var securityId = target.securityId
    var jobId = target.encryptJobId
    if (!securityId) throw new Error('岗位数据里没有 securityId，没法投')

    var url = new URL(API.addFriend)
    url.searchParams.set('securityId', securityId)
    url.searchParams.set('jobId', jobId)
    if (target.lid) url.searchParams.set('lid', target.lid)
    if (extraParams) {
      Object.keys(extraParams).forEach(function (k) {
        url.searchParams.set(k, String(extraParams[k]))
      })
    }
    return request(url.toString(), { method: 'POST' })
  }

  function classifyAddResult(res) {
    if (res && res.code === 0) return { status: 'ok' }
    var dialog = res && res.zpData && res.zpData.bizData && res.zpData.bizData.chatRemindDialog
    var content = F.stripTags((dialog && dialog.content) || (res && res.message) || '未知错误')
    if (/120\s*位/.test(content)) {
      return { status: 'confirm120', message: content, ba: dialog && dialog.ba }
    }
    if (/150\s*位/.test(content)) return { status: 'limit', message: content }
    if (/上限|已达/.test(content)) return { status: 'limit', message: content }
    if (/频繁|太快|稍后/.test(content)) return { status: 'rate', message: content }
    return { status: 'error', message: content }
  }

  async function confirmChatRemind(ba) {
    var url = new URL(API.chatRemind)
    url.searchParams.set('ba', ba)
    url.searchParams.set('action', 'addf-limit-popup-c')
    return request(url.toString(), { method: 'POST' })
  }

  function markApplied(id, label, message) {
    if (state.stats.appliedIds.indexOf(id) === -1) state.stats.appliedIds.push(id)
    state.stats.applied++
    state.stats.recent.push({
      ts: Date.now(),
      job: label,
      ok: true,
      msg: message
    })
    if (state.stats.recent.length > 50) state.stats.recent.shift()
    saveStatsSoon()
    render()
  }

  /* ---------------------------------------------------------------- 节奏 */

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms)
    })
  }

  function randBetween(min, max) {
    return Math.round(min + Math.random() * Math.max(0, max - min))
  }

  /** 可以被打断的等待：点「停止」不用等这轮延时跑完 */
  async function interruptibleSleep(ms) {
    var waited = 0
    while (waited < ms && !state.aborted) {
      var step = Math.min(200, ms - waited)
      await sleep(step)
      waited += step
    }
  }

  /* -------------------------------------------------------------- 单条处理 */

  /**
   * 真正投一次，并处理接口返回：成功就记账，撞上限就停，被限流就歇一会儿。
   * 两条路径（接口 / DOM 兜底）共用。
   */
  async function deliverAndRecord(target, id, label, meta) {
    meta = meta || {}

    // 用本轮开始时冻结的模式，不是「每次投之前现读配置」：
    // 否则运行中（甚至从工具栏弹窗/另一个标签页）把试运行关掉，这一轮会当场变成真投。
    var sessionDryRun =
      state.run && typeof state.run.dryRun === 'boolean' ? state.run.dryRun : !!state.cfg.dryRun
    if (sessionDryRun) {
      log(
        'dry',
        '[试运行] 命中条件：' + label + '｜' +
          (meta.salaryDesc || '薪资未知') + '｜' + (meta.activeTimeDesc || '活跃度未知')
      )
      await interruptibleSleep(randBetween(300, 700))
      return false
    }

    state.progress = '投递中：' + label
    render()

    var res
    try {
      res = await submitApplication(target)
    } catch (e) {
      state.stats.failed++
      log('error', '投递请求失败 ' + label + '｜' + e.message)
      saveStatsSoon()
      return false
    }
    // 请求在途时被点了「停止」，返回结果不该再生效
    if (state.aborted) return false

    var result = classifyAddResult(res)

    if (result.status === 'confirm120') {
      if (state.aborted) return false
      if (!state.cfg.limits.autoConfirm120) {
        log('warn', '触发「今日已沟通 120 位」确认弹窗，已停止：' + result.message)
        log('warn', '（设置里可以打开「自动确认 120 上限提示」，或明天再来）')
        state.aborted = true
        return false
      }
      log('warn', '命中 120 位确认弹窗，自动确认后重试：' + result.message)
      try {
        await confirmChatRemind(result.ba)
        result = classifyAddResult(await submitApplication(target, { cid: 1 }))
      } catch (e) {
        state.stats.failed++
        log('error', '确认 120 弹窗失败：' + e.message)
        saveStatsSoon()
        return false
      }
    }

    if (result.status === 'ok') {
      markApplied(id, label, '投递成功')
      log('ok', '已投递 ' + label)
    } else if (result.status === 'limit') {
      log('warn', 'BOSS 提示今日沟通已达上限，停止：' + result.message)
      state.aborted = true
      return false
    } else if (result.status === 'rate') {
      // 这个岗位没投出去，也要记一笔 —— 否则统计里「扫描数」比「投+跳+失」大，
      // 用户会以为漏投了
      state.stats.failed++
      log('warn', '被限流，该岗位未投出，暂停 30 秒：' + result.message)
      saveStatsSoon()
      await interruptibleSleep(30000)
      return false
    } else {
      state.stats.failed++
      log('error', '投递失败 ' + label + '｜' + result.message)
      saveStatsSoon()
      return false
    }

    var gap = randBetween(state.cfg.limits.delayMinMs, state.cfg.limits.delayMaxMs)
    state.progress = '等待 ' + (gap / 1000).toFixed(1) + 's 后继续'
    render()
    await interruptibleSleep(gap)
    return true
  }

  /**
   * 接口路径的单条处理：两段筛选。
   * 第一段只用列表接口就给全的字段（岗位名/公司/薪资/城市/是否已沟通/猎头），零额外请求；
   * 过了第一段才去拉 card.json 拿活跃度和 JD 正文，跑第二段。
   */
  async function processJob(job) {
    var id = job.encryptJobId
    if (!id) return
    if (state.stats.appliedIds.indexOf(id) !== -1) return

    state.stats.scanned++
    var label = [job.jobName, job.brandName].filter(Boolean).join(' @ ') || id
    var hint = { goldHunter: job.goldHunter }

    var cheapVerdict = F.decide(job, state.cfg.filters, hint, { cheap: true })
    if (!cheapVerdict.ok) {
      state.stats.skipped++
      log('skip', '跳过 ' + label + '｜' + cheapVerdict.reason)
      saveStatsSoon()
      render()
      return
    }

    // 同一个 HR 已经打过招呼就不再打扰（放在拉详情之前，省一次请求）
    var hrDays = state.cfg.filters.skipSameHr === false ? 0 : Number(state.cfg.filters.sameHrDays)
    if (!(hrDays >= 0)) hrDays = 30
    var greetedBefore = hrAlreadyGreeted(job.encryptBossId, hrDays)
    if (greetedBefore) {
      state.stats.skipped++
      log('skip', '跳过 ' + label + '｜同一招聘者 ' + greetedBefore + '已打过招呼，不重复打扰')
      saveStatsSoon()
      render()
      return
    }

    var card = null
    try {
      card = await fetchCardBy({ securityId: job.securityId, lid: job.lid, jobId: id })
    } catch (e) {
      // 拿不到详情就跳过这个岗位。第二道筛选（活跃度 / JD 正文排除词）依赖详情，
      // 静默放行等于用户设的条件失效；DOM 兜底路径也是这么处理的。
      state.stats.failed++
      log('error', '取详情失败，跳过：' + label + '｜' + e.message)
      saveStatsSoon()
      return
    }
    if (state.aborted) return

    if (!card) {
      state.stats.failed++
      log('error', '详情为空，跳过：' + label)
      saveStatsSoon()
      return
    }

    var fullVerdict = F.decide(card, state.cfg.filters, hint)
    if (!fullVerdict.ok) {
      state.stats.skipped++
      log('skip', '跳过 ' + label + '｜' + fullVerdict.reason)
      saveStatsSoon()
      render()
      return
    }

    var delivered = await deliverAndRecord(applyTargetOfJob(job), id, label, card)
    if (delivered) noteHrGreeted(job.encryptBossId, hrDays)
  }

  /** DOM 兜底路径的单条处理（接口取不到列表时才用） */
  async function processItem(item) {
    if (state.stats.appliedIds.indexOf(item.id) !== -1) return

    state.stats.scanned++
    var card
    try {
      card = await fetchCardByItem(item)
    } catch (e) {
      state.stats.failed++
      log('error', '取岗位详情失败（' + item.id + '）：' + e.message)
      saveStatsSoon()
      return
    }
    if (state.aborted) return

    if (!card) {
      state.stats.failed++
      log('error', '岗位详情为空（' + item.id + '）')
      saveStatsSoon()
      return
    }

    var hint = readHint(item.card)
    var label =
      [card.jobName || hint.jobName, card.brandName || hint.companyName].filter(Boolean).join(' @ ') || item.id

    var verdict = F.decide(card, state.cfg.filters, hint)
    if (!verdict.ok) {
      state.stats.skipped++
      log('skip', '跳过 ' + label + '｜' + verdict.reason)
      saveStatsSoon()
      render()
      return
    }

    await deliverAndRecord(applyTargetOfItem(item, card), item.id, label, card)
  }

  /* ---------------------------------------------------------------- 主循环 */

  async function readLock() {
    var raw = await EXT.storageGet(LOCK_KEY)
    return raw[LOCK_KEY] || null
  }

  /* ------------------------------------------------------ 一轮投递的会话 */

  function newRunSession() {
    return {
      active: true,
      startedAt: Date.now(),
      tabId: MY_TAB_ID,
      pageNo: 1,
      seen: [],
      seenHr: [],
      ctx: searchContext(),
      dryRun: !!state.cfg.dryRun
    }
  }

  // 一轮还在跑的时候每 20 秒刷一次「最近活动时间」（心跳）。这样「重载/切页面」能续上，
  // 而「关掉标签页过一会儿再恢复」不会 —— 因为没人替它刷心跳了。
  var RUN_LIVE_WINDOW_MS = 90000

  function runSessionFresh(run) {
    if (!run || !run.active) return false
    var now = Date.now()
    var lastSeen = run.updatedAt || run.startedAt || 0
    return now - lastSeen < RUN_LIVE_WINDOW_MS && now - (run.startedAt || 0) < D.RUN_RESUME_WINDOW_MS
  }

  /**
   * 能不能在这张页面上自动续跑。要求是「本标签页自己的会话」：
   * MY_TAB_ID 来自 sessionStorage（跨重载不变、新标签页是新值），
   * 所以重载/切页面能续上，而新开的标签页不会去接别人那轮。
   */
  var resumeTimer = null
  var heartbeatTimer = null

  function canAutoResume() {
    if (state.userStopped) return false
    if (!runSessionFresh(state.run)) return false
    return !state.run.tabId || state.run.tabId === MY_TAB_ID
  }

  async function saveRun() {
    if (!state.run) return
    var payload = {}
    payload[D.RUN_KEY] = {
      active: !!state.run.active,
      startedAt: state.run.startedAt,
      tabId: state.run.tabId,
      pageNo: state.run.pageNo,
      seen: state.run.seen.slice(-2000),
      seenHr: (state.run.seenHr || []).slice(-2000),
      ctx: state.run.ctx,
      dryRun: state.run.dryRun,
      updatedAt: Date.now()
    }
    await EXT.storageSet(payload)
  }

  /**
   * 招聘者台账：记录「哪个 HR（encryptBossId）什么时候被打过招呼」。
   * 同一个 HR 往往挂着好几个岗位，只按岗位 id 去重的话，他会连收好几条一样的招呼语 ——
   * 这是最容易被当成骚扰举报的形态。所以按 HR 单独记一笔，默认 N 天内只打一次。
   */
  /** 把「多久以前」说成人话：刚刚 / 今天 / N 天前 */
  function humanAgo(ms) {
    if (ms < 60 * 60 * 1000) return '刚才'
    if (ms < 24 * 60 * 60 * 1000) return '今天'
    return Math.round(ms / 86400000) + ' 天前'
  }

  function hrAlreadyGreeted(bossId, days) {
    if (!bossId) return null
    if (state.run && state.run.seenHr && state.run.seenHr.indexOf(bossId) !== -1) return '本轮'
    if (days > 0) {
      var last = state.hrLedger[bossId]
      if (last && Date.now() - last < days * 86400000) {
        return humanAgo(Date.now() - last)
      }
    }
    return null
  }

  function noteHrGreeted(bossId, days) {
    if (!bossId) return
    if (state.run && state.run.seenHr && state.run.seenHr.indexOf(bossId) === -1) {
      state.run.seenHr.push(bossId)
      if (state.run.seenHr.length > 2000) state.run.seenHr = state.run.seenHr.slice(-2000)
      saveRunSoon()
    }
    state.hrLedger[bossId] = Date.now()
    // 顺手把过期的清掉，避免台账无限长大
    var keepMs = Math.max(days, 90) * 86400000
    var now = Date.now()
    var keys = Object.keys(state.hrLedger)
    if (keys.length > 4000) {
      keys.forEach(function (k) {
        if (now - state.hrLedger[k] > keepMs) delete state.hrLedger[k]
      })
    }
    saveHrLedgerSoon()
  }

  var hrLedgerTimer = null
  function saveHrLedgerSoon() {
    if (hrLedgerTimer) return
    hrLedgerTimer = setTimeout(function () {
      hrLedgerTimer = null
      var payload = {}
      payload[HR_KEY] = state.hrLedger
      var p = EXT.storageSet(payload)
      if (p && p.catch) p.catch(function () {})
    }, 800)
  }

  var saveRunTimer = null
  function saveRunSoon() {
    if (saveRunTimer) return
    saveRunTimer = setTimeout(function () {
      saveRunTimer = null
      saveRun().catch(function () {})
    }, 300)
  }

  /** 两个标签页同时跑会互相覆盖统计，也各自按自己内存里的上限判定，所以互斥掉 */
  async function acquireLock() {
    var lock = await readLock()
    if (lock && lock.tabId !== MY_TAB_ID && Date.now() - lock.ts < LOCK_TTL_MS) return false
    await EXT.storageSet({ [LOCK_KEY]: { tabId: MY_TAB_ID, ts: Date.now() } })
    return true
  }

  function touchLock() {
    EXT.storageSet({ [LOCK_KEY]: { tabId: MY_TAB_ID, ts: Date.now() } })
  }

  async function releaseLock() {
    var lock = await readLock()
    if (lock && lock.tabId === MY_TAB_ID) await EXT.storageRemove(LOCK_KEY)
  }

  async function run(opts) {
    opts = opts || {}
    if (state.running) return
    state.running = true
    state.aborted = false
    state.resumeScheduled = false
    state.progress = opts.resume ? '继续上一轮…' : '启动中…'
    render()

    var locked = false
    var started = false
    try {
      // 续跑是"接着刚才那轮"，它本来就可以在任何 geek 页面上跑（主流程走接口、不依赖列表 DOM）；
      // 手动开新一轮才要求站在岗位列表页上，免得用户在消息页误点。
      if (!opts.resume && !isGeekJobPath()) {
        log('error', '当前页面不是岗位列表页（' + location.pathname + '），请到「职位」列表页再用。')
        return
      }

      var token = await getToken(true)
      if (!token) {
        log('error', '读不到 bst token，请先确认已登录 BOSS 直聘')
        return
      }

      locked = await acquireLock()
      if (!locked) {
        log('warn', '另一个标签页正在投递中，本次不启动。同一个浏览器里同一时间只跑一个页面。')
        return
      }

      // 起跑前先把别处写进来的计数读回来，别拿可能过期的内存值当基准
      var rawStats = await EXT.storageGet(D.STATS_KEY)
      state.stats = D.mergeStats(rawStats[D.STATS_KEY], F.todayKey())

      started = true
      setTabTitle('启动中')
      // 心跳：跑着的这一轮每 20 秒刷新「最近活动时间」并续锁。
      // 「重载/切页面」能续上靠的就是它；关掉标签页后没人刷，超过 90 秒就不再自动续。
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = setInterval(function () {
        if (!state.run || !state.run.active) return
        state.run.updatedAt = Date.now()
        touchLock()
        saveRunSoon()
      }, 20000)
      if (opts.resume && state.run && state.run.active) {
        log(
          'info',
          '接着上一轮跑：从第 ' + state.run.pageNo + ' 页继续，本轮已处理过的 ' +
            state.run.seen.length + ' 个岗位不会重复投'
        )
      } else {
        state.run = newRunSession()
        await saveRun()
      }

      log('info', state.cfg.dryRun ? '开始（试运行，不会真的投递）' : '开始（正式投递）')
      await runLoop()
    } catch (e) {
      log('error', '运行中断：' + (e && e.message ? e.message : String(e)))
    } finally {
      // 不管正常结束、提前 return 还是抛错，都要把 running / 锁 / 统计收干净，
      // 否则「开始」按钮会永久置灰，或者把锁留给下一个标签页
      state.running = false
      if (state.run) {
        state.run.active = false
        state.run.finishedAt = Date.now()
      }
      // 先把挂起的延迟写取消掉，再落盘：否则那个延迟写可能在这次之后才落，
      // 把 active:true 又写回去，导致下次加载页面时莫名其妙再跑一轮。
      if (saveRunTimer) {
        clearTimeout(saveRunTimer)
        saveRunTimer = null
      }
      saveRun().catch(function () {})
      if (started) {
        state.progress = state.aborted ? '已停止' : '已完成'
        setTabTitle(
          '投' + state.stats.applied + '/扫' + state.stats.scanned + '/跳' + state.stats.skipped +
            '/失' + state.stats.failed + (state.aborted ? ' 已停' : ' 完')
        )
        log(
          'info',
          '本轮结束：扫描 ' + state.stats.scanned + '，投递 ' + state.stats.applied +
            '，跳过 ' + state.stats.skipped + '，失败 ' + state.stats.failed
        )
        await persistStats().catch(function () {})
      } else {
        state.progress = '空闲'
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      if (locked) await releaseLock().catch(function () {})
      setTabTitle('')
      render()
    }
  }

  /**
   * 主循环：走接口。一次拿一整页岗位（默认 30 个），按 page 翻页，
   * 完全不依赖页面 DOM —— BOSS 前端改版不影响这里。
   */
  async function runLoop() {
    if (!state.run) state.run = newRunSession()
    // 本轮已处理过的岗位（跨重载保留）：既防「一次运行内重复投」，也防「重载续跑后重复投」
    var seen = {}
    state.run.seen.forEach(function (id) {
      seen[id] = true
    })

    while (!state.aborted) {
      var pageNo = state.run.pageNo
      if (pageNo > state.cfg.limits.maxPages) {
        log('info', '已达翻页上限 ' + state.cfg.limits.maxPages + ' 页，停止。')
        return
      }

      state.progress = '读取第 ' + pageNo + ' 页岗位…'
      render()

      var batch
      try {
        batch = await fetchJobPage(pageNo)
      } catch (e) {
        if (state.aborted) return
        if (pageNo === 1) {
          // 第一页就失败：退回按页面上的岗位卡片投，别让整个功能不可用
          log('warn', '接口取岗位列表失败（' + e.message + '），退回按页面上的岗位卡片投。')
          await runDomLoop()
          return
        }
        log('error', '取第 ' + pageNo + ' 页失败：' + e.message + '，停止。')
        return
      }

      if (!batch.jobs.length) {
        log(
          'info',
          pageNo === 1
            ? '接口返回 0 个岗位。搜索页说明这组条件没结果，也可以看看页面上选的筛选条件。'
            : '没有更多岗位了，结束。'
        )
        return
      }

      state.progress = '第 ' + pageNo + ' 页（' + batch.source + '），共 ' + batch.jobs.length + ' 个岗位'
      log('info', state.progress)
      setTabTitle('投' + state.stats.applied + '/扫' + state.stats.scanned + ' 第' + pageNo + '页')
      render()

      for (var i = 0; i < batch.jobs.length; i++) {
        if (state.aborted) return
        var job = batch.jobs[i]
        var id = job.encryptJobId
        if (!id || seen[id]) continue
        seen[id] = true
        state.run.seen.push(id)
        // 上限跟「最多翻多少页 × 每页多少个」对齐：原来固定 2000，页数拉大时
        // 最早的岗位会被挤出去，重载续跑就可能被重投
        var seenCap = Math.min(20000, state.cfg.limits.maxPages * LIST_PAGE_SIZE + 200)
        state.run.seen = state.run.seen.slice(-seenCap)
        saveRunSoon()

        if (state.stats.applied >= state.cfg.limits.dailyMax) {
          log('warn', '已达今日上限 ' + state.cfg.limits.dailyMax + ' 个，停止。')
          state.aborted = true
          return
        }
        touchLock()
        await processJob(job)
      }

      if (!batch.hasMore) {
        log('info', '没有更多岗位了，结束。')
        return
      }
      state.run.pageNo = pageNo + 1
      saveRunSoon()
      await interruptibleSleep(randBetween(1000, 2200))
    }
  }

  /** 兜底：接口取不到列表时，按页面上的岗位卡片走，用「下一页」按钮翻页 */
  async function runDomLoop() {
    var page = 0
    while (!state.aborted) {
      if (!isJobListPage()) {
        log('warn', '当前页面上没有岗位卡片，停止。')
        state.aborted = true
        return
      }

      var items = collectCards()
      if (!items.length) {
        log('warn', '这一页没找到岗位卡片，停止。可能页面结构变了。')
        return
      }

      state.progress = '第 ' + (page + 1) + ' 页，共 ' + items.length + ' 个岗位'
      log('info', state.progress)
      render()

      for (var i = 0; i < items.length; i++) {
        if (state.aborted) return
        if (state.stats.applied >= state.cfg.limits.dailyMax) {
          log('warn', '已达今日上限 ' + state.cfg.limits.dailyMax + ' 个，停止。')
          state.aborted = true
          return
        }
        touchLock()
        await processItem(items[i])
      }

      page++
      if (page >= state.cfg.limits.maxPages) {
        log('info', '已达翻页上限 ' + state.cfg.limits.maxPages + ' 页，停止。')
        return
      }

      var next = findNextButton()
      if (!next) {
        log('info', '没有下一页了，结束。')
        return
      }
      var prevIds = items.map(function (it) {
        return it.id
      })
      state.progress = '翻到第 ' + (page + 1) + ' 页'
      render()
      next.click()
      var moved = await waitForListChange(prevIds, 10000)
      if (state.aborted || !moved) {
        if (!state.aborted) log('warn', '点了下一页但列表没变化，停止。')
        return
      }
      await interruptibleSleep(randBetween(1000, 2200))
    }
  }

  function stop() {
    state.aborted = true
    // 续跑宽限期（重载后那几秒）里点「停止」也必须真的停：
    // 只设 aborted 是不够的 —— run() 一开始会把 aborted 重置成 false，
    // 于是几秒后它又自己跑起来，而用户以为已经停了。
    state.resumeScheduled = false
    state.userStopped = true
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    if (state.run && state.run.active) {
      state.run.active = false
      state.run.finishedAt = Date.now()
      saveRun().catch(function () {})
    }
    state.progress = '正在停止…'
    render()
  }

  /* -------------------------------------------------------------- 自动探测 */

  /**
   * 页面一加载就跑一次轻量探测：路径对不对、token 有没有、接口能不能取到岗位列表。
   * 结论写进标签页标题，日志里也留一行。
   * 只有一个接口请求，用的是页面自己也在调的同一个接口。
   */
  async function probe() {
    if (state.probed || state.running) return
    state.probed = true

    var result = { path: location.pathname, pathOk: isGeekJobPath(), tokenOk: false, listCount: null, error: null }
    var parts = [result.pathOk ? '路径OK' : '路径不符']
    var token = await getToken(true).catch(function () {
      return null
    })
    result.tokenOk = !!token
    parts.push(token ? 'tokenOK' : 'token读不到')
    if (token) {
      try {
        var batch = await fetchJobPage(1)
        result.listCount = batch.jobs.length
        parts.push('列表' + batch.jobs.length)
      } catch (e) {
        result.error = String(e.message).slice(0, 200)
        parts.push('接口失败:' + result.error.slice(0, 26))
      }
    }
    state.probeResult = result
    setTabTitle('就绪 ' + parts.join(' '))
    log('info', '自动探测：' + parts.join(' · ') + '（标签页标题上也有一份）')
  }

  /* ------------------------------------------------------------------ 自检 */

  /**
   * 把"现场长什么样"打成一份报告，用来校准选择器和接口。
   * 它只读页面、只调一个 card.json，不投递任何东西。
   */
  async function selfCheck() {
    var scTitle = []
    log('info', '========== 环境自检开始 ==========')
    log('info', '路径：' + location.pathname + location.search.slice(0, 80))
    scTitle.push(isGeekJobPath() ? '路径OK' : '路径不符')
    log('info', '路径是岗位列表页：' + isGeekJobPath() + ' ｜ 页面上有岗位链接：' + hasJobLinks())
    log('info', 'isJobListPage()（能开跑吗）→ ' + isJobListPage())
    log('info', '搜索条件（从当前地址读）：' + JSON.stringify(searchContext()))

    var selectors = [
      'a[href*="/job_detail/"]',
      '.job-card-wrapper',
      '[class*="job-card"]',
      '[class*="job-name"]',
      '.start-chat-btn',
      '.job-list-wrapper',
      'li'
    ]
    selectors.forEach(function (sel) {
      log('info', '选择器 ' + sel + ' → ' + document.querySelectorAll(sel).length + ' 个')
    })

    var items = collectCards()
    log('info', 'collectCards() 认出 ' + items.length + ' 个岗位')

    var anyAnchor = document.querySelector('a[href*="/job_detail/"]')
    if (anyAnchor) {
      var chain = []
      var node = anyAnchor
      for (var i = 0; i < 5 && node; i++) {
        chain.push(
          node.tagName.toLowerCase() +
            (node.className ? '.' + String(node.className).trim().split(/\s+/).join('.') : '')
        )
        node = node.parentElement
      }
      log('info', '首个岗位链接的祖先链：' + chain.join('  <  '))
      log('info', '首个 href：' + String(anyAnchor.href).slice(0, 140))
    } else {
      log('warn', '页面上一个 /job_detail/ 链接都没有')
    }

    if (items[0]) {
      var hint = readHint(items[0].card)
      log('info', '首个卡片容器：' + (items[0].card ? items[0].card.tagName.toLowerCase() + '.' + items[0].card.className : '（没有）'))
      log('info', '卡片 DOM 线索：岗位名「' + hint.jobName + '」公司「' + hint.companyName + '」含猎头字样=' + hint.goldHunter)
    }

    log('info', '下一页按钮：' + (findNextButton() ? '找到' : '没找到'))

    var token = await getToken(true).catch(function () {
      return null
    })
    log('info', 'token（bst cookie）：' + (token ? '读到，长度 ' + token.length : '读不到'))
    scTitle.push(token ? 'tokenOK' : 'token读不到')

    if (items[0]) {
      try {
        var card = await fetchCardByItem(items[0])
        if (!card) {
          log('warn', 'card.json 返回了空数据')
        } else {
          log('info', 'card.json 字段清单：' + Object.keys(card).join(', '))
          log(
            'info',
            '岗位=' + card.jobName + ' ｜ 公司=' + card.brandName + ' ｜ 薪资=' + card.salaryDesc +
              ' ｜ 活跃=' + card.activeTimeDesc + ' ｜ 已沟通标识=' + card.friendStatus +
              ' ｜ securityId=' + (card.securityId ? '有' : '无')
          )
          var verdict = F.decide(card, state.cfg.filters, readHint(items[0].card))
          log('info', '按当前筛选条件判定：' + (verdict.ok ? '会投递' : '跳过（' + verdict.reason + '）'))
        }
      } catch (e) {
        log('error', 'card.json 取详情失败：' + e.message)
      }
    }

    // 接口这一层才是主路径，最该先看
    log('info', '—— 接口取列表（主路径）——')
    try {
      var batch = await fetchJobPage(1)
      scTitle.push('列表' + batch.jobs.length)
      log('info', '接口取列表成功（来源：' + batch.source + '）→ ' + batch.jobs.length + ' 个岗位，hasMore=' + batch.hasMore)
      if (batch.jobs[0]) {
        var j0 = batch.jobs[0]
        log(
          'info',
          '首条：' + j0.jobName + ' @ ' + j0.brandName + '｜' + j0.salaryDesc +
            '｜contact=' + j0.contact + '｜goldHunter=' + j0.goldHunter + '｜jobValidStatus=' + j0.jobValidStatus
        )
        var cheap = F.decide(j0, state.cfg.filters, { goldHunter: j0.goldHunter }, { cheap: true })
        log('info', '首条第一道判定：' + (cheap.ok ? '通过（会去拉详情跑第二道）' : '跳过（' + cheap.reason + '）'))
      }
    } catch (e) {
      scTitle.push('接口失败:' + String(e.message).slice(0, 26))
      log('error', '接口取列表失败：' + e.message)
      log('error', '（接口失败时会退回按页面上的岗位卡片投，所以下面那几行 DOM 信息才有意义）')
    }

    log('info', '—— 页面 DOM（只在接口失败时当兜底用）——')
    var body = document.body ? document.body.innerText.replace(/\s+/g, ' ') : ''
    log('info', '正文前 140 字：' + body.slice(0, 140))
    log('info', '========== 自检结束（点「复制日志」发我）==========')
    // 标题里放一份最关键的结论：远程看现场就靠这一行
    scTitle.push('卡片' + collectCards().length)
    setTabTitle('自检 ' + scTitle.join(' '))
  }

  function copyLog() {
    var text = state.logs
      .map(function (e) {
        return e.text
      })
      .join('\n')
    if (!text) {
      log('warn', '日志是空的')
      return
    }
    if (!navigator.clipboard) {
      log('error', '这个环境没有剪贴板接口，请手动选中日志文本复制')
      return
    }
    navigator.clipboard.writeText(text).then(
      function () {
        log('ok', '日志已复制到剪贴板')
      },
      function (e) {
        log('error', '复制失败（' + ((e && e.message) || e) + '），请手动选中日志文本复制')
      }
    )
  }

  /* ------------------------------------------------------------------ UI */

  var PANEL_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    '.panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:340px;',
    'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    'color:#1f2329;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06);',
    'overflow:hidden;display:flex;flex-direction:column;max-height:min(560px,calc(100vh - 32px))}',
    'header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#00a6a7;color:#fff;',
    'font-weight:600;user-select:none;cursor:default}',
    'header .dot{width:8px;height:8px;border-radius:50%;background:#b8e6e6;flex:none}',
    'header .dot.on{background:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.35)}',
    'header .dot.err{background:#ffd0d0}',
    'header .title{flex:1;font-size:13px}',
    'header button{background:transparent;border:0;color:#fff;font-size:16px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:4px}',
    'header button:hover{background:rgba(255,255,255,.18)}',
    '.body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px;overflow:auto}',
    '.body.collapsed{display:none}',
    '.status{font-size:12px;color:#646a73;background:#f5f6f7;border-radius:6px;padding:6px 8px;word-break:break-all}',
    '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center}',
    '.grid div{background:#f5f6f7;border-radius:6px;padding:6px 2px}',
    '.grid b{display:block;font-size:16px;font-weight:600}',
    '.grid span{font-size:11px;color:#646a73}',
    '.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
    'button.act{border:1px solid #d0d3d6;background:#fff;color:#1f2329;border-radius:6px;padding:6px 10px;',
    'font-size:12px;cursor:pointer;font-family:inherit}',
    'button.act:hover{border-color:#00a6a7;color:#00a6a7}',
    'button.act:disabled{opacity:.45;cursor:not-allowed}',
    'button.primary{background:#00a6a7;border-color:#00a6a7;color:#fff}',
    'button.primary:hover{background:#00904f;border-color:#008f90;color:#fff}',
    'button.danger{border-color:#e6a6a6;color:#c0392b}',
    'label.switch{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#646a73;cursor:pointer;margin-left:auto}',
    '.warn{font-size:12px;color:#a8621a;background:#fff7e6;border:1px solid #ffe0a3;border-radius:6px;padding:6px 8px}',
    '.warn.hidden{display:none}',
    '.log{font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;background:#1f2329;color:#d6dae0;',
    'border-radius:6px;padding:8px;height:190px;overflow:auto;white-space:pre-wrap;word-break:break-all}',
    '.log .l-ok{color:#7ee2a8}',
    '.log .l-skip{color:#8a919b}',
    '.log .l-warn{color:#ffd479}',
    '.log .l-error{color:#ff8a8a}',
    '.log .l-dry{color:#8fd0ff}',
    '.log .t{color:#5c6470}',
    'a.link{color:#00a6a7;font-size:12px;text-decoration:none;cursor:pointer}',
    'a.link:hover{text-decoration:underline}',
    '.spacer{flex:1}',
    '@media (prefers-color-scheme:dark){',
    '.panel{background:#22262b;color:#e6e8ea;box-shadow:0 8px 32px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08)}',
    '.status,.grid div{background:#2c3138}',
    '.grid span,.status,label.switch{color:#9aa1ab}',
    'button.act{background:#2c3138;border-color:#3c434b;color:#e6e8ea}',
    '}',
    '@media print{.panel{display:none}}'
  ].join('')

  var PANEL_HTML = [
    '<div class="panel">',
    '<header>',
    '<span class="dot" data-el="dot"></span>',
    '<span class="title">BOSS 自动投递</span>',
    '<button data-act="collapse" title="收起/展开">–</button>',
    '</header>',
    '<div class="body" data-el="body">',
    '<div class="status" data-el="status">空闲</div>',
    '<div class="grid">',
    '<div><b data-el="applied">0</b><span>已投递</span></div>',
    '<div><b data-el="scanned">0</b><span>已扫描</span></div>',
    '<div><b data-el="skipped">0</b><span>跳过</span></div>',
    '<div><b data-el="failed">0</b><span>失败</span></div>',
    '</div>',
    '<div class="row">',
    '<button class="act primary" data-act="run">开始</button>',
    '<button class="act danger" data-act="stop" disabled>停止</button>',
    '<button class="act" data-act="selfcheck">自检</button>',
    '<label class="switch"><input type="checkbox" data-act="dryrun"><span>试运行</span></label>',
    '</div>',
    '<div class="row">',
    '<a class="link" data-act="options">设置筛选条件与上限 →</a>',
    '<span class="spacer"></span>',
    '<a class="link" data-act="copy">复制日志</a>',
    '<a class="link" data-act="clear">清空</a>',
    '</div>',
    '<div class="warn hidden" data-el="warn"></div>',
    '<div class="log" data-el="log"></div>',
    '</div>',
    '</div>'
  ].join('')

  /**
   * 标签页标题会带上当前状态。
   * 不是花活：BOSS 页面在自动化环境里会被它自己 window.close() 掉，所以想远程看现场
   * 只剩「读标签页标题」这一条不需要碰页面的路（`bsk tab list` 就能看到）。
   * 顺带也是个真有用的功能：切到别的标签页也能瞟见跑到哪了。
   */
  var originalTitle = null
  function setTabTitle(text) {
    try {
      if (originalTitle === null) originalTitle = document.title
      document.title = text ? '[' + text + '] ' + originalTitle : originalTitle
    } catch (e) {
      /* 改标题失败不影响功能 */
    }
  }

  /**
   * 把探测结论和最近日志落一份到 storage，节流 1 秒。
   * 用途：排查时可以直接从浏览器 profile 的 Local Extension Settings 里读出来，
   * 不需要打开 DevTools、也不需要人工复制日志。
   */
  var diagTimer = null
  function persistDiagSoon() {
    if (diagTimer) return
    diagTimer = setTimeout(function () {
      diagTimer = null
      var payload = {}
      payload[D.DIAG_KEY] = {
        at: Date.now(),
        url: location.href.slice(0, 200),
        probe: state.probeResult || null,
        log: state.logs.slice(-80).map(function (e) {
          return e.text
        })
      }
      var p = EXT.storageSet(payload)
      if (p && p.catch) p.catch(function () {})
    }, 1000)
  }

  function log(level, text) {
    var t = new Date()
    var pad = function (n) {
      return n < 10 ? '0' + n : '' + n
    }
    var entry = {
      level: level,
      text: '[' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) + '] ' + text
    }
    state.logs.push(entry)
    while (state.logs.length > MAX_LOG_LINES) state.logs.shift()
    appendLogLine(entry)
    // 同时打一份到 console，方便在 DevTools 里翻
    try {
      console.log('[boss-auto-apply] ' + entry.text)
    } catch (e) {
      /* 忽略 */
    }
    persistDiagSoon()
  }

  function appendLogLine(entry) {
    if (!state.ui) return
    var box = state.ui.log
    var line = document.createElement('div')
    line.className = 'l-' + entry.level
    line.textContent = entry.text
    var nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24
    box.appendChild(line)
    while (box.childNodes.length > MAX_LOG_LINES) box.removeChild(box.firstChild)
    if (nearBottom) box.scrollTop = box.scrollHeight
  }

  function render() {
    var ui = state.ui
    if (!ui) return
    ui.status.textContent = state.progress
    ui.applied.textContent = state.stats.applied
    ui.scanned.textContent = state.stats.scanned
    ui.skipped.textContent = state.stats.skipped
    ui.failed.textContent = state.stats.failed
    ui.run.disabled = state.running
    ui.stop.disabled = !state.running && !state.resumeScheduled && !canAutoResume()
    ui.dryrun.checked = !!state.cfg.dryRun
    ui.dryrun.disabled = state.running
    ui.dot.className = 'dot' + (state.running ? ' on' : '')

    if (!state.cfg.dryRun) {
      ui.warn.classList.remove('hidden')
      ui.warn.textContent =
        '正式投递已开启：会真的向 HR 发起沟通。今日上限 ' +
        state.cfg.limits.dailyMax +
        '，每次间隔 ' +
        state.cfg.limits.delayMinMs / 1000 +
        '–' +
        state.cfg.limits.delayMaxMs / 1000 +
        ' 秒。'
    } else {
      ui.warn.classList.add('hidden')
    }
  }

  function unmount() {
    if (state.ui && state.ui.host) state.ui.host.remove()
    state.ui = null
  }

  function mount() {
    // 注意不能只判 state.ui：BOSS 的 SPA 会重渲染 documentElement 上的节点，
    // 把我们的 host 抹掉。那样 state.ui 还在、host 已经不在文档里了，只判 state.ui
    // 就会永远不再挂回来（面板凭空消失、日志也丢了）。
    if (state.ui && state.ui.host && state.ui.host.isConnected) return
    state.ui = null
    var host = document.createElement('div')
    host.id = HOST_ID
    var shadow = host.attachShadow({ mode: 'open' })
    var style = document.createElement('style')
    style.textContent = PANEL_CSS
    shadow.appendChild(style)
    var wrap = document.createElement('div')
    wrap.innerHTML = PANEL_HTML
    shadow.appendChild(wrap)
    // 挂在 body 上而不是 documentElement：少一点「顶层多了一个节点」的特征
    ;(document.body || document.documentElement).appendChild(host)

    state.ui = {
      host: host,
      body: shadow.querySelector('[data-el="body"]'),
      status: shadow.querySelector('[data-el="status"]'),
      applied: shadow.querySelector('[data-el="applied"]'),
      scanned: shadow.querySelector('[data-el="scanned"]'),
      skipped: shadow.querySelector('[data-el="skipped"]'),
      failed: shadow.querySelector('[data-el="failed"]'),
      dot: shadow.querySelector('[data-el="dot"]'),
      warn: shadow.querySelector('[data-el="warn"]'),
      log: shadow.querySelector('[data-el="log"]'),
      run: shadow.querySelector('[data-act="run"]'),
      stop: shadow.querySelector('[data-act="stop"]'),
      dryrun: shadow.querySelector('[data-act="dryrun"]')
    }

    // 面板重建时把之前的日志补回来
    state.logs.forEach(appendLogLine)

    shadow.addEventListener('click', function (e) {
      var target = e.target.closest('[data-act]')
      if (!target) return
      var act = target.dataset.act
      if (act === 'run') {
        state.userStopped = false
        run()
      }
      else if (act === 'stop') stop()
      else if (act === 'selfcheck') selfCheck()
      else if (act === 'copy') copyLog()
      else if (act === 'clear') {
        state.logs = []
        state.ui.log.textContent = ''
      }
      else if (act === 'options') {
        // 扩展被重新加载后内容脚本会失效，sendMessage 直接抛；不给它兜底就是「点了没反应」
        var p = EXT.openOptions()
        if (p && p.catch) {
          p.catch(function () {
            log('error', '打不开设置页（扩展可能被重新加载过），刷新这个页面再试')
          })
        }
      }
      else if (act === 'collapse') state.ui.body.classList.toggle('collapsed')
    })

    shadow.addEventListener('change', function (e) {
      var target = e.target.closest('[data-act]')
      if (target && target.dataset.act === 'dryrun') {
        if (state.running) {
          target.checked = !target.checked
          log('warn', '运行中不能改「试运行」，改了这一轮也不会生效。要换模式请先停止。')
          return
        }
        state.cfg.dryRun = target.checked
        saveConfig()
        render()
      }
    })

    render()
  }

  /* -------------------------------------------------------------- 生命周期 */

  function tick() {
    // 跨午夜时把当天的计数归零，避免「昨天的计数算进今天的上限」
    var key = F.todayKey()
    if (state.stats.date !== key) {
      state.stats = D.emptyStats(key)
      EXT.storageSet({ [D.STATS_KEY]: state.stats })
      if (state.ui) log('info', '跨天了，今日计数已归零')
    }
    // 面板只要在岗位列表页就挂出来——列表为空（比如小号还没设求职期望）时也要能点「自检」，
    // 否则用户什么都看不到、也无从诊断。运行中一律不卸载：翻页瞬间列表可能短暂为空，
    // 面板消失会连日志一起丢。
    var canResume = canAutoResume()
    if (state.running || canResume || isGeekPage()) {
      mount()
      if (isGeekJobPath() && !state.running) probe()
    } else {
      unmount()
    }

    // 整页重载/切页面会把这一轮打断（内容脚本是每次加载一份）。只要会话还新鲜就自动接着跑。
    if (canResume && !state.running && !state.resumeScheduled) {
      state.resumeScheduled = true
      log('info', '页面被重新加载了（切到别的页面也会），4 秒后自动接着跑；不想继续就点「停止」。')
      resumeTimer = setTimeout(function () {
        resumeTimer = null
        state.resumeScheduled = false
        if (!state.running && canAutoResume()) run({ resume: true })
      }, 4000)
    }
  }

  EXT.onStorageChanged(function (changes, area) {
    if (area !== 'local') return
    if (changes[D.CONFIG_KEY]) {
      state.cfg = D.sanitizeConfig(changes[D.CONFIG_KEY].newValue)
      render()
    }
    // 运行中不接管 stats，避免自己写出去的变更反过来盖掉内存里的进度
    if (changes[D.STATS_KEY] && !state.running) {
      state.stats = D.mergeStats(changes[D.STATS_KEY].newValue, F.todayKey())
      render()
    }
  })

  loadState()
    .then(function () {
      tick()
      setInterval(tick, 3000)
      log('info', '插件已就绪。先在「设置」里确认筛选条件，再点「开始」。')
    })
    .catch(function (e) {
      console.warn('[boss-auto-apply] 初始化失败', e)
    })
})();
