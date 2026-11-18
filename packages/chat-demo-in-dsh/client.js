/**
 * 浏览器半边：给 DSH 加两个与界面一致的入口。
 *
 * 1. 会话内视图 —— 会话标题栏的 View 标签页里多一个「网页版」，
 *    只渲染当前会话（?embed=1），不显示 chat-demo 自己的会话列表。
 * 2. 左侧面板 —— 侧栏面板列表里一个入口，整页托管 chat-demo（带会话列表）。
 *
 * 页面本身由宿主在 `/webchat/` 提供，不需要用户填 API key。
 */
window.__ModuleLoader__.load({
  id: 'chat-demo-in-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const frameStyle = {
      width: '100%',
      height: '100%',
      border: 'none',
      display: 'block',
      background: '#fff',
    }

    const frame = (src, title) => h('iframe', {
      src,
      title,
      style: frameStyle,
      allow: 'clipboard-write',
    })

    /**
     * 会话内视图：只显示当前会话。
     *
     * DSH 的输入框是常驻的，不会因为我们这个 View 被选中而消失，会压在网页版输入框上。
     * 这里把 iframe 铺成一块覆盖到窗口底部的固定层，正好盖住那块区域；位置跟着视图容器
     * 的实时矩形走，侧栏折叠、窗口缩放都能跟上。
     */
    function ConversationView(props) {
      const sessionId = props?.sessionId === undefined ? '' : String(props.sessionId)
      const host = React.useRef(null)
      const [box, setBox] = React.useState(null)

      React.useEffect(() => {
        const measure = () => {
          const element = host.current
          if (element === null) return
          const rect = element.getBoundingClientRect()
          if (rect.width === 0) return
          setBox({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: Math.max(320, window.innerHeight - rect.top),
          })
        }
        measure()
        window.addEventListener('resize', measure)
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (observer !== null) {
          observer.observe(document.body)
          if (host.current !== null) observer.observe(host.current)
        }
        return () => {
          window.removeEventListener('resize', measure)
          if (observer !== null) observer.disconnect()
        }
      }, [])

      return h('div', { ref: host, style: { height: 'calc(100vh - 132px)', minHeight: 420 } },
        box === null ? null : h('div', {
          style: {
            position: 'fixed',
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            zIndex: 20,
            background: '#fff',
          },
        }, frame(`/webchat/?embed=1&session=${encodeURIComponent(sessionId)}`, 'DeepSeek 网页版')))
    }

    /**
     * 左侧面板：完整的网页版，带自己的会话列表。
     *
     * 和会话内视图同一套路：量出面板容器在窗口里的矩形，铺一块固定层到窗口底部，
     * 这样不会因为主区域的内边距在下面留一条空白。
     */
    function Panel() {
      const host = React.useRef(null)
      const [box, setBox] = React.useState(null)

      React.useEffect(() => {
        const measure = () => {
          const element = host.current
          if (element === null) return
          const rect = element.getBoundingClientRect()
          if (rect.width === 0) return
          setBox({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: Math.max(320, window.innerHeight - rect.top),
          })
        }
        measure()
        window.addEventListener('resize', measure)
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (observer !== null) {
          observer.observe(document.body)
          if (host.current !== null) observer.observe(host.current)
        }
        return () => {
          window.removeEventListener('resize', measure)
          if (observer !== null) observer.disconnect()
        }
      }, [])

      return h('div', { ref: host, style: { height: '100%', minHeight: 1 } },
        box === null ? null : h('div', {
          style: {
            position: 'fixed',
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            zIndex: 20,
            background: '#fff',
          },
        }, frame('/webchat/', 'DeepSeek 网页版')))
    }

    // 官方字标内联为 data URI：侧栏图标不依赖任何额外请求。
    const PANEL_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNyIgaGVpZ2h0PSIyMCIgdmlld0JveD0iMC4xNjMgMS43NSAyNi42MzQgMTkuNiIgZmlsbD0ibm9uZSIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJEZWVwU2VlayI+CiAgPHBhdGggZD0iTTI2LjUxNzQgMy4zOTQ3MUMyNi4yMzUgMy4yNTY3IDI2LjExMzcgMy41MjAwNiAyNS45NDg3IDMuNjUzNDZDMjUuODkyMyAzLjY5NjU5IDI1Ljg0NDYgMy43NTI5NCAyNS43OTY5IDMuODA0NjlDMjUuMzg0NiA0LjI0NTE2IDI0LjkwMjcgNC41MzQzOSAyNC4yNzM3IDQuNDk5ODlDMjMuMzUzNiA0LjQ0ODE0IDIyLjU2ODIgNC43MzczNyAyMS44NzM1IDUuNDQxMTlDMjEuNzI1OCA0LjU3MzQ5IDIxLjIzNTMgNC4wNTU0IDIwLjQ4ODkgMy43MjMwNEMyMC4wOTg1IDMuNTUwNTQgMTkuNzAzNCAzLjM3NzQ2IDE5LjQyOTcgMy4wMDE5N0MxOS4yMzg4IDIuNzM0NTkgMTkuMTg2NSAyLjQzNjczIDE5LjA5MSAyLjE0Mjg5QzE5LjAzMDEgMS45NjU3OSAxOC45Njk3IDEuNzg0NjYgMTguNzY1NiAxLjc1NDE4QzE4LjU0NDIgMS43MTk2OCAxOC40NTc0IDEuOTA1NDEgMTguMzcwNSAyLjA2MDY3QzE4LjAyMzIgMi42OTU0OSAxNy44ODg3IDMuMzk0NzEgMTcuOTAxOSA0LjEwMzEzQzE3LjkzMjQgNS42OTY1IDE4LjYwNTEgNi45NjU1NiAxOS45NDIxIDcuODY4MzRDMjAuMDkzOSA3Ljk3MTg0IDIwLjEzMyA4LjA3NTM1IDIwLjA4NTIgOC4yMjY1OEMxOS45OTM4IDguNTM3NjYgMTkuODg1NyA4LjgzOTU1IDE5Ljc5MDMgOS4xNTA2M0MxOS43MjkzIDkuMzQ5MDEgMTkuNjM4NCA5LjM5MjcxIDE5LjQyNTcgOS4zMDU4OEMxOC42OTIgOC45OTk0IDE4LjA1ODMgOC41NDU3MSAxNy40OTgyIDcuOTk3NzJDMTYuNTQ3NyA3LjA3ODI3IDE1LjY4ODEgNi4wNjMzNiAxNC42MTYyIDUuMjY4NjlDMTQuMzY0NCA1LjA4Mjk2IDE0LjExMjUgNC45MTA0NSAxMy44NTIxIDQuNzQ2QzEyLjc1ODQgMy42ODM5NCAxMy45OTUyIDIuODExNjQgMTQuMjgxNiAyLjcwODE0QzE0LjU4MTIgMi42MDAwMyAxNC4zODU3IDIuMjI4NTcgMTMuNDE3OSAyLjIzMzE3QzEyLjQ1MDIgMi4yMzcyIDExLjU2NDYgMi41NjE1MSAxMC40MzU5IDIuOTkzMzVDMTAuMjcwOCAzLjA1ODMyIDEwLjA5NzIgMy4xMDU0NyA5LjkxOTUxIDMuMTQ0NTdDOC44OTU0IDIuOTUwMjIgNy44MzE2MiAyLjkwNzA5IDYuNzIwNjkgMy4wMzI0NUM0LjYyODc3IDMuMjY1MzMgMi45NTc3NyA0LjI1NDM2IDEuNzI5NTQgNS45NDI2MUMwLjI1NDA0MyA3Ljk3MTg0IC0wLjA5MzI2NzggMTAuMjc3NyAwLjMzMTY3IDEyLjY4MjRDMC43Nzg0NTggMTUuMjE3MSAyLjA3MjI1IDE3LjMxNTMgNC4wNjAwOCAxOC45NTU4QzYuMTIxNTIgMjAuNjU2NyA4LjQ5NTc3IDIxLjQ5MDUgMTEuMjA0NyAyMS4zMzA2QzEyLjg0OTggMjEuMjM1OCAxNC42ODEyIDIxLjAxNTUgMTYuNzQ3MyAxOS4yNjY5QzE3LjI2ODIgMTkuNTI2MiAxNy44MTUxIDE5LjYyOTcgMTguNzIxOSAxOS43MDc0QzE5LjQyMDUgMTkuNzcyMyAyMC4wOTMzIDE5LjY3MjkgMjAuNjE0MyAxOS41NjQ4QzIxLjQzMDIgMTkuMzkyMyAyMS4zNzM5IDE4LjYzNjcgMjEuMDc4OSAxOC40OTgxQzE4LjY4NzQgMTcuMzg0MyAxOS4yMTI0IDE3LjgzNzQgMTguNzM1MSAxNy40NzA2QzE5Ljk1MDEgMTYuMDMzIDIxLjgwNjMgMTMuNDc3NiAyMi4zNzkgOS45OTgyMUMyMi40MzUzIDkuNjE0MDkgMjIuNTA3MiA5LjA3MyAyMi40OTg2IDguNzYxOTJDMjIuNDk0IDguNTcyMTYgMjIuNTM3NyA4LjQ5ODU2IDIyLjc1NDUgOC40NzY3MUMyMy4zNTM2IDguNDA3NzEgMjMuOTM1IDguMjQzODMgMjQuNDY5MiA3Ljk0OTk5QzI2LjAxODggNy4xMDM1NyAyNi42NDM5IDUuNzEzMTggMjYuNzkxMSA0LjA0Njc4QzI2LjgxMjkgMy43OTIwNCAyNi43ODY1IDMuNTI4NjkgMjYuNTE3NCAzLjM5NDcxWk0xMy4wMTQzIDE4LjM5NDZDMTAuNjk2NCAxNi41NzI0IDkuNTcyMiAxNS45NzI2IDkuMTA4MTYgMTUuOTk4NUM4LjY3NDAyIDE2LjAyNDQgOC43NTIyMiAxNi41MjEyIDguODQ3NjggMTYuODQ0OUM4Ljk0NzczIDE3LjE2NDYgOS4wNzc2OCAxNy4zODQ5IDkuMjU5OTYgMTcuNjY1NUM5LjM4NTg5IDE3Ljg1MTIgOS40NzI3MiAxOC4xMjcyIDkuMTM0MDQgMTguMzM0OEM4LjM4NzY2IDE4Ljc5NjUgNy4wODk4NSAxOC4xNzk2IDcuMDI4OSAxOC4xNDkxQzUuNTE4MzMgMTcuMjU5NSA0LjI1NTU5IDE2LjA4NTMgMy4zNjU0NiAxNC40NzkzQzIuNTA1ODEgMTIuOTMzNyAyLjAwNjcgMTEuMjc1MyAxLjkyNDQ3IDkuNTA1NDJDMS45MDI2MiA5LjA3ODE4IDIuMDI4NTUgOC45MjY5NSAyLjQ1NDA2IDguODQ5MzJDMy4wMTQxMyA4Ljc0NTgyIDMuNTkxNDQgOC43MjM5NyA0LjE1MDkzIDguODA2MTlDNi41MTY1NiA5LjE1MTc4IDguNTMwMjcgMTAuMjA5MiAxMC4yMTg1IDExLjg4NDhDMTEuMTgyMiAxMi44Mzg4IDExLjkxMTQgMTMuOTc5IDEyLjY2MjMgMTUuMDkyOUMxMy40NjEgMTYuMjc1NyAxNC4zMjAxIDE3LjQwMjcgMTUuNDE0NCAxOC4zMjY4QzE1LjgwMDggMTguNjUwNSAxNi4xMDkgMTguODk2NiAxNi40MDQgMTkuMDc4M0MxNS41MTQ0IDE5LjE3NzggMTQuMDI5NyAxOS4xOTkxIDEzLjAxNDMgMTguMzk1OFYxOC4zOTQ2Wk0xNC4xMjUyIDExLjI0ODlDMTQuMTI1MiAxMS4wNTkxIDE0LjI3NyAxMC45MDc5IDE0LjQ2NzkgMTAuOTA3OUMxNC41MTEgMTAuOTA3OSAxNC41NTAxIDEwLjkxNjUgMTQuNTg1MiAxMC45MjkyQzE0LjYzMjkgMTAuOTQ2NCAxNC42NzY2IDEwLjk3MjMgMTQuNzExMSAxMS4wMTE0QzE0Ljc3MjEgMTEuMDcxOCAxNC44MDY2IDExLjE1OCAxNC44MDY2IDExLjI0ODlDMTQuODA2NiAxMS40Mzg2IDE0LjY1NDggMTEuNTg5OSAxNC40NjM5IDExLjU4OTlDMTQuMjczIDExLjU4OTkgMTQuMTI1MiAxMS40Mzg2IDE0LjEyNTIgMTEuMjQ4OVpNMTcuNTc1OSAxMy4wMTg4QzE3LjM1NDUgMTMuMTA5NiAxNy4xMzMxIDEzLjE4NzMgMTYuOTIwMyAxMy4xOTU5QzE2LjU5MDMgMTMuMjEzMSAxNi4yMzAzIDEzLjA3OTEgMTYuMDM0OCAxMi45MTUzQzE1LjczMTIgMTIuNjYwNSAxNS41MTM5IDEyLjUxNzkgMTUuNDIzIDEyLjA3MzRDMTUuMzgzOSAxMS44ODM3IDE1LjQwNTcgMTEuNTg5OSAxNS40NDAyIDExLjQyMTRDMTUuNTE4NSAxMS4wNTg1IDE1LjQzMTYgMTAuODI1NyAxNS4xNzU3IDEwLjYxNEMxNC45Njc2IDEwLjQ0MTUgMTQuNzAyNSAxMC4zOTM4IDE0LjQxMTUgMTAuMzkzOEMxNC4zMDI5IDEwLjM5MzggMTQuMjAzNCAxMC4zNDYxIDE0LjEyOTIgMTAuMzA3NkMxNC4wMDc5IDEwLjI0NzIgMTMuOTA3OCAxMC4wOTYgMTQuMDAzMyA5LjkxMDIzQzE0LjAzMzggOS44NDk4NSAxNC4xODE1IDkuNzAzMjIgMTQuMjE2IDkuNjc3MzRDMTQuNjExMSA5LjQ1MjUxIDE1LjA2NjUgOS41MjYxMiAxNS40ODggOS42OTQ2QzE1Ljg3ODQgOS44NTQ0NSAxNi4xNzQgMTAuMTQ3NyAxNi41OTg5IDEwLjU2MjNDMTcuMDMzIDExLjA2MzEgMTcuMTExMiAxMS4yMDExIDE3LjM1ODUgMTEuNTc3MkMxNy41NTQgMTEuODcxIDE3LjczMTcgMTIuMTcyOSAxNy44NTM2IDEyLjUxODVDMTcuOTI3MiAxMi43MzQxIDE3LjgzMTcgMTIuOTEwNyAxNy41NzU5IDEzLjAxODhaIiBmaWxsPSIjMzk2NEZFIi8+Cjwvc3ZnPgo='

    /** 侧栏里的面板图标；size 由侧栏按宽/窄状态给出。 */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('img', {
        src: PANEL_ICON,
        alt: 'DeepSeek',
        style: { height: size, width: size, objectFit: 'contain', display: 'block' },
      })
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        // 网页版保存后通知宿主，让 DSH 原生聊天刷新同一条会话。
        ctx.effect(() => {
          const onMessage = (event) => {
            const data = event?.data
            if (data === null || typeof data !== 'object') return
            if (data.type !== 'chat-demo-in-dsh:saved' || typeof data.sessionId !== 'string') return
            void ctx.sessions?.refreshProjections?.(data.sessionId)?.catch?.(() => {})
          }
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        }, 'webchat.sync')
        ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'chat-demo',
          order: 20,
          label: '网页版',
        }, ConversationView)), 'webchat.view')

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'chat-demo',
        }, Panel)), 'webchat.panel')

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'chat-demo',
          order: 20,
          label: '网页版',
        }, PanelIcon)), 'webchat.panellist')
      },
    }
  },
})



