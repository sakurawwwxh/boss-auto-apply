/**
 * 纯逻辑层：薪资/活跃度解析与岗位筛选判定。
 * 不碰 DOM、不碰 chrome API，因此可以在 Node 里直接跑自测（tools/selftest.cjs）。
 */
(function (root) {
  'use strict'

  // 日薪换算成月薪的天数，用于「200-300元/天」这类岗位与月薪区间做比较
  var WORKDAYS_PER_MONTH = 21.75

  var ACTIVE_PATTERNS = [
    [/刚刚|今天|今日|在线/, 0],
    [/(\d+)\s*日内活跃/, null],
    [/(\d+)\s*天内活跃/, null],
    [/本周活跃/, 7],
    [/(\d+)\s*周内活跃/, function (n) { return n * 7 }],
    [/本月活跃/, 30],
    [/(\d+)\s*月内活跃/, function (n) { return n * 30 }],
    [/近半年|半年前活跃/, 180],
    [/(\d+)\s*年内活跃/, function (n) { return n * 365 }],
    [/年前活跃/, 365]
  ]

  /**
   * 把 BOSS 的薪资文案解析成月薪区间（单位 K）。
   * 支持 "20-40K·14薪"、"15-25K"、"200-300元/天"、"8-12k"。
   * 返回 { min, max, perDay, raw } 或 null（面议/解析不了）。
   */
  function parseSalary(text) {
    if (!text) return null
    var s = String(text).replace(/\s/g, '')
    if (/面议|薪资面议/.test(s)) return null

    var perDay = /\/天|元\/天|每天/.test(s)

    // 取「·」前的部分，薪资后面的 14薪 之类不参与区间判断
    var head = s.split(/[·•]/)[0]

    // 单位可以夹在中间：20K-40K / 1.5万-2万
    var m = head.match(/(\d+(?:\.\d+)?)\s*[kK千万]?\s*[-~至]\s*(\d+(?:\.\d+)?)/)
    var min, max
    if (m) {
      min = parseFloat(m[1])
      max = parseFloat(m[2])
    } else {
      var single = head.match(/(\d+(?:\.\d+)?)/)
      if (!single) return null
      min = max = parseFloat(single[1])
    }

    if (/元|块/.test(head) && !/K|k|千|万/.test(head)) {
      // 单位是元/天，按每月 21.75 个工作日折算成 K
      if (!perDay) return null
      min = (min * WORKDAYS_PER_MONTH) / 1000
      max = (max * WORKDAYS_PER_MONTH) / 1000
    } else if (/万/.test(head)) {
      // 「1.5-2万」这类写法，换成 K
      min = min * 10
      max = max * 10
    }

    if (!isFinite(min) || !isFinite(max)) return null
    if (max < min) { var t = min; min = max; max = t }
    return { min: min, max: max, perDay: perDay, raw: text }
  }

  /**
   * 把 BOSS 的活跃度文案解析成「最近活跃距今的天数」。
   * 解析不了返回 null（调用方自己决定怎么处理未知值）。
   */
  function parseActiveDays(text) {
    if (!text) return null
    var s = String(text)
    for (var i = 0; i < ACTIVE_PATTERNS.length; i++) {
      var re = ACTIVE_PATTERNS[i][0]
      var val = ACTIVE_PATTERNS[i][1]
      var m = s.match(re)
      if (!m) continue
      if (val === null) return parseFloat(m[1])
      if (typeof val === 'function') return val(parseFloat(m[1]))
      return val
    }
    return null
  }

  function toList(value) {
    if (value == null) return []
    if (Array.isArray(value)) {
      return value.map(function (v) { return String(v).trim() }).filter(Boolean)
    }
    return String(value)
      .split(/[,，\n]/)
      .map(function (v) { return v.trim() })
      .filter(Boolean)
  }

  /** 关键词匹配大小写不敏感：写 "java" 也要能命中「Java 后端开发」 */
  function findHit(haystack, words) {
    if (!haystack) return null
    var text = String(haystack).toLowerCase()
    for (var i = 0; i < words.length; i++) {
      var needle = String(words[i]).toLowerCase()
      if (needle && text.indexOf(needle) !== -1) return words[i]
    }
    return null
  }

  /**
   * 判定一个岗位是否应该投递。
   *
   * 分两道跑：列表接口一次就给全了一整页岗位（岗位名/公司/薪资/城市/是否已沟通/猎头），
   * 但**不给活跃度和 JD 正文**——那两个必须单独拉 card.json。所以第一道用
   * opts.cheap 跑，跳过所有依赖详情的判定；只有过了第一道的岗位才去拉详情跑第二道。
   * 一页 30 个岗位因此最多只发几个详情请求，而不是 30 个。
   *
   * @param {object} card    岗位对象（列表接口的条目，或 card.json 的 jobCard）
   * @param {object} cfg     filters 配置段
   * @param {object} [hint]  补充信息（猎头标记等）
   * @param {object} [opts]  { cheap: true } = 只跑不依赖岗位详情的判定
   * @returns {{ok:boolean, reason?:string}}
   */
  function decide(card, cfg, hint, opts) {
    card = card || {}
    hint = hint || {}
    var cheap = !!(opts && opts.cheap)
    var jobName = card.jobName || hint.jobName || ''
    var company = card.brandName || card.companyName || hint.companyName || ''
    var jd = card.postDescription || ''

    var reasons = []
    var reject = function (reason) { reasons.push(reason) }

    if (cfg.skipContacted !== false) {
      if (card.friendStatus === 1 || card.contact === true) reject('已沟通')
    }

    var goldHunter = hint.goldHunter === true || hint.goldHunter === 1 || hint.goldHunter === '1'
    if (cfg.excludeHeadhunter && (goldHunter || /猎头/.test(hint.cardText || ''))) {
      reject('猎头发布')
    }

    var must = toList(cfg.mustKeywords)
    if (must.length) {
      var hit = findHit(jobName, must)
      // JD 正文要等详情，第一道跑不到
      if (!hit && cfg.includeInJd && !cheap) hit = findHit(jd, must)
      if (!hit) reject('岗位名不含关键词(' + must.join('/') + ')')
    }

    var exclude = toList(cfg.excludeKeywords)
    if (exclude.length) {
      var hitEx = findHit(jobName, exclude) || findHit(company, exclude)
      if (hitEx) reject('命中排除词:' + hitEx)
    }

    var excludeJd = cheap ? [] : toList(cfg.excludeInJd)
    if (excludeJd.length) {
      var hitJd = findHit(jd, excludeJd)
      if (hitJd) reject('JD 命中排除词:' + hitJd)
    }

    var excludeCompanies = toList(cfg.excludeCompanies)
    if (excludeCompanies.length) {
      var hitCo = findHit(company, excludeCompanies)
      if (hitCo) reject('排除公司:' + hitCo)
    }

    var cities = toList(cfg.cities)
    if (cities.length) {
      var cityText = (card.cityName || '') + (card.areaDistrict || '') + (card.businessDistrict || '')
      if (!findHit(cityText, cities)) reject('城市不符:' + (card.cityName || '未知'))
    }

    var wantMin = Number(cfg.salaryMin) || 0
    var wantMax = Number(cfg.salaryMax) || 0
    if (wantMin > 0 || wantMax > 0) {
      var sal = parseSalary(card.salaryDesc)
      if (!sal) {
        reject('薪资未知(' + (card.salaryDesc || '空') + ')，无法按你的区间判断')
      } else {
        if (wantMin > 0 && sal.max < wantMin) reject('薪资偏低:' + card.salaryDesc)
        else if (wantMax > 0 && sal.min > wantMax) reject('薪资偏高:' + card.salaryDesc)
      }
    }

    var activeDays = cheap ? 0 : Number(cfg.activeWithinDays) || 0
    if (activeDays > 0) {
      var days = parseActiveDays(card.activeTimeDesc)
      if (days === null) {
        reject('活跃度未知(' + (card.activeTimeDesc || '空') + ')')
      } else if (days > activeDays) {
        reject('不活跃:' + card.activeTimeDesc)
      }
    }

    if (reasons.length) return { ok: false, reason: reasons[0] }
    return { ok: true }
  }

  /** 去掉 BOSS 返回里可能带上的 HTML 高亮标签 */
  function stripTags(html) {
    return String(html == null ? '' : html).replace(/<[^>]*>/g, '')
  }

  function todayKey(now) {
    var d = now ? new Date(now) : new Date()
    var p = function (n) { return n < 10 ? '0' + n : '' + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  var api = {
    parseSalary: parseSalary,
    parseActiveDays: parseActiveDays,
    decide: decide,
    toList: toList,
    findHit: findHit,
    stripTags: stripTags,
    todayKey: todayKey
  }

  root.BossFilters = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
