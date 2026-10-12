# dsh-cursorkit

把 [CursorKit](https://cursor.lxpavilion.top/) 的鼠标光标动效铺进 **DeepSeek Harness** 的 Web 界面。

装好之后，光标动效覆盖整个窗口，包括各个面板、弹出菜单与对话框之上。

## 安装

### 命令行

```bash
dsh plugin --profile <profile> add dsh-cursorkit
```

### 插件页面

侧栏打开 **「插件」** 面板 → **「添加插件」** → 填入 `dsh-cursorkit` → 安装。

> 安装完成后需要**重启 Harness** 才会加载。之后升级要先卸载再安装（DSH 暂不支持插件自动更新）。

## 使用

**设置 → 通用 → 「光标动效」**，在下拉里选择，即时生效，选择会被记住。

默认是「雪花」。动效生效时原生光标会被隐藏 —— 这是 CursorKit 的设计，鼠标位置由动效指示。按住 `Shift` / `Ctrl` / `Cmd` 右键仍可唤出原生菜单。

## 25 种效果

雪花 · 冰晶 · 像素 · 太阳 · 丝绸 · 光折射 · 光球 · 几何体 · 彩球 · 星球 · 云雾 · 代码 · 彩虹 · 月亮 · 气泡 · 水墨 · 涂鸦 · 火牙 · 黑洞 · 闪电 · 万花筒 · 细胞 · 鱼群 · 烟火 · 雷达

## 开发

```bash
npm install
npm run build     # src/ → lib/
```

本插件内联的是已发布的 npm 包 `cursorkit-effects`，修改效果源码后需要重新发布该包。

## License

MIT © PC2005-cloud
