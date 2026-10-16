/**
 * 离线自测：只跑纯逻辑（薪资/活跃度解析、筛选判定、配置合并与夹取）。
 * 不碰 DOM、不碰 chrome API，所以 node tools/selftest.cjs 就能跑。
 */
'use strict'

const assert = require('node:assert/strict')
const F = require('../src/content/filters.js')
const D = require('../src/shared/defaults.js')

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
  } catch (e) {
    failures.push({ name, message: e.message })
  }
}

function cfg(filters) {
  return Object.assign({}, D.DEFAULT_CONFIG.filters, filters)
}

/* --------------------------------------------------- 大小写与单位变体 */

test('parseSalary: 单位夹在中间也要认（20K-40K）', () => {
  const r = F.parseSalary('20K-40K')
  assert.equal(r.min, 20)
  assert.equal(r.max, 40)
})

test('parseSalary: 万带单位也要认（1.5万-2万）', () => {
  const r = F.parseSalary('1.5万-2万')
  assert.equal(r.min, 15)
  assert.equal(r.max, 20)
})

/* ------------------------------------------------------- 配置类型归一 */

test('mergeConfig: dryRun 只有显式 false 才关得掉（0 / "" 都不算）', () => {
  assert.equal(D.mergeConfig({ dryRun: 0 }).dryRun, true)
  assert.equal(D.mergeConfig({ dryRun: '' }).dryRun, true)
  assert.equal(D.mergeConfig({ dryRun: 'no' }).dryRun, true)
  assert.equal(D.mergeConfig({ dryRun: undefined }).dryRun, true)
  assert.equal(D.mergeConfig({ dryRun: false }).dryRun, false)
  assert.equal(D.mergeConfig({ dryRun: 'false' }).dryRun, false)
})

// 注意：要拿「默认是 false」的字段来验 1 → true，否则归一失效时会被默认值兜住而看不出来
test('mergeConfig: 布尔字段认 1 / "1"', () => {
  assert.equal(D.mergeConfig({ filters: { excludeHeadhunter: 1 } }).filters.excludeHeadhunter, true)
  assert.equal(D.mergeConfig({ filters: { includeInJd: '1' } }).filters.includeInJd, true)
  assert.equal(D.mergeConfig({ limits: { autoConfirm120: 1 } }).limits.autoConfirm120, true)
  assert.equal(D.mergeConfig({ filters: { skipContacted: 0 } }).filters.skipContacted, false)
})

test('sanitizeConfig: 同一个招聘者的去重天数被夹到 0-365', () => {
  assert.equal(D.sanitizeConfig({ filters: { sameHrDays: 999 } }).filters.sameHrDays, 365)
  assert.equal(D.sanitizeConfig({ filters: { sameHrDays: -5 } }).filters.sameHrDays, 0)
  // 脏数据要回落到「默认 30」而不是 0 —— 0 意味着"只在本轮去重"、保护更弱，
  // 不该由脏数据把保护打开
  assert.equal(D.sanitizeConfig({ filters: { sameHrDays: 'abc' } }).filters.sameHrDays, 30)
  assert.equal(D.sanitizeConfig({ filters: { sameHrDays: 7 } }).filters.sameHrDays, 7)
})

test('sanitizeConfig: 投递间隔有上限（不然锁会过期被别的标签页抢走）', () => {
  const s = D.sanitizeConfig({ limits: { delayMinMs: 2000, delayMaxMs: 99999999 } })
  assert.equal(s.limits.delayMaxMs, 120000)
})

test('默认配置：同一个招聘者不重复打招呼（默认开、30 天）', () => {
  const c = D.mergeConfig(undefined)
  assert.equal(c.filters.skipSameHr, true)
  assert.equal(c.filters.sameHrDays, 30)
})

