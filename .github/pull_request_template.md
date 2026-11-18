## 改了什么

## 怎么验的

- [ ] `node --test test/protocol.test.js`
- [ ] `/webchat/api/self-test` 三项全绿
- [ ] 面板里真的打开了、能发一条消息

## 是否改了上游前端

如果动了 `webview/vendor`，说明改了哪些文件，并确认补丁已重新生成：

- [ ] `webview/patches/0001-dsh-integration.patch` 已更新
- [ ] `webview/dist` 已重新构建并提交
