/**
 * 保证 pi-web-ui 的自定义元素真的被注册。
 *
 * 问题：这些元素是靠**模块副作用**注册的 —— `AgentInterface.js` 末尾那行
 * `customElements.define("agent-interface", AgentInterface)`。而我们只在 `main.ts`
 * 里 `import { AgentInterface }` 拿它做类型 cast 和 `document.createElement`，
 * bundler 完全可能判定「这个 import 没被真正用到」，把整段 tree-shake 掉。
 * 结果：页面渲染出 `<agent-interface>` 标签，但它从没被 define 升级，
 * 于是既没有 shadow DOM 也没有输入框 —— 界面看着是空的，控制台还静悄悄的。
 *
 * 这里显式 new 一个实例并读一个属性，把引用「用掉」，让 bundler 没理由丢掉这个模块。
 * new 本身不产生副作用（自定义元素的构造逻辑在被 define 之后的第一次 createElement
 * 时才跑），所以即便真的执行了也只是浪费一个对象。
 */
import { AgentInterface } from '@earendil-works/pi-web-ui';

let registered = false;

/** 幂等：确保元素已注册，返回是否成功。 */
export function ensureElementsRegistered(): boolean {
  if (registered) return true;
  if (typeof customElements === 'undefined') return false;
  if (customElements.get('agent-interface')) {
    registered = true;
    return true;
  }
  // 摸一个实例属性，强制这个 import 产生真实引用（见文件头说明）。
  const probe = new AgentInterface();
  void probe.tagName;
  registered = customElements.get('agent-interface') !== undefined;
  return registered;
}
