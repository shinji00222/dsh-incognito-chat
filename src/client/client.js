// dsh-incognito-chat 前端：
//   - 新建对话页「标准模式」右边加一个「无痕」开关（官方插槽 conversation.hero.options）
//   - 无痕会话顶部显示标识（conversation.session.header.actions）
//   - 离开无痕会话时通知 host 丢弃
//
// DSH 的浏览器加载器吃的是经典脚本：window.__ModuleLoader__.load({ id, factory })，
// React 由宿主提供（require('react')），不需要打包。

;(function () {
  var PLUGIN = 'dsh-incognito-chat'
  var API_PREFIX = '/api/incognito-chat'
  var PREFIX = 'session-incognito-'
  var ID_RE = /^session-incognito-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  function isIncognito(id) {
    return typeof id === 'string' && ID_RE.test(id)
  }

  var STYLE = [
    '.dsh-incog-toggle{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;',
    'border:.5px solid var(--dsw-alias-border-l3,#8884);background:transparent;color:var(--dsw-alias-label-secondary,#aaa);',
    'font-size:13px;cursor:pointer;transition:background .15s,color .15s}',
    '.dsh-incog-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,#eee)}',
    '.dsh-incog-toggle[aria-pressed=true]{background:#7c5cff26;border-color:#7c5cff99;color:#b9a8ff}',
    '.dsh-incog-toggle:disabled{opacity:.45;cursor:not-allowed}',
    '.dsh-incog-badge{display:inline-flex;align-items:center;gap:4px;padding:0 8px;height:22px;border-radius:11px;',
    'background:#7c5cff26;color:#b9a8ff;font-size:12px;white-space:nowrap}',
  ].join('')

  function injectStyle() {
    if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="' + PLUGIN + '"]')) return
    var tag = document.createElement('style')
    tag.dataset.pluginCss = PLUGIN
    tag.textContent = STYLE
    document.head.appendChild(tag)
  }

  window.__ModuleLoader__.load({
    id: PLUGIN,
    factory: function (require) {
      var React = require('react')
      var h = React.createElement

      // 一个小眼镜图标（自己画，不依赖宿主图标库的内部名字）
      function Glasses() {
        return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true },
          h('circle', { cx: 6, cy: 15, r: 4 }), h('circle', { cx: 18, cy: 15, r: 4 }),
          h('path', { d: 'M10 15h4M2 15l2-8h4M22 15l-2-8h-4' }))
      }

      return {
        name: PLUGIN,
        inject: ['slots', 'sessions', 'uiWorkspace'],
        apply: function (ctx) {
          try {
            applyIncognito(ctx)
          } catch (error) {
            console.error('[' + PLUGIN + '] apply failed:', error)
            throw error
          }
        },
      }

      function applyIncognito(ctx) {
          injectStyle()

          function rpc(method, payload) {
            return fetch(API_PREFIX + '/' + method, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload || {}),
            }).then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status)
              return res.json()
            }).then(function (r) {
              if (!r || r.ok !== true) throw new Error((r && r.error) || 'request failed')
              return r.value
            })
          }

          // ── 浏览器端留痕清理 ──────────────────────────────────────────
          // DSH 前端会按会话 id 往 localStorage 写东西（输入框草稿 dsh.conversation.<id>、
          // 右侧栏状态 dsh.sidebar-right.v1.<id>、当前会话 dsh.sessions.current）。
          // 桌面版的 localStorage 落在磁盘上，所以无痕会话的这些 key 也要删。
          var ID_IN_TEXT = /session-incognito-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
          function cleanBrowserTraces(keep) {
            var removed = 0
            try {
              for (var i = localStorage.length - 1; i >= 0; i--) {
                var key = localStorage.key(i)
                if (!key) continue
                var ids = (key + ' ' + (localStorage.getItem(key) || '')).match(ID_IN_TEXT) || []
                if (ids.length === 0) continue
                if (ids.every(function (id) { return keep(id) })) continue
                localStorage.removeItem(key)
                removed++
              }
            } catch (e) { /* 隐私模式等情况下 localStorage 不可用，忽略 */ }
            return removed
          }
          function forgetSession(sessionId) {
            var drop = function () { cleanBrowserTraces(function (id) { return id !== sessionId }) }
            drop()
            setTimeout(drop, 800) // 官方 store 可能在组件卸载后还写一次
          }

          // host 能不能保证无痕？启动时问一次，失败就把开关变灰
          var status = { ready: false, checked: false, reason: '正在检查…' }
          var listeners = new Set()
          function setStatus(next) { status = next; listeners.forEach(function (fn) { fn(status) }) }
          rpc('status').then(function (s) {
            // 启动时清掉已经不存在的无痕会话留下的 key（上次没正常关闭的）
            var live = s.liveIds || []
            cleanBrowserTraces(function (id) { return live.indexOf(id) >= 0 })
            setStatus({ ready: !!s.ready, checked: true, reason: s.ready ? '' : '当前 DSH 版本不支持无痕：' + (s.errors || []).join('；') })
          }, function (e) {
            setStatus({ ready: false, checked: true, reason: '无痕插件的 host 端没有加载：' + e.message })
          })
          function useStatus() {
            var pair = React.useState(status)
            React.useEffect(function () {
              listeners.add(pair[1])
              pair[1](status)
              return function () { listeners.delete(pair[1]) }
            }, [])
            return pair[0]
          }

          // 当前会话在哪个工作区。无痕会话要挂进同一个工作区：
          // 不挂的话前端认为「没选工作区」，输入框直接禁用（实测踩过）。
          // 挂进去会让 workspace.json 临时记下这个 id（没有内容），host 端丢弃时会移除。
          function workspaceIdOf(sessionId) {
            var ws = ctx.uiWorkspace.workspaces && ctx.uiWorkspace.workspaces.list.getSnapshot()
            var item = ws && ws.items.find(function (i) { return i.sessionIds.indexOf(sessionId) >= 0 })
            return item ? item.workspaceId : undefined
          }

          /** sessions.create 的返回值在不同版本里形状不同，取不到就返回 undefined */
          function createdIdOf(result) {
            if (typeof result === 'string') return result
            if (result && typeof result.sessionId === 'string') return result.sessionId
            if (result && result.value && typeof result.value.sessionId === 'string') return result.value.sessionId
            return undefined
          }

          async function enterIncognito(fromSessionId) {
            var workspaceId = workspaceIdOf(fromSessionId)
            if (!workspaceId) throw new Error('找不到当前会话所在的工作区')
            var id = PREFIX + crypto.randomUUID()
            var created = createdIdOf(await ctx.sessions.create({ workspaceId: workspaceId, sessionId: id }))
            // 宁可失败也不要把用户带进一个普通会话还以为是无痕
            if (created !== id) throw new Error('DSH 没有按无痕 id 建会话（得到 ' + created + '），已取消')
            ctx.uiWorkspace.openSession(created)
          }

          function leaveIncognito(sessionId) {
            ctx.uiWorkspace.startSession(workspaceIdOf(sessionId))
            rpc('discard', { sessionId: sessionId }).catch(function () {}).then(function () { forgetSession(sessionId) })
          }

          // ── 开关：新建对话页「标准模式」右边 ───────────────────────────
          function IncognitoToggle(props) {
            var sessionId = props.sessionId
            var s = useStatus()
            var busy = React.useState(false)
            var error = React.useState('')
            var on = isIncognito(sessionId)
            var disabled = busy[0] || (!on && !s.ready)
            var title = error[0] || (!on && !s.ready ? s.reason
              : on ? '关闭无痕，回到普通对话' : '无痕对话：不保存记录，不进历史列表，关闭即消失')
            return h('button', {
              type: 'button',
              className: 'dsh-incog-toggle',
              'aria-pressed': on,
              disabled: disabled,
              title: title,
              onClick: function () {
                busy[1](true)
                error[1]('')
                var job = on ? Promise.resolve(leaveIncognito(sessionId)) : enterIncognito(sessionId)
                job.catch(function (e) { error[1](String(e && e.message || e)) })
                  .finally(function () { busy[1](false) })
              },
            }, h(Glasses), on ? '无痕中' : '无痕')
          }

          // ── 会话顶部标识；离开无痕会话时丢弃 ──────────────────────────
          function IncognitoBadge(props) {
            var sessionId = props.sessionId
            var on = isIncognito(sessionId)
            React.useEffect(function () {
              if (!on) return
              return function () { rpc('discard', { sessionId: sessionId }).catch(function () {}).then(function () { forgetSession(sessionId) }) }
            }, [sessionId, on])
            if (!on) return null
            return h('span', { className: 'dsh-incog-badge', title: '这段对话不会保存，离开后消失' }, h(Glasses), '无痕对话')
          }

          // 插槽是 conversation 插件声明的：要等它加载后再注册，否则报 "slot is not declared"
          ctx.inject(['conversation'], function (scope) {
           scope.effect(function () {
            var toggle = scope.slots.register({
              name: 'conversation.hero.options',
              id: PLUGIN + '-toggle',
              order: 10,
              inject: function (sessionId) { return { sessionId: sessionId } },
            }, IncognitoToggle)
            var badge = scope.slots.register({
              name: 'conversation.session.header.actions',
              id: PLUGIN + '-badge',
              order: -20,
              inject: function (sessionId) { return { sessionId: sessionId } },
            }, IncognitoBadge)
            return function () { toggle(); badge() }
           }, PLUGIN + ': toggle and badge')
          })
      }
    },
  })
})()