test('默认配置：只写 false 才关得掉「不重复打扰同一个 HR」', () => {
  assert.equal(D.mergeConfig({ filters: { skipSameHr: false } }).filters.skipSameHr, false)
  assert.equal(D.mergeConfig({ filters: { skipSameHr: 0 } }).filters.skipSameHr, false)
  assert.equal(D.mergeConfig({ filters: { skipSameHr: 'yes' } }).filters.skipSameHr, true)
})

test('sanitizeConfig: 每日上限不会超过 BOSS 的 150 硬上限', () => {
  assert.equal(D.sanitizeConfig({ limits: { dailyMax: 999 } }).limits.dailyMax, 150)
})

/* ------------------------------------------------------------ parseSalary */

test('parseSalary: 标准区间带薪数', () => {
  const r = F.parseSalary('20-40K·14薪')
  assert.equal(r.min, 20)
  assert.equal(r.max, 40)
})

test('parseSalary: 小写 k', () => {
  const r = F.parseSalary('8-12k')
  assert.equal(r.min, 8)
  assert.equal(r.max, 12)
})

test('parseSalary: 单个数字', () => {
  const r = F.parseSalary('25K')
  assert.equal(r.min, 25)
  assert.equal(r.max, 25)
})

test('parseSalary: 万为单位换算成 K', () => {
  const r = F.parseSalary('2-3万')
  assert.equal(r.min, 20)
  assert.equal(r.max, 30)
})

test('parseSalary: 元/天折算成月薪 K', () => {
  const r = F.parseSalary('200-300元/天')
  assert.equal(r.perDay, true)
  assert.ok(Math.abs(r.min - (200 * 21.75) / 1000) < 1e-6, 'min=' + r.min)
  assert.ok(Math.abs(r.max - (300 * 21.75) / 1000) < 1e-6, 'max=' + r.max)
})

test('parseSalary: 面议返回 null', () => {
  assert.equal(F.parseSalary('面议'), null)
  assert.equal(F.parseSalary(''), null)
  assert.equal(F.parseSalary(null), null)
})

test('parseSalary: 区间倒着写也能纠正', () => {
  const r = F.parseSalary('40-20K')
  assert.equal(r.min, 20)
  assert.equal(r.max, 40)
})

/* ------------------------------------------------------- parseActiveDays */

test('parseActiveDays: 各档文案', () => {
  assert.equal(F.parseActiveDays('刚刚活跃'), 0)
  assert.equal(F.parseActiveDays('今日活跃'), 0)
  assert.equal(F.parseActiveDays('3日内活跃'), 3)
  assert.equal(F.parseActiveDays('5天内活跃'), 5)
  assert.equal(F.parseActiveDays('本周活跃'), 7)
  assert.equal(F.parseActiveDays('2周内活跃'), 14)
  assert.equal(F.parseActiveDays('本月活跃'), 30)
  assert.equal(F.parseActiveDays('3月内活跃'), 90)
  assert.equal(F.parseActiveDays('半年前活跃'), 180)
  assert.equal(F.parseActiveDays('1年内活跃'), 365)
})

test('parseActiveDays: 认不出来返回 null', () => {
  assert.equal(F.parseActiveDays(''), null)
  assert.equal(F.parseActiveDays('神秘状态'), null)
  assert.equal(F.parseActiveDays(undefined), null)
})

/* ------------------------------------------------------------------ decide */

const baseCard = {
  jobName: 'Java 后端开发工程师',
  brandName: '某某科技有限公司',
  salaryDesc: '25-40K·14薪',
  activeTimeDesc: '今日活跃',
  postDescription: '负责服务端开发，熟悉 Spring Boot、MySQL。',
  friendStatus: 0,
  cityName: '北京',
  encryptJobId: 'abc',
  securityId: 'sec'
}

test('decide: 全部条件满足就放行', () => {
  const r = F.decide(baseCard, cfg({ mustKeywords: 'Java,后端', activeWithinDays: 3 }))
  assert.equal(r.ok, true, r.reason)
})

