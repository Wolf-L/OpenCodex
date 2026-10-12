const PAGE_MENU_TOKEN = "if(globalThis.window?.electronBridge?.showContextMenu==null)return y;";
const PAGE_MENU_MARKER = "opencodexPageContextMenuFallback";
const POINTER_SENSOR_TOKEN = "eventName:`onPointerDown`,handler:";
const SIDEBAR_TOUCH_DRAG_FLAG = "__opencodexSkipSidebarTouchDrag";
const ASYNC_MENU_TOKEN = 'window.addEventListener(`blur`,t,n)';
const ASYNC_MENU_MARKER = 'opencodexMenuWindowBlur';
const DOM_TRIGGER_TOKEN = 't[140]!==E||t[141]!==Pe';
const DOM_TRIGGER_MARKER = 'data-opencodex-context-menu-trigger';

// 只接受已审计的完整菜单构造片段；顶层压缩绑定可变，项目/页面权限判断和原回调不动。
const PAGE_CONTRACT = 'let y=v;if(globalThis.window?.electronBridge?.showContextMenu==null)return y;let b;t[28]!==l.blockId||t[29]!==l.id||t[30]!==a?(b=()=>{let e=a.get({{page}},l.id);return[...a.get({{setting}},`is_default_browser`)===!0?[]:[{id:`open-in-external-browser`,message:{{message}}({id:`externalLink.contextMenu.openInExternalBrowser`,defaultMessage:`Open in external browser`,description:`Context menu action to open an external link in the external browser`}),onSelect:()=>{{{open}}(a,e,l.blockId)}}],{id:`copy-page-link`,message:{{message}}({id:`externalLink.contextMenu.copyLink`,defaultMessage:`Copy link`,description:`Context menu action to copy an external link`}),onSelect:()=>{{{copy}}(a,e,l.blockId)}}]},t[28]=l.blockId,t[29]=l.id,t[30]=a,t[31]=b):b=t[31];let x;return t[32]!==y||t[33]!==b?(x=(0,{{jsx}}.jsx)({{menu}},{getItems:b,children:y}),t[32]=y,t[33]=b,t[34]=x):x=t[34],x';
const POINTER_CONTRACT = '{{sensor}}.activators=[{eventName:`onPointerDown`,handler:(e,t)=>{let{nativeEvent:n}=e,{onActivation:r}=t;return!n.isPrimary||n.button!==0?!1:(r?.({event:n}),!0)}}]';
const ASYNC_MENU_CONTRACT = 'if(e.signal.addEventListener(`abort`,o,{once:!0}),!T&&b===`contextmenu`&&u==null&&t==null){let t=()=>{e.abort(),M(null),d?.(!1)},n={capture:!0,signal:r.signal};document.addEventListener(`pointerdown`,t,n),document.addEventListener(`contextmenu`,t,n),document.addEventListener(`keydown`,e=>{e.key===`Escape`&&t()},n),window.addEventListener(`blur`,t,n)}';
const DOM_CONTRACTS = [
  ['je=e=>{Oe?.(e),e.stopPropagation(),!(E||e.defaultPrevented)&&(T?Ee(e):b===`click`&&(e.preventDefault(),Ce(!0)),b===`contextmenu`&&j===`dropdown`&&Ce(!0))}', fragment => fragment.replace('e.stopPropagation()', '(T||b===`click`)&&e.stopPropagation()')],
  ['ke=e=>{if(De.props.onKeyDown?.(e),!(E||e.defaultPrevented||e.target!==e.currentTarget||e.key!==`ContextMenu`&&!(e.key===`F10`&&e.shiftKey)||e.altKey||e.ctrlKey||e.metaKey)){if(e.preventDefault(),e.stopPropagation(),T)Ee(e);else if(b===`click`)Ce(!0);else{let t=e.currentTarget.getBoundingClientRect();e.currentTarget.dispatchEvent(new MouseEvent(`contextmenu`,{bubbles:!0,cancelable:!0,clientX:t.left,clientY:t.bottom}))}}}', fragment => fragment.replace('e.target!==e.currentTarget', 'e.target!==e.currentTarget&&!(e.currentTarget.hasAttribute?.(`' + DOM_TRIGGER_MARKER + '`)&&e.target?.matches?.(`[data-app-action-sidebar-thread-row]`))').replace('let t=e.currentTarget.getBoundingClientRect()','let t=(e.currentTarget.hasAttribute?.(`' + DOM_TRIGGER_MARKER + '`)?e.target:e.currentTarget).getBoundingClientRect()')],
  ['let r;t[140]!==E||t[141]!==Pe?(r=(0,{{jsx}}.jsx)({{trigger}},{asChild:!0,disabled:E,children:Pe}),t[140]=E,t[141]=Pe,t[142]=r):r=t[142]', fragment => fragment.replace('asChild:!0,disabled:E,children:Pe', 'asChild:!1,className:`contents`,\"' + DOM_TRIGGER_MARKER + '\":``,onContextMenu:e=>e.stopPropagation(),onKeyDown:e=>{!e.defaultPrevented&&(e.key===`ContextMenu`||e.key===`F10`&&e.shiftKey)&&Ae(e)},disabled:E,children:Pe')],
];

