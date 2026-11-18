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

    /** 会话内视图：只显示当前会话。 */
    function ConversationView(props) {
      const sessionId = props?.sessionId === undefined ? '' : String(props.sessionId)
      return h('div', { style: { height: '100%', minHeight: 0 } },
        frame(`/webchat/?embed=1&session=${encodeURIComponent(sessionId)}`, 'DeepSeek 网页版'))
    }

    /** 左侧面板：完整的网页版，带自己的会话列表。 */
    function Panel() {
      return h('div', { style: { height: '100%', minHeight: 0 } }, frame('/webchat/', 'DeepSeek 网页版'))
    }

    /** 侧栏里的面板图标；size 由侧栏按宽/窄状态给出。 */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('img', {
        src: '/webchat/brand-mark.svg',
        alt: 'DeepSeek',
        style: { height: size, width: 'auto', display: 'block' },
      })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
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
          label: 'DeepSeek',
        }, PanelIcon)), 'webchat.panellist')
      },
    }
  },
})

