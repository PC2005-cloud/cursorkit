# CursorKit 浏览器扩展

把仓库根 `src/` 里的 25 套光标动效装进浏览器。Edge 与 Chrome 通用（同为 Chromium 内核、同一套 MV3）。

## 构建

这个目录是一个自包含的 npm 项目 —— 仓库根本身不需要任何依赖，只有扩展需要打包器。

```bash
cd extension
npm install
npm run build
```

产物在 `extension/dist/`，加载它即可。

## 加载到浏览器

1. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`）
2. 打开「开发人员模式」
3. 点「加载解压缩的扩展」，选择 `extension/dist/` 目录
4. 工具栏出现 CursorKit 图标，点开可切换效果与开关

改动源码后需要重新 `npm run build`，然后在扩展页点「重新加载」。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run build` | 打包两个内容脚本 + 复制静态文件到 `dist/` |
| `npm run check` | 产物静态自检（文件、manifest、world 配置、动效是否全内联） |
| `npm run test` | 协议测试（配置到挂载的决策链路） |
| `npm run icons` | 由仓库根的 `logo.svg` 重新生成四个尺寸图标 |
| `npm run verify` | 依次跑 build → check → test |

## 结构

```
manifest.json          MV3 清单
entries/effects.js     主世界入口：引入 25 个动效并挂载
entries/content.js     隔离世界入口：读 chrome.storage，postMessage 下发配置
popup.html/css/js      弹窗界面
icons/                 16/32/48/128 图标
tools/                 构建与验证脚本
dist/                  构建产物（不入库）
```

## 为什么拆成两个内容脚本

这是本扩展唯一需要解释的设计，因为不拆就跑不起来。

**Edge 内容脚本的隔离环境里，`window.customElements` 是 `null`**（属性描述符是一个返回 null 的 getter，且 `writable: false`，只能 `defineProperty` 覆盖）。实测后果：

| 尝试 | 结果 |
|---|---|
| 直接注册自定义元素 | `Cannot read properties of null (reading 'get')` |
| 覆盖 `window.customElements` | 能覆盖，但 `document.createElement` 不再返回自定义元素 |
| `Object.create(类.prototype)` | `instanceof HTMLElement` 为 true，但 DOM 的 brand check 不认，`attachShadow` 报 `Illegal invocation` |
| 把方法 `.call()` 到真实元素 | 方法能进，但构造函数没跑，实例字段（如 `input`）不存在 |
| 调用类构造函数 | `Class constructor cannot be invoked without 'new'` |

**只有主世界（`"world": "MAIN"`）里 `customElements` 才是完整的。** 但主世界读不到 `chrome.storage`（实测 `chrome.storage === undefined`）。所以：

- `entries/effects.js` 注入主世界，负责真正挂载动效
- `entries/content.js` 留在隔离世界，只做配置桥
- 两者用 `window.postMessage` 握手：主世界就绪后发 `cursorkit:ready`，隔离世界回送 `cursorkit:settings`

主世界注入的代价是动效代码运行在页面自己的 JS 环境里，理论上页面能看见它，也受页面 CSP 影响。目前实测的站点均正常。

## 权限

只有两个，且都是必需：

| 权限 | 用途 |
|---|---|
| `storage` | 保存效果选择与开关（`chrome.storage.sync`） |
| `tabs` | 弹窗里读取当前标签页域名，用于「在本站启用」开关 |

没有申请任何网络、脚本注入或内容拦截相关的敏感权限。
