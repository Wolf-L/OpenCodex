// 仅匹配已审计的提示音模块完整生命周期，顶层压缩名可变化；未知结构保留官方行为。
const CUE_WARMUP_TOKEN = "Dictation cue unavailable";
const CUE_WARMUP_MARKER = "opencodexCueIdleWarmup";
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

// 该函数会作为独立闭包写入响应，不依赖 Node 或新增全局状态。
function opencodexCueIdleWarmup(warmup) {
  const w = window;
  const d = w.document;
  if (!d || !d.documentElement) return;
  let stopped = false;
  let phase = 0;
  let observer;
  let bound;
  let frame;
  let timer;
  let idle;
  function clearPending() {
    if (frame != null) w.cancelAnimationFrame(frame);
    if (timer != null) w.clearTimeout(timer);
    if (idle != null) w.cancelIdleCallback(idle);
    frame = timer = idle = null;
    phase = 0;
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearPending();
    w.clearTimeout(bound);
    observer?.disconnect();
    d.removeEventListener("visibilitychange", visibilityChanged);
    w.removeEventListener("pagehide", stop);
  }
  function ready() {
    if (d.visibilityState === "hidden") return false;
    return Array.from(d.querySelectorAll('[contenteditable="true"]')).some((element) => {
      const rect = element.getBoundingClientRect();
      const style = w.getComputedStyle(element);
      return element.getAttribute("aria-disabled") !== "true" &&
        rect.width > 0 && rect.height > 0 &&
        style.visibility !== "hidden" && style.visibility !== "collapse";
    });
  }
  function stillReady() {
    if (stopped) return false;
    if (ready()) return true;
    clearPending();
    return false;
  }
  function run() {
    idle = timer = null;
    if (!stillReady()) return;
    stop();
    // 只调用官方可选预热，真正播放仍走原始的同步懒初始化与错误处理。
    try { warmup(); } catch {}
  }
  function afterSettled() {
    timer = null;
    if (!stillReady()) return;
    phase = 3;
    if (typeof w.requestIdleCallback === "function" && typeof w.cancelIdleCallback === "function") {
      idle = w.requestIdleCallback(run, { timeout: 2000 });
    } else {
      timer = w.setTimeout(run, 50);
    }
  }
  function afterPaint() {
    frame = timer = null;
    if (!stillReady()) return;
    phase = 2;
    timer = w.setTimeout(afterSettled, 1000);
  }
  function check() {
    if (stopped || phase || !ready()) return;
    phase = 1;
    // 两帧让可用输入框先呈现，再留出短暂稳定期，避免抢占首屏提交。
    if (typeof w.requestAnimationFrame === "function" && typeof w.cancelAnimationFrame === "function") {
      frame = w.requestAnimationFrame(() => {
        frame = null;
        if (stillReady()) frame = w.requestAnimationFrame(afterPaint);
      });
    } else {
      timer = w.setTimeout(afterPaint, 32);
    }
  }
  function visibilityChanged() {
    if (d.visibilityState === "hidden") clearPending();
    else check();
  }
  try {
    w.addEventListener("pagehide", stop);
    d.addEventListener("visibilitychange", visibilityChanged);
    // 非会话页面不必为了预热长期观察 DOM；超时仅跳过可选工作，不影响首次实际使用。
    bound = w.setTimeout(stop, 30000);
    observer = new w.MutationObserver(check);
    observer.observe(d.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["contenteditable", "aria-disabled", "hidden", "style", "class"],
    });
    check();
  } catch {
    stop();
  }
}

function patchDictationCueWarmup(source, onMismatch = () => {}) {
  if (!source.includes(CUE_WARMUP_TOKEN) || source.includes(CUE_WARMUP_MARKER)) return source;
  const matches = Array.from(source.matchAll(cueContractPattern()));
  // 同时验证恢复、播放、解码、取消和挂起路径，不能仅凭一个零延时定时器猜测用途。
  if (matches.length !== 1 || source.split(CUE_WARMUP_TOKEN).length !== 2) {
    onMismatch();
    return source;
  }
  const match = matches[0];
  const callback = `()=>{try{${match.groups.Qpl}()}catch{}}`;
  const original = `window.setTimeout(${callback},0)`;
  const replacement = `(${opencodexCueIdleWarmup.toString()})(${callback})`;
  const patched = match[0].replace(original, replacement);
  return source.slice(0, match.index) + patched + source.slice(match.index + match[0].length);
}

module.exports = { CUE_WARMUP_TOKEN, CUE_WARMUP_MARKER, patchDictationCueWarmup };

