/**
 * `cursorkit-effects` 是零依赖的原生 ESM 包，不带类型声明。
 *
 * 插件只在顶层副作用引入效果模块（其作用是注册自定义元素），
 * 不消费导出值。效果模块的默认导出就是那个自定义元素类。
 */
declare module 'cursorkit-effects/effects/*.js' {
  const CursorEffect: CustomElementConstructor;
  export default CursorEffect;
}
