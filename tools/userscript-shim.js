/**
 * 油猴版的适配层。
 *
 * 面板代码（src/content/panel.js）本来是给 Chrome 扩展写的，它只通过 window.__BOSS_EXT__
 * 这个口去用扩展能力。这里就把这个口实现出来：
 *   - 存储：优先 Greasemonkey/Tampermonkey 的 GM_getValue/GM_setValue，退回 localStorage
 *   - token：BOSS 的 bst 是普通 cookie，直接从 document.cookie 读（已在真机页面验证过可读）
 *   - 中继：油猴运行在页面上下文，本来就能同源 fetch，不需要扩展那样的兜底通道
 *   - 设置：没有扩展的选项页，所以这里自带一个设置浮层
 *
 * 由 tools/build-userscript.mjs 拼进单文件脚本，插在 defaults.js / filters.js / panel.js 之前。
 */
;(function () {
  'use strict'

  var STORE_KEY = 'bossAutoApply.store'
  var TOKEN_COOKIE = 'bst'
  var SETTINGS_HOST_ID = '__aa_settings'
  var listeners = []

  /* ------------------------------------------------------------------ 存储 */

  var hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function'

  function readAll() {
    try {
      if (hasGM) {
        var raw = GM_getValue(STORE_KEY, '')
        return raw ? JSON.parse(raw) : {}
      }
      return JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}')
    } catch (e) {
      return {}
    }
  }

  function writeAll(all) {
    try {
      if (hasGM) GM_setValue(STORE_KEY, JSON.stringify(all))
      else window.localStorage.setItem(STORE_KEY, JSON.stringify(all))
    } catch (e) {
      /* 存不进去就用内存里的，至少本次会话能用 */
    }
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  }

  function storageGet(keys) {
    var all = readAll()
    var out = {}
    var list = Array.isArray(keys) ? keys : keys === undefined || keys === null ? Object.keys(all) : [keys]
    list.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(all, k)) out[k] = clone(all[k])
    })
    return Promise.resolve(out)
  }

  function emit(changes) {
    setTimeout(function () {
      listeners.forEach(function (fn) {
        fn(changes, 'local')
      })
    }, 0)
  }

  function storageSet(obj) {
    var all = readAll()
    var changes = {}
    Object.keys(obj).forEach(function (k) {
      changes[k] = { oldValue: clone(all[k]), newValue: clone(obj[k]) }
      all[k] = obj[k]
    })
    writeAll(all)
    emit(changes)
    return Promise.resolve()
  }

  function storageRemove(key) {
    var all = readAll()
    var changes = {}
    var keys = Array.isArray(key) ? key : [key]
    keys.forEach(function (k) {
      changes[k] = { oldValue: clone(all[k]), newValue: undefined }
      delete all[k]
    })
    writeAll(all)
    emit(changes)
    return Promise.resolve()
  }

  /* ----------------------------------------------------------------- token */

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }

  /* ------------------------------------------------------------- 设置浮层 */

  var FIELDS = [
    { path: 'filters.mustKeywords', label: '岗位名必须包含（逗号分隔，留空 = 不限）', ph: 'Java,后端' },
    { path: 'filters.excludeKeywords', label: '排除词 · 岗位名或公司名', ph: '外包,驻场,销售' },
    { path: 'filters.excludeCompanies', label: '排除公司', ph: '某某人力' },
    { path: 'filters.excludeInJd', label: '排除词 · 岗位描述正文', ph: '销售,地推' },
    { path: 'filters.cities', label: '城市（留空 = 不限）', ph: '北京,杭州' },
    { path: 'filters.salaryMin', label: '薪资下限（K/月，0 = 不限）', num: true },
    { path: 'filters.salaryMax', label: '薪资上限（K/月，0 = 不限）', num: true },
    { path: 'filters.activeWithinDays', label: '只投最近 N 天内活跃的 HR（0 = 不限）', num: true },
    { path: 'filters.sameHrDays', label: '同一个招聘者多少天内不重复打招呼（0 = 只在本轮内去重）', num: true },
    { path: 'limits.dailyMax', label: '每日最多投递', num: true },
    { path: 'limits.maxPages', label: '最多自动翻页（页）', num: true },
    { path: 'limits.delayMinMs', label: '每次投递最小间隔（毫秒）', num: true },
    { path: 'limits.delayMaxMs', label: '每次投递最大间隔（毫秒）', num: true }
  ]

  var CHECKS = [
    { path: 'dryRun', label: '试运行（只筛选和记日志，不真的投递）' },
    { path: 'filters.skipContacted', label: '跳过已经沟通过的岗位' },
    { path: 'filters.skipSameHr', label: '同一个招聘者不重复打招呼（推荐开启）' },
    { path: 'filters.excludeHeadhunter', label: '跳过猎头发布的岗位' },
    { path: 'filters.includeInJd', label: '关键词也拿去匹配 JD 正文' },
    { path: 'limits.autoConfirm120', label: '自动确认「已与 120 位沟通」提示并继续' }
  ]

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    '.wrap{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;',
    'font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2329}',
    '.box{width:min(560px,92vw);max-height:88vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3)}',
    '.hd{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid #e5e6eb;position:sticky;top:0;background:#fff;border-radius:14px 14px 0 0}',
    '.hd b{flex:1;font-size:15px}',
    '.hd button{border:0;background:transparent;font-size:18px;cursor:pointer;color:#646a73;padding:0 6px}',
    '.bd{padding:16px 18px}',
    '.f{margin-bottom:12px}',
    '.f label{display:block;font-size:12px;font-weight:600;margin-bottom:5px}',
    '.f input{width:100%;padding:7px 10px;border:1px solid #e5e6eb;border-radius:8px;font:inherit;font-size:13px;background:#f7f8fa}',
    '.f input:focus{outline:2px solid #00a6a7;outline-offset:-1px;border-color:#00a6a7}',
    '.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
    '.ck{display:flex;gap:8px;align-items:flex-start;margin-bottom:9px}',
    '.ck input{margin-top:3px}',
    '.ck label{font-size:12px;font-weight:400}',
    '.ft{display:flex;gap:10px;align-items:center;padding:14px 18px;border-top:1px solid #e5e6eb;position:sticky;bottom:0;background:#fff;border-radius:0 0 14px 14px}',
    '.ft button{font:inherit;font-size:13px;padding:8px 16px;border-radius:8px;border:1px solid #e5e6eb;background:#fff;cursor:pointer}',
    '.ft .pri{background:#00a6a7;border-color:#00a6a7;color:#fff}',
    '.ft .tip{font-size:12px;color:#00a6a7;opacity:0;transition:opacity .2s}',
    '.ft .tip.on{opacity:1}',
    '.note{font-size:12px;color:#a8621a;background:#fff7e6;border:1px solid #ffe0a3;border-radius:8px;padding:9px 11px;margin-bottom:14px}',
    '@media (prefers-color-scheme:dark){',
    '.box,.hd,.ft{background:#22262b;color:#e6e8ea}',
    '.hd,.ft{border-color:#333941}',
    '.f input{background:#2c3138;border-color:#3c434b;color:#e6e8ea}',
    '.ft button{background:#2c3138;border-color:#3c434b;color:#e6e8ea}',
    '.note{background:#2f2a1d;border-color:#4d4327;color:#e8c98a}',
    '}'
  ].join('')

  function getPath(obj, path) {
    return path.split('.').reduce(function (acc, k) {
      return acc === null || acc === undefined ? acc : acc[k]
    }, obj)
  }

  function setPath(obj, path, value) {
    var parts = path.split('.')
    var node = obj
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {}
      node = node[parts[i]]
    }
    node[parts[parts.length - 1]] = value
  }

  function buildSettings() {
    var html = '<div class="wrap"><div class="box">'
    html += '<div class="hd"><b>BOSS 自动投递助手 · 设置</b><button data-act="close">×</button></div>'
    html += '<div class="bd">'
    html +=
      '<div class="note">投递用的招呼语是你在 BOSS 直聘里设的「默认打招呼语」（我的 → 设置 → 打招呼语），插件不覆盖它。</div>'

    CHECKS.forEach(function (c) {
      html += '<div class="ck"><input type="checkbox" data-chk="' + c.path + '"><label>' + c.label + '</label></div>'
    })

    html += '<div style="height:6px"></div>'

    // 文本项
    FIELDS.filter(function (f) {
      return !f.num
    }).forEach(function (f) {
      html +=
        '<div class="f"><label>' + f.label + '</label><input type="text" data-in="' + f.path +
        '" placeholder="' + (f.ph || '') + '"></div>'
    })
    // 数值项两两并排
    var nums = FIELDS.filter(function (f) {
      return f.num
    })
    for (var i = 0; i < nums.length; i += 2) {
      html += '<div class="two">'
      ;[nums[i], nums[i + 1]].forEach(function (f) {
        if (!f) return
        html += '<div class="f"><label>' + f.label + '</label><input type="number" data-in="' + f.path + '"></div>'
      })
      html += '</div>'
    }

    html += '</div>'
    html +=
      '<div class="ft"><button class="pri" data-act="save">保存</button><button data-act="reset">恢复默认</button>' +
      '<button data-act="close">关闭</button><span class="tip" data-el="tip">已保存</span></div>'
    html += '</div></div>'
    return html
  }

  function D() {
    return window.BossDefaults || (typeof globalThis !== 'undefined' ? globalThis.BossDefaults : null)
  }

  function showSettings() {
    var existing = document.getElementById(SETTINGS_HOST_ID)
    if (existing) existing.remove()

    var host = document.createElement('div')
    host.id = SETTINGS_HOST_ID
    var shadow = host.attachShadow({ mode: 'open' })
    var style = document.createElement('style')
    style.textContent = CSS
    shadow.appendChild(style)
    var wrap = document.createElement('div')
    wrap.innerHTML = buildSettings()
    shadow.appendChild(wrap)
    ;(document.body || document.documentElement).appendChild(host)

    var defaults = D()

    function fill(cfg) {
      shadow.querySelectorAll('[data-in]').forEach(function (el) {
        var v = getPath(cfg, el.getAttribute('data-in'))
        el.value = v === undefined || v === null ? '' : v
      })
      shadow.querySelectorAll('[data-chk]').forEach(function (el) {
        el.checked = !!getPath(cfg, el.getAttribute('data-chk'))
      })
    }

    function collect(base) {
      var out = JSON.parse(JSON.stringify(base))
      shadow.querySelectorAll('[data-in]').forEach(function (el) {
        var path = el.getAttribute('data-in')
        var isNum = el.type === 'number'
        setPath(out, path, isNum ? Number(el.value) || 0 : el.value)
      })
      shadow.querySelectorAll('[data-chk]').forEach(function (el) {
        setPath(out, el.getAttribute('data-chk'), el.checked)
      })
      return out
    }

    function load() {
      return storageGet(defaults.CONFIG_KEY).then(function (raw) {
        return defaults.sanitizeConfig(raw[defaults.CONFIG_KEY])
      })
    }

    load().then(fill)

    shadow.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]')
      if (!t) return
      var act = t.getAttribute('data-act')
      if (act === 'close') {
        host.remove()
        return
      }
      if (act === 'save') {
        load().then(function (cfg) {
          var next = defaults.sanitizeConfig(collect(cfg))
          return storageSet({ [defaults.CONFIG_KEY]: next }).then(function () {
            fill(next)
            var tip = shadow.querySelector('[data-el="tip"]')
            tip.classList.add('on')
            setTimeout(function () {
              tip.classList.remove('on')
            }, 1500)
          })
        })
        return
      }
      if (act === 'reset') {
        if (!window.confirm('恢复默认配置？当前设置会丢。')) return
        var fresh = defaults.sanitizeConfig(null)
        storageSet({ [defaults.CONFIG_KEY]: fresh }).then(function () {
          fill(fresh)
        })
      }
    })

    // 点遮罩关闭
    shadow.querySelector('.wrap').addEventListener('click', function (e) {
      if (e.target === shadow.querySelector('.wrap')) host.remove()
    })

    return Promise.resolve()
  }

  /* ------------------------------------------------------ 组装 __BOSS_EXT__ */

  var api = {
    storageGet: storageGet,
    storageSet: storageSet,
    storageRemove: storageRemove,
    onStorageChanged: function (fn) {
      listeners.push(fn)
    },
    getToken: function () {
      return Promise.resolve(readCookie(TOKEN_COOKIE))
    },
    relayFetch: function () {
      // 油猴直接同源发请求，没有扩展那种 CSP 兜底通道
      return Promise.resolve({ result: { blocked: true, reason: '油猴版没有中继通道' } })
    },
    openOptions: showSettings
  }

  try {
    window.__BOSS_EXT__ = api
  } catch (e) {
    /* 沙箱里 window 可能只读，下面的 globalThis 兜住 */
  }
  if (typeof globalThis !== 'undefined') globalThis.__BOSS_EXT__ = api

  try {
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('打开设置', showSettings)
  } catch (e) {
    /* 没有菜单命令就算了 */
  }
})();
