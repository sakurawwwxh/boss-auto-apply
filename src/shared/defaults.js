/**
 * 配置默认值与合并逻辑。panel / popup / options 以及 Node 自测共用这一份。
 */
;(function (root) {
  'use strict'

  var DEFAULT_CONFIG = {
    // 试运行：只筛选并记录日志，不真的投递。默认开启。
    dryRun: true,
    filters: {
      mustKeywords: '',      // 岗位名必须包含其中任意一个（逗号分隔，空=不限）
      excludeKeywords: '',   // 岗位名或公司名包含任意一个则跳过
      excludeCompanies: '',  // 公司名包含任意一个则跳过
      excludeInJd: '',       // 岗位描述（JD 正文）包含任意一个则跳过
      skipSameHr: true,      // 同一个招聘者不重复打招呼（防被 HR 当骚扰举报）
      sameHrDays: 30,        // 上面那条的间隔天数；0 = 只在本轮内去重
      includeInJd: false,    // mustKeywords 是否也拿去匹配 JD 正文
      skipContacted: true,   // 跳过已经在 BOSS 上沟通过的
      excludeHeadhunter: false,
      activeWithinDays: 0,   // 0 = 不限；只投递「最近 N 天内活跃」的 HR
      salaryMin: 0,          // 单位 K/月，0 = 不限
      salaryMax: 0,
      cities: ''             // 留空 = 不限
    },
    limits: {
      dailyMax: 60,          // 自己给自己设的每日上限（BOSS 侧约 120/天）
      delayMinMs: 2000,      // 每次投递之间的随机间隔
      delayMaxMs: 5000,
      maxPages: 20           // 自动翻页最多翻多少页
      ,
      autoConfirm120: false  // 遇到「今日已与120位BOSS沟通」的确认弹窗时自动继续
    }
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value))
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
  }

  /** 布尔字段的宽松归一：1 / '1' 也算真，免得导入 JSON 后把开关静默关掉 */
  function toBool(value, fallback) {
    if (value === true || value === 'true' || value === 1 || value === '1') return true
    if (value === false || value === 'false' || value === 0 || value === '0') return false
    return fallback
  }

  /** 用默认值兜底地合并用户存的配置，避免旧版本配置缺字段时炸掉 */
  function mergeConfig(stored) {
    var out = deepClone(DEFAULT_CONFIG)
    if (!isPlainObject(stored)) return out

    // 试运行是安全网，只有显式写 false 才关掉；0 / '' / 乱值一律保持开启
    out.dryRun = !(stored.dryRun === false || stored.dryRun === 'false')

    Object.keys(out).forEach(function (key) {
      if (key === 'dryRun') return
      if (!isPlainObject(out[key])) {
        if (stored[key] !== undefined && stored[key] !== null) out[key] = stored[key]
        return
      }
      if (!isPlainObject(stored[key])) return
      Object.keys(out[key]).forEach(function (sub) {
        var value = stored[key][sub]
        if (value === undefined || value === null) return
        if (typeof out[key][sub] === 'number') {
          var n = Number(value)
          out[key][sub] = isFinite(n) ? n : out[key][sub]
          return
        }
        if (typeof out[key][sub] === 'boolean') {
          out[key][sub] = toBool(value, out[key][sub])
          return
        }
        out[key][sub] = value
      })
    })
    return out
  }

  /** 把合并后的配置夹到合理范围，防止填出负延迟/0 间隔这种自伤配置 */
  function sanitizeConfig(cfg) {
    var c = mergeConfig(cfg)
    // BOSS 侧 150 位/天是硬上限，自己设的上限不可能超过它，设了也没意义
    c.limits.dailyMax = Math.max(1, Math.min(150, Math.round(c.limits.dailyMax) || 1))
    c.limits.maxPages = Math.max(1, Math.min(200, Math.round(c.limits.maxPages) || 1))
    c.limits.delayMinMs = Math.max(800, Math.round(c.limits.delayMinMs) || 2000)
    // 间隔也要有上限：填个 10 分钟的话，锁的心跳间隔就不够了，
    // 会出现「另一个标签页把锁抢走」，两边各按自己的上限投 → 可能突破每日上限
    c.limits.delayMaxMs = Math.min(
      120000,
      Math.max(c.limits.delayMinMs, Math.round(c.limits.delayMaxMs) || 5000)
    )
    c.filters.activeWithinDays = Math.max(0, Math.round(c.filters.activeWithinDays) || 0)
    c.filters.sameHrDays = Math.max(0, Math.min(365, Math.round(c.filters.sameHrDays) || 0))
    c.filters.salaryMin = Math.max(0, Number(c.filters.salaryMin) || 0)
    c.filters.salaryMax = Math.max(0, Number(c.filters.salaryMax) || 0)
    if (c.filters.salaryMax > 0 && c.filters.salaryMin > c.filters.salaryMax) {
      var t = c.filters.salaryMin
      c.filters.salaryMin = c.filters.salaryMax
      c.filters.salaryMax = t
    }
    return c
  }

  function emptyStats(dateKey) {
    return {
      date: dateKey,
      scanned: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      appliedIds: [],
      recent: []
    }
  }

  function mergeStats(stored, dateKey) {
    if (!isPlainObject(stored) || stored.date !== dateKey) return emptyStats(dateKey)
    var s = emptyStats(dateKey)
    s.scanned = Number(stored.scanned) || 0
    s.applied = Number(stored.applied) || 0
    s.skipped = Number(stored.skipped) || 0
    s.failed = Number(stored.failed) || 0
    s.appliedIds = Array.isArray(stored.appliedIds) ? stored.appliedIds.slice(-3000) : []
    s.recent = Array.isArray(stored.recent) ? stored.recent.slice(-50) : []
    return s
  }

  var api = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    mergeConfig: mergeConfig,
    sanitizeConfig: sanitizeConfig,
    emptyStats: emptyStats,
    mergeStats: mergeStats,
    CONFIG_KEY: 'bossAutoApply.config',
    // 诊断快照：最近一次探测结论 + 最近若干行日志。
    // 存在 storage 里，因此可以从浏览器 profile 的文件里直接读出来（不用碰浏览器）
    DIAG_KEY: 'bossAutoApply.diag',
    STATS_KEY: 'bossAutoApply.stats',
    // 一轮投递的会话状态。存在这里是为了让「切页面/整页重载」之后能接着跑：
    // 内容脚本是「每次页面加载一份」，不落盘的话一重载这轮就没了。
    RUN_KEY: 'bossAutoApply.run',
    // 会话超过这个时长就不自动续跑了，避免真机重启后莫名其妙自己开始投
    RUN_RESUME_WINDOW_MS: 30 * 60 * 1000
  }

  root.BossDefaults = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
