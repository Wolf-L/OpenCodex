// 四个功能在窄屏转入原生 Explore 分类；不修改账户 pinOverrides，也不另建菜单或复制 React 节点。
const MOBILE_NAVIGATION_TOKEN = "standalonePrimaryDestinations:i,exploreDestinations";
const MOBILE_NAVIGATION_MARKER = "opencodexMobileNavigationDefaults";
const MOBILE_NAVIGATION_QUERY = "(max-width: 767px), (max-width: 960px) and (max-height: 500px)";
const MOBILE_DESTINATIONS = ["builtin:images", "builtin:automations", "builtin:library", "builtin:skills"];

// Windows 与 Linux 26.1007 的已审计完整分类函数仅有这些压缩绑定差异；其他结构一律不猜测。
const CONTRACTS = [
  { group: "yjo", areas: "YA", ids: "ej", eligible: "fFn", explore: "Hts", customize: "U", open: "te", enabled: "ne" },
  { group: "EMo", areas: "oj", ids: "dj", eligible: "tFn", explore: "Qts", customize: "te", open: "ne", enabled: "re" },
];
function groupingSource(c) {
  return 'function ' + c.group + '(e,t,n){let r=Object.values(' + c.areas + ').flatMap(t=>{if(t.rail!==`primary`)return[];let n=e.find(e=>e.id===t.destinationId);return n==null?[]:[{area:t.sidebar??`mission-control`,item:n}]}),i=e.filter(e=>e.id===' + c.ids + '.images&&(n===`free`||n===`free_workspace`||t)||e.id===' + c.ids + '.library&&t);return{primaryDestinations:r,standalonePrimaryDestinations:i,exploreDestinations:e.filter(e=>' + c.eligible + '(e)&&e.railPlacement!==`primary`&&!i.includes(e))}}';
}
function railSource(c) {
  return 'primaryDestinations:P,renderExploreMenu:' + c.explore + ',customize:' + c.customize + ',onOpenSidebarPopover:' + c.open + ',sidebarCustomizationEnabled:' + c.enabled + ',showCustomizeSidebarAction:o';
}
function patchMobileNavigationDefaults(source, onMismatch = () => {}) {
  if (!source.includes(MOBILE_NAVIGATION_TOKEN) || source.includes(MOBILE_NAVIGATION_MARKER)) return source;
  const supported = CONTRACTS.filter(c => source.split(groupingSource(c)).length === 2 && source.split(railSource(c)).length === 2);
  // 分类函数与实际 rail 调用必须成套唯一命中，避免只隐藏固定入口却没有放回 Explore。
  if (supported.length !== 1 || source.split(MOBILE_NAVIGATION_TOKEN).length !== 2) {
    onMismatch();
    return source;
  }
  const c = supported[0];
  const original = groupingSource(c);
  const mobile = 'function ' + MOBILE_NAVIGATION_MARKER + '(){return typeof window!=="undefined"&&typeof window.matchMedia==="function"&&window.matchMedia(' + JSON.stringify(MOBILE_NAVIGATION_QUERY) + ').matches}';
  // 先沿用原生分类结果，再把四项从固定/主导航转回 Explore。菜单点击、预加载、标记已读及原生置顶保存均保留。
  const branch = 'if(' + MOBILE_NAVIGATION_MARKER + '()){let a=new Set(' + JSON.stringify(MOBILE_DESTINATIONS) + ');return{primaryDestinations:r.filter(e=>!a.has(e.item.id)),standalonePrimaryDestinations:i.filter(e=>!a.has(e.id)),exploreDestinations:e.filter(e=>a.has(e.id)||' + c.eligible + '(e)&&e.railPlacement!==`primary`&&!i.includes(e)).map(e=>a.has(e.id)?{...e,visibleByDefault:!1}:e)}}';
  const grouped = mobile + original.replace('return{primaryDestinations:r,', branch + 'return{primaryDestinations:r,');
  // Plugins 另有不参与 pinOverrides 的固定 customize 按钮；窄屏去掉该重复入口，保留 Explore 中的真实 skills destination。
  const rail = railSource(c).replace('customize:' + c.customize + ',', 'customize:' + MOBILE_NAVIGATION_MARKER + '()?null:' + c.customize + ',');
  return source.replace(original, grouped).replace(railSource(c), rail);
}
module.exports = { MOBILE_NAVIGATION_TOKEN, MOBILE_NAVIGATION_MARKER, MOBILE_NAVIGATION_QUERY, patchMobileNavigationDefaults };
