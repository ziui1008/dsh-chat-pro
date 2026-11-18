/**
 * 浏览器半边：在 DSH 的「插件」页加一个页签，整页嵌 chat-demo。
 * 页面本身由宿主在 `/webchat/` 提供，不需要用户填 API key。
 */
window.__ModuleLoader__.load({
  id: 'chat-demo-in-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function WebchatPanel() {
      return h('div', {
        style: {
          height: 'calc(100vh - 140px)',
          minHeight: 480,
          borderRadius: 12,
          overflow: 'hidden',
          border: '1px solid var(--dsh-border, rgba(128,128,128,.24))',
        },
      }, h('iframe', {
        src: '/webchat/',
        title: 'DeepSeek 网页版',
        style: { width: '100%', height: '100%', border: 'none', display: 'block', background: '#fff' },
        allow: 'clipboard-write',
      }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('plugins.tab', () => ctx.slots.register({
          name: 'plugins.tab',
          id: 'chat-demo-in-dsh',
          order: 10,
          label: 'DeepSeek',
        }, WebchatPanel)), 'webchat.tab')
      },
    }
  },
})
