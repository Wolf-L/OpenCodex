// 仅匹配已审计的提示音模块完整生命周期，顶层压缩名可变化；未知结构保留官方行为。
const CUE_SOUNDS_TOKEN = "Dictation cue unavailable";
const CUE_SOUNDS_MARKER = "opencodexDictationCueSoundsDisabled";
const CUE_CONTRACT = "function {{Xpl}}(){try{let{context:e}={{Qpl}}();e.state!==`running`&&e.resume().catch(()=>{}),{{idle}}(e)}catch{}}function {{Zpl}}(e,t){t?.mark(`cue_requested`),{{tml}}?.();let n=null,r=!1,i=null,a=!1,o=e=>{a||(a=!0,window.clearTimeout(c),n!=null&&(n.onended=null,r&&n.stop(),n.disconnect()),{{tml}}===s&&({{tml}}=null,i!=null&&{{idle}}(i)),e!=null&&t?.mark(e))},s=()=>o(`cue_cancelled`),c=window.setTimeout(()=>o(`cue_failed`),5e3);{{tml}}=s;let l=(e,i)=>{a||(n=e.createBufferSource(),n.buffer=i,n.connect(e.destination),n.onended=()=>o(),n.start(),r=!0,t?.mark(`cue_scheduled`))};try{let{context:t,buffers:n,decoded:r}={{Qpl}}();i=t,window.clearTimeout({{nml}});let a=r[e];a!=null&&t.state===`running`?l(t,a):Promise.all([n[e],t.state===`running`?void 0:t.resume()]).then(([e])=>l(t,e)).catch(()=>o(`cue_failed`))}catch{o(`cue_failed`)}return s}function {{Qpl}}(){if({{state}}!=null&&{{state}}.context.state!==`closed`)return {{state}};let e=new AudioContext({latencyHint:`interactive`}),t=async t=>{let n=await fetch(t);if(!n.ok)throw Error(`Dictation cue unavailable`);return e.decodeAudioData(await n.arrayBuffer())};{{state}}={context:e,decoded:{},buffers:{start:t({{eml}}.start),stop:t({{eml}}.stop),error:t({{eml}}.error)}};let n={{state}};for(let t of[`start`,`stop`,`error`])n.buffers[t].then(e=>{n.decoded[t]=e}).catch(()=>{{{state}}===n&&({{state}}=null,e.close().catch(()=>{}))});return e.resume().catch(()=>{}),{{idle}}(e),n}function {{idle}}(e){window.clearTimeout({{nml}}),{{nml}}=window.setTimeout(()=>{{{tml}}==null&&e.state===`running`&&e.suspend().catch(()=>{})},6e4)}var {{eml}},{{state}},{{tml}},{{nml}};function {{rml}}(){return({{rml}}=e((()=>{{{Gpl}}(),{{qpl}}(),{{Ypl}}(),{{eml}}={start:{{Kpl}},stop:{{Jpl}},error:{{Wpl}}},{{state}}=null,{{tml}}=null,typeof window<`u`&&window.setTimeout(()=>{try{{{Qpl}}()}catch{}},0)})))()}";

function cueContractPattern() {
  const seen = new Set();
  const parts = CUE_CONTRACT.split(/(\{\{[A-Za-z]+\}\})/);
  return new RegExp(parts.map((part) => {
    const placeholder = /^\{\{([A-Za-z]+)\}\}$/.exec(part);
    if (!placeholder) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const name = placeholder[1];
    if (seen.has(name)) return `\\k<${name}>`;
    seen.add(name);
    return `(?<${name}>[A-Za-z_$][\\w$]*)`;
  }).join(""), "g");
}

// 用户选择关闭 Web 提示音：只替换提示音入口，不拦截 AudioContext 或录音/媒体接口。
function patchDictationCueSounds(source, onMismatch = () => {}) {
  if (!source.includes(CUE_SOUNDS_TOKEN) || source.includes(CUE_SOUNDS_MARKER)) return source;
  const matches = Array.from(source.matchAll(cueContractPattern()));
  // 完整确认已审计的生命周期后才禁用；未知、部分或重复模块保持官方行为并报告诊断。
  if (matches.length !== 1 || source.split(CUE_SOUNDS_TOKEN).length !== 2) {
    onMismatch();
    return source;
  }
  const match = matches[0];
  const { Xpl: acceptedStart, Zpl: play, Qpl: initialize } = match.groups;
  const playStart = match[0].indexOf(`function ${play}(`);
  const initializerStart = match[0].indexOf(`function ${initialize}(`);
  // 保留 accepted-start 的正常返回和播放入口的可调用取消句柄；不伪造播放成功/失败事件。
  const silentEntries = `function ${acceptedStart}(){/*${CUE_SOUNDS_MARKER}*/}function ${play}(e,t){return()=>{}}`;
  const warmup = `,typeof window<\`u\`&&window.setTimeout(()=>{try{${initialize}()}catch{}},0)`;
  if (playStart < 0 || initializerStart < playStart || !match[0].includes(warmup)) {
    onMismatch();
    return source;
  }
  // 解码/挂起函数原文保留，但三个调用入口全部移除；URL 常量和原始 WAV 文件不改动。
  const patched = silentEntries + match[0].slice(initializerStart).replace(warmup, "");
  return source.slice(0, match.index) + patched + source.slice(match.index + match[0].length);
}

module.exports = { CUE_SOUNDS_TOKEN, CUE_SOUNDS_MARKER, patchDictationCueSounds };
