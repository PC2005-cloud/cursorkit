<div align="center">

# CursorKit

**给你的页面装上会呼吸的光标**

25 套鼠标光标动效，封装为零依赖 Web Component。原生 Canvas 绘制，一行 `import` 接入，Vue / React / Next.js 与纯 HTML 通吃。

[在线演示](https://cursor.lxpavilion.top/) &nbsp;·&nbsp; [纯净展示页](https://cursor.lxpavilion.top/show.html)

| <img src="./assets/1.gif" width="420"> | <img src="./assets/2.gif" width="420"> |
|:---:|:---:|
| <img src="./assets/3.gif" width="420"> | <img src="./assets/4.gif" width="420"> |

</div>

## 用法

引入动效模块会自行注册自定义元素，然后在页面任意位置放一个标签。主题光标默认开启，宿主页面无需任何配置。

`snow` 换成任意效果名即可，只用哪个就只引入哪个。`registerAll()` 一次注册全部。

### 方式一：下载文件

把 `src/core/` 和 `src/effects/` 一起复制进项目。动效文件会 `import '../core/base.js'`，只复制单个动效文件会缺依赖。

```html
<script type="module">
  import './src/effects/snow.js';
</script>

<cursor-snow></cursor-snow>
```

### 方式二：npm 安装

```bash
npm i cursorkit-effects
```

```html
<script type="module">
  import 'cursorkit-effects/src/effects/snow.js';
</script>

<cursor-snow></cursor-snow>
```

### 在框架里用

组件是标准 Custom Element，任何框架里都只是「import 一次 + 放一个标签」，不需要 wrapper。

**Vue 3**

```vue
<script setup>
import 'cursorkit-effects/src/effects/snow.js';
</script>

<template>
  <cursor-snow />
</template>
```

不加配置也能渲染，但 Vue 会先把非原生标签当组件解析，开发时刷 "Failed to resolve component" 警告。按官方建议在构建配置里声明跳过：

```js
// vite.config.js
vue({ template: { compilerOptions: { isCustomElement: (t) => t.includes('-') } } })
```

**React**

```jsx
import 'cursorkit-effects/src/effects/snow.js';

export default function App() {
  return <cursor-snow />;
}
```

**Next.js / 任何 SSR 环境**

动效模块顶层就 `extends HTMLElement`，服务端没有 `HTMLElement`，直接 import 会让 SSR 抛错。把注册放进 `useEffect`，只在浏览器里执行：

```jsx
'use client';
import { useEffect } from 'react';

export default function CursorFx() {
  useEffect(() => { import('cursorkit-effects/src/effects/snow.js'); }, []);
  return <cursor-snow />;
}
```

## 浏览器扩展

装个扩展，访问到的每个页面都自动带上动效。[下载最新构建](https://github.com/PC2005-cloud/cursorkit/releases/latest)，解压后在 `edge://extensions` 开启「开发人员模式」，点「加载解压缩的扩展」选中该目录。

Edge / Chrome 通用，详细请看 [`extension/README.md`](./extension/README.md)。

<div align="center">

| | | | | | |
|:---|:---|:---|:---|:---|:---|
| `snow`<br><sub>雪花</sub> | `ice`<br><sub>冰晶</sub> | `pixel`<br><sub>像素</sub> | `sun`<br><sub>太阳</sub> | `silk`<br><sub>丝绸</sub> | `refract`<br><sub>光折射</sub> |
| `orb`<br><sub>光球</sub> | `geom`<br><sub>几何</sub> | `ball`<br><sub>弹球</sub> | `planet`<br><sub>星球</sub> | `mist`<br><sub>迷雾</sub> | `code`<br><sub>代码</sub> |
| `rainbow`<br><sub>彩虹</sub> | `moon`<br><sub>月亮</sub> | `bubble`<br><sub>气泡</sub> | `ink`<br><sub>墨迹</sub> | `doodle`<br><sub>涂鸦</sub> | `firefang`<br><sub>火牙</sub> |
| `hole`<br><sub>黑洞</sub> | `lightning`<br><sub>闪电</sub> | `kaleido`<br><sub>万花筒</sub> | `cell`<br><sub>细胞</sub> | `fish`<br><sub>鱼群</sub> | `firework`<br><sub>烟花</sub> |
| `radar`<br><sub>雷达</sub> | | | | | |

<sub>`no-cursor` / `no-wheel` 可关掉主题光标与滚轮动效，变化实时生效 · JS 里对应 `fx.cursorEnabled` 与 `fx.wheelEnabled` · 图层层级用 `--cursor-effect-z` 覆盖</sub>

<sub>[MIT](./LICENSE)</sub>

</div>