test('decide: 已沟通会被跳过', () => {
  const r = F.decide(Object.assign({}, baseCard, { friendStatus: 1 }), cfg({}))
  assert.equal(r.ok, false)
  assert.match(r.reason, /已沟通/)
})

test('decide: contact=true 也当成已沟通', () => {
  const r = F.decide(Object.assign({}, baseCard, { contact: true }), cfg({}))
  assert.equal(r.ok, false)
  assert.match(r.reason, /已沟通/)
})

test('decide: 关掉「跳过已沟通」后不再拦', () => {
  const r = F.decide(Object.assign({}, baseCard, { friendStatus: 1 }), cfg({ skipContacted: false }))
  assert.equal(r.ok, true, r.reason)
})

test('decide: 岗位名不含关键词', () => {
  const r = F.decide(baseCard, cfg({ mustKeywords: 'Go,Rust' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /不含关键词/)
})

test('decide: includeInJd 打开后可以靠 JD 命中', () => {
  const off = F.decide(baseCard, cfg({ mustKeywords: 'Spring' }))
  assert.equal(off.ok, false)
  const on = F.decide(baseCard, cfg({ mustKeywords: 'Spring', includeInJd: true }))
  assert.equal(on.ok, true, on.reason)
})

test('decide: 排除词命中公司名', () => {
  const r = F.decide(baseCard, cfg({ excludeKeywords: '某某科技' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /排除词/)
})

test('decide: JD 排除词', () => {
  const card = Object.assign({}, baseCard, { postDescription: '需要出差拜访客户' })
  const r = F.decide(card, cfg({ excludeInJd: '出差,拜访' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /JD 命中/)
})

test('decide: 薪资低于下限被跳过', () => {
  const card = Object.assign({}, baseCard, { salaryDesc: '10-15K' })
  const r = F.decide(card, cfg({ salaryMin: 20 }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /薪资偏低/)
})

test('decide: 薪资高于上限被跳过', () => {
  const card = Object.assign({}, baseCard, { salaryDesc: '60-90K' })
  const r = F.decide(card, cfg({ salaryMax: 50 }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /薪资偏高/)
})

test('decide: 设了薪资区间但岗位是「面议」→ 跳过并说明原因', () => {
  const card = Object.assign({}, baseCard, { salaryDesc: '面议' })
  const r = F.decide(card, cfg({ salaryMin: 20 }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /薪资未知/)
})

test('decide: 未设薪资区间时「面议」照常放行', () => {
  const card = Object.assign({}, baseCard, { salaryDesc: '面议' })
  const r = F.decide(card, cfg({}))
  assert.equal(r.ok, true, r.reason)
})

test('decide: 活跃度太旧被跳过', () => {
  const card = Object.assign({}, baseCard, { activeTimeDesc: '半年前活跃' })
  const r = F.decide(card, cfg({ activeWithinDays: 3 }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /不活跃/)
})

test('decide: 设了活跃度阈值但活跃度认不出来 → 跳过并带上原文', () => {
  const card = Object.assign({}, baseCard, { activeTimeDesc: '很活跃' })
  const r = F.decide(card, cfg({ activeWithinDays: 3 }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /活跃度未知/)
  assert.match(r.reason, /很活跃/)
})

test('decide: 城市不符', () => {
  const r = F.decide(baseCard, cfg({ cities: '杭州,上海' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /城市不符/)
})

test('decide: 城市命中区县名也算', () => {
  const card = Object.assign({}, baseCard, { areaDistrict: '海淀区' })
  const r = F.decide(card, cfg({ cities: '海淀' }))
  assert.equal(r.ok, true, r.reason)
})

test('decide: 猎头岗位按 hint 跳过', () => {
  const r = F.decide(baseCard, cfg({ excludeHeadhunter: true }), { goldHunter: true })
  assert.equal(r.ok, false)
  assert.match(r.reason, /猎头/)
})

test('decide: 关键词大小写不敏感（写 java 要能命中 Java）', () => {
  const r = F.decide(baseCard, cfg({ mustKeywords: 'java' }))
  assert.equal(r.ok, true, r.reason)
})

test('decide: JD 排除词大小写不敏感（JD 里是 MySQL，配置里写 MYSQL）', () => {
  const r = F.decide(baseCard, cfg({ excludeInJd: 'MYSQL' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /JD 命中/)
})

/* ------------------------------------------- decide 的「第一道」(cheap) 模式 */

// 列表接口不给活跃度和 JD 正文，所以第一道必须跳过这两类判定；
// 否则每个岗位都会因为「活跃度未知」被误杀。

test('cheap 模式：列表数据里没有活跃度，也不该因它被跳掉', () => {
  const listJob = { jobName: 'Java 后端', brandName: '云启科技', salaryDesc: '25-40K', cityName: '北京', encryptJobId: 'A', securityId: 'S' }
  const cfgWithActive = cfg({ activeWithinDays: 3, mustKeywords: 'Java' })

  assert.equal(F.decide(listJob, cfgWithActive, {}, { cheap: true }).ok, true, 'cheap 应放行')
  assert.equal(F.decide(listJob, cfgWithActive, {}, {}).ok, false, '完整判定应因活跃度未知拦住')
})

// 注意：这两条要故意给列表条目也塞一份 postDescription。
// 否则"cheap 阶段 JD 为空"和"cheap 阶段不读 JD"这两种实现都测不出差别——
// 我们锁的是后者的语义：第一道只认列表接口的字段，不因为条目碰巧带了 JD 就去读它。

test('cheap 模式：即使条目带了 JD 也不做 JD 排除', () => {
  const listJob = { jobName: 'Java 后端', brandName: '云启科技', salaryDesc: '25-40K', postDescription: '含电话销售' }
  const c = cfg({ excludeInJd: '销售,地推' })
  assert.equal(F.decide(listJob, c, {}, { cheap: true }).ok, true, 'cheap 阶段不该读 JD')
  assert.equal(F.decide(listJob, c, {}, {}).ok, false, '完整阶段应被 JD 排除词拦住')
})

test('cheap 模式：即使条目带了 JD 也不做 includeInJd 匹配', () => {
  const listJob = { jobName: '后端工程师', brandName: '云启科技', salaryDesc: '25-40K', postDescription: '熟悉 Spring' }
  const c = cfg({ mustKeywords: 'Spring', includeInJd: true })
  assert.equal(F.decide(listJob, c, {}, { cheap: true }).ok, false, 'cheap 阶段只认岗位名')
  assert.equal(F.decide(listJob, c, {}, {}).ok, true, '完整阶段才靠 JD 命中')
})

test('cheap 模式：仍然拦得住已沟通/薪资/公司/城市', () => {
  const base = { jobName: 'Java 后端', brandName: '云启科技', salaryDesc: '25-40K', cityName: '北京' }
  assert.equal(F.decide(Object.assign({}, base, { contact: true }), cfg({}), {}, { cheap: true }).ok, false)
  // 25-40K 对下限 40 不该被拦（max 不小于 min）；下限 45 才该拦
  assert.equal(F.decide(base, cfg({ salaryMin: 40 }), {}, { cheap: true }).ok, true)
  assert.equal(F.decide(base, cfg({ salaryMin: 45 }), {}, { cheap: true }).ok, false)
  assert.equal(F.decide(base, cfg({ excludeCompanies: '云启' }), {}, { cheap: true }).ok, false)
  assert.equal(F.decide(base, cfg({ cities: '上海' }), {}, { cheap: true }).ok, false)
})

test('cheap 模式：接口给的 goldHunter 是字符串 "1"，排除猎头要认得', () => {
  const base = { jobName: 'Java 后端', brandName: '某某科技', salaryDesc: '60-90K' }
  const c = cfg({ excludeHeadhunter: true })
  assert.equal(F.decide(base, c, { goldHunter: '1' }, { cheap: true }).ok, false, '字符串 "1" 也要当猎头')
  assert.equal(F.decide(base, c, { goldHunter: '0' }, { cheap: true }).ok, true)
})

test('decide: 候选词是数组也认', () => {
  const r = F.decide(baseCard, cfg({ mustKeywords: ['Java', '后端'] }))
  assert.equal(r.ok, true, r.reason)
})

/* ---------------------------------------------------------------- 配置合并 */

test('mergeConfig: 缺字段用默认值兜底', () => {
  const merged = D.mergeConfig({ filters: { mustKeywords: 'Java' } })
  assert.equal(merged.filters.mustKeywords, 'Java')
  assert.equal(merged.filters.activeWithinDays, 0)
  assert.equal(merged.limits.dailyMax, 60)
  assert.equal(merged.dryRun, true)
})

test('mergeConfig: 完全没配置就用默认', () => {
  const merged = D.mergeConfig(undefined)
  assert.deepEqual(merged, D.DEFAULT_CONFIG)
})

test('sanitizeConfig: 数值字段被夹到合理区间', () => {
  const s = D.sanitizeConfig({
    limits: { dailyMax: 9999, maxPages: 0, delayMinMs: 10, delayMaxMs: 5 }
  })
  assert.equal(s.limits.dailyMax, 150)
  assert.equal(s.limits.maxPages, 1)
  assert.equal(s.limits.delayMinMs, 800)
  assert.ok(s.limits.delayMaxMs >= s.limits.delayMinMs, 'delayMax 必须 >= delayMin')
})

test('sanitizeConfig: 薪资上下限写反了会被换回来', () => {
  const s = D.sanitizeConfig({ filters: { salaryMin: 50, salaryMax: 20 } })
  assert.equal(s.filters.salaryMin, 20)
  assert.equal(s.filters.salaryMax, 50)
})

test('sanitizeConfig: 数字型字符串会转成数字', () => {
  const s = D.sanitizeConfig({ limits: { dailyMax: '30' } })
  assert.equal(s.limits.dailyMax, 30)
})

test('sanitizeConfig: 布尔型字符串 true 会被认成 true', () => {
  const s = D.sanitizeConfig({ filters: { skipContacted: 'true' } })
  assert.equal(s.filters.skipContacted, true)
})

/* ------------------------------------------------------------------ 统计 */

test('mergeStats: 换天就归零', () => {
  const old = { date: '2020-01-01', applied: 10, scanned: 20 }
  const s = D.mergeStats(old, '2026-10-16')
  assert.equal(s.applied, 0)
  assert.equal(s.date, '2026-10-16')
})

test('mergeStats: 同一天保留计数', () => {
  const old = { date: '2026-10-16', applied: 3, scanned: 30, skipped: 27, failed: 0 }
  const s = D.mergeStats(old, '2026-10-16')
  assert.equal(s.applied, 3)
  assert.equal(s.skipped, 27)
})

test('mergeStats: 脏数据不炸', () => {
  const s = D.mergeStats({ date: '2026-10-16', applied: 'x', appliedIds: 'nope' }, '2026-10-16')
  assert.equal(s.applied, 0)
  assert.deepEqual(s.appliedIds, [])
})

test('todayKey: 跨午夜各归各的', () => {
  assert.equal(F.todayKey(new Date(2026, 9, 16, 23, 59, 59)), '2026-10-16')
  assert.equal(F.todayKey(new Date(2026, 9, 17, 0, 0, 1)), '2026-10-17')
})

/* ------------------------------------------------------------------ 结果 */

if (failures.length) {
  console.error('✗ ' + failures.length + ' 个用例失败（通过 ' + passed + '）\n')
  for (const f of failures) {
    console.error('  ✗ ' + f.name)
    console.error('    ' + f.message.split('\n').join('\n    '))
  }
  process.exit(1)
}

console.log('✓ 全部通过：' + passed + ' 个用例')
