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
    '.dsh-incog-mark{display:inline-flex;align-items:center;color:#b9a8ff}',
    '.dsh-incog-delete,.dsh-incog-row-delete{display:inline-flex;align-items:center;justify-content:center;border:none;',
    'background:transparent;color:inherit;cursor:pointer;padding:2px;border-radius:6px;opacity:.75}',
    '.dsh-incog-delete:hover,.dsh-incog-row-delete:hover{opacity:1;background:#7c5cff33}',
    '.dsh-incog-row-delete{width:24px;height:24px;color:var(--dsw-alias-label-secondary,#aaa)}',
    '.dsh-incog-menu-delete{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;',
    'color:#ff7b7b;font-size:13px;padding:6px 10px;border-radius:6px;cursor:pointer;text-align:left}',
    '.dsh-incog-menu-delete:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}',
    '.dsh-incog-badge{display:inline-flex;align-items:center;gap:4px;padding:0 4px 0 8px;height:22px;border-radius:11px;',
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
      function Trash() {
        return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true },
          h('path', { d: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6' }))
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

          /**
           * 删除一个无痕对话：正在看它就先切回普通新对话，再让 host 删掉（停回合、释放内存、清工作区记录），
           * 最后清浏览器里的记录。切换对话不会触发删除，只有用户点删除、或退出 DSH 才会没。
           */
          function deleteIncognito(sessionId, ask) {
            if (!isIncognito(sessionId)) return Promise.resolve()
            if (ask && !window.confirm('删除这段无痕对话？删除后无法恢复。')) return Promise.resolve()
            var current = ctx.uiWorkspace.mainReference && ctx.uiWorkspace.mainReference.sessionId
            if (current === sessionId) ctx.uiWorkspace.startSession(workspaceIdOf(sessionId))
            return rpc('discard', { sessionId: sessionId })
              .catch(function (e) { console.warn('[' + PLUGIN + '] delete failed:', e) })
              .then(function () { forgetSession(sessionId) })
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
              : on ? '关闭无痕，回到普通对话' : '无痕对话：不写盘、不进历史，删除或退出 DSH 后消失')
            return h('button', {
              type: 'button',
              className: 'dsh-incog-toggle',
              'aria-pressed': on,
              disabled: disabled,
              title: title,
              onClick: function () {
                busy[1](true)
                error[1]('')
                // 新建页上的无痕会话还没发过消息，关掉开关直接删，不用确认
                var job = on ? deleteIncognito(sessionId, false) : enterIncognito(sessionId)
                job.catch(function (e) { error[1](String(e && e.message || e)) })
                  .finally(function () { busy[1](false) })
              },
            }, h(Glasses), on ? '无痕中' : '无痕')
          }

          // ── 会话顶部：无痕标识 + 删除按钮 ─────────────────────────────
          function IncognitoBadge(props) {
            var sessionId = props.sessionId
            if (!isIncognito(sessionId)) return null
            return h('span', { className: 'dsh-incog-badge', title: '这段对话不写盘、不进历史；删除或退出 DSH 后消失' },
              h(Glasses), '无痕对话',
              h('button', {
                type: 'button',
                className: 'dsh-incog-delete',
                title: '删除这段无痕对话',
                'aria-label': '删除这段无痕对话',
                onClick: function () { deleteIncognito(sessionId, true) },
              }, h(Trash)))
          }

          // ── 侧栏：行首显示无痕图标 ─────────────────────────────────────
          function SidebarMark(props) {
            if (!isIncognito(props.sessionId)) return null
            return h('span', { className: 'dsh-incog-mark', title: '无痕对话', 'aria-label': '无痕对话' }, h(Glasses))
          }

          // ── 侧栏：悬停时的删除按钮 ─────────────────────────────────────
          function SidebarDelete(props) {
            if (!isIncognito(props.sessionId)) return null
            return h('button', {
              type: 'button',
              className: 'dsh-incog-row-delete',
              title: '删除无痕对话',
              'aria-label': '删除无痕对话',
              onClick: function (e) { e.stopPropagation(); deleteIncognito(props.sessionId, true) },
            }, h(Trash))
          }

          // ── 侧栏：「…」菜单里的删除项 ─────────────────────────────────
          function SidebarMenuDelete(props) {
            if (!isIncognito(props.sessionId)) return null
            var close = props.useMenuOpenState ? props.useMenuOpenState()[1] : function () {}
            return h('button', {
              type: 'button',
              role: 'menuitem',
              className: 'dsh-incog-menu-delete',
              onClick: function () { close(false); deleteIncognito(props.sessionId, true) },
            }, h(Trash), '删除无痕对话')
          }

          // 侧栏插槽由 workspace 插件声明，slots.inject 会等它声明好再注册
          ctx.slots.inject('sidebar.session.row.leading', function* () {
            yield ctx.slots.register({ name: 'sidebar.session.row.leading', id: PLUGIN + '-mark', order: 10 }, SidebarMark)
          })
          ctx.slots.inject('sidebar.workspaces.session.row.action', function* () {
            yield ctx.slots.register({ name: 'sidebar.workspaces.session.row.action', id: PLUGIN + '-delete', order: 50 }, SidebarDelete)
          })
          ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
            yield ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: PLUGIN + '-delete', order: 390 }, SidebarMenuDelete)
          })

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
