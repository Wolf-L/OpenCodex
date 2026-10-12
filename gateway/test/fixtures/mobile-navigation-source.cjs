// 仅抽取已审计的原生分类函数与调用参数；测试不加载或执行完整供应商应用。
module.exports = {
  "windows": {
    "grouping": "function yjo(e,t,n){let r=Object.values(YA).flatMap(t=>{if(t.rail!==`primary`)return[];let n=e.find(e=>e.id===t.destinationId);return n==null?[]:[{area:t.sidebar??`mission-control`,item:n}]}),i=e.filter(e=>e.id===ej.images&&(n===`free`||n===`free_workspace`||t)||e.id===ej.library&&t);return{primaryDestinations:r,standalonePrimaryDestinations:i,exploreDestinations:e.filter(e=>fFn(e)&&e.railPlacement!==`primary`&&!i.includes(e))}}",
    "rail": "primaryDestinations:P,renderExploreMenu:Hts,customize:U,onOpenSidebarPopover:te,sidebarCustomizationEnabled:ne,showCustomizeSidebarAction:o"
  },
  "linux": {
    "grouping": "function EMo(e,t,n){let r=Object.values(oj).flatMap(t=>{if(t.rail!==`primary`)return[];let n=e.find(e=>e.id===t.destinationId);return n==null?[]:[{area:t.sidebar??`mission-control`,item:n}]}),i=e.filter(e=>e.id===dj.images&&(n===`free`||n===`free_workspace`||t)||e.id===dj.library&&t);return{primaryDestinations:r,standalonePrimaryDestinations:i,exploreDestinations:e.filter(e=>tFn(e)&&e.railPlacement!==`primary`&&!i.includes(e))}}",
    "rail": "primaryDestinations:P,renderExploreMenu:Qts,customize:te,onOpenSidebarPopover:ne,sidebarCustomizationEnabled:re,showCustomizeSidebarAction:o"
  }
};