function contractPattern(contract) {
  const seen = new Set();
  return new RegExp(contract.split(/(\{\{[A-Za-z]+\}\})/).map(part => {
    const placeholder = /^\{\{([A-Za-z]+)\}\}$/.exec(part);
    if (!placeholder) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const name = placeholder[1];
    if (seen.has(name)) return `\\k<${name}>`;
    seen.add(name);
    return `(?<${name}>[A-Za-z_$][\\w$]*)`;
  }).join(""), "g");
}

function patchUnique(source, contract, token, marker, replace, onMismatch) {
  if (!source.includes(token) || source.includes(marker)) return source;
  const matches = Array.from(source.matchAll(contractPattern(contract)));
  // 未知、重复或半匹配结构原样保留，不能误删其他组件的原生能力检查。
  if (matches.length !== 1 || source.split(token).length !== 2) {
    onMismatch(marker);
    return source;
  }
  const match = matches[0];
  return source.slice(0, match.index) + replace(match[0]) + source.slice(match.index + match[0].length);
}

function patchContextMenuCompatibility(source, onMismatch = () => {}) {
  let patched = patchUnique(source, PAGE_CONTRACT, PAGE_MENU_TOKEN, PAGE_MENU_MARKER,
    fragment => fragment.replace(PAGE_MENU_TOKEN, `/*${PAGE_MENU_MARKER}*/`), onMismatch);
  // 仅让插件标记的手机侧栏触摸跳过拖拽激活；事件仍交给原版长按菜单与其他监听器。
  patched = patchUnique(patched, POINTER_CONTRACT, POINTER_SENSOR_TOKEN, SIDEBAR_TOUCH_DRAG_FLAG,
    fragment => fragment.replace("return!n.isPrimary", `return n.${SIDEBAR_TOUCH_DRAG_FLAG}===!0||!n.isPrimary`), onMismatch);
  // 元素 blur 会被 capture 监听误认为窗口失焦：异步菜单一取得焦点就关闭。只监听窗口本身失焦。
  patched = patchUnique(patched, ASYNC_MENU_CONTRACT, ASYNC_MENU_TOKEN, ASYNC_MENU_MARKER,
    fragment => fragment.replace(ASYNC_MENU_TOKEN, 'window.addEventListener(`blur`,t,{signal:r.signal})/*' + ASYNC_MENU_MARKER + '*/'), onMismatch);
  if (patched.includes(DOM_TRIGGER_TOKEN) && !patched.includes(DOM_TRIGGER_MARKER)) {
    const matches = DOM_CONTRACTS.map(([contract]) => Array.from(patched.matchAll(contractPattern(contract))));
    if (matches.every(group => group.length === 1)) {
      // 复合行组件会丢弃 Radix 注入的 pointer/key props。让原版 Trigger 自己渲染 display:contents 容器。
      // 子节点菜单先执行其原回调，再冒泡给 Trigger；Trigger 阻止继续冒泡，避免嵌套菜单同时打开。
      matches.forEach(([match], index) => { patched = patched.replace(match[0], DOM_CONTRACTS[index][1](match[0])); });
    } else onMismatch(DOM_TRIGGER_MARKER);
  }
  return patched;
}

module.exports = { PAGE_MENU_TOKEN, PAGE_MENU_MARKER, POINTER_SENSOR_TOKEN, SIDEBAR_TOUCH_DRAG_FLAG, ASYNC_MENU_TOKEN, ASYNC_MENU_MARKER, DOM_TRIGGER_TOKEN, DOM_TRIGGER_MARKER, patchContextMenuCompatibility };
