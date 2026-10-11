const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../../web-shell/internal/providers/codex-tooltip-dismiss-guard.js"), "utf8");
const start = source.indexOf("  function currentPointerTarget()");
const end = source.indexOf("  function dismissIfPointerLeftTooltips()", start);
assert.ok(start >= 0 && end > start);

function pointerTarget(lastPointer, elementFromPoint) {
  // 执行生产辅助函数，重现键盘聚焦事件没有 clientX/clientY 时的实际异常路径。
  return vm.runInNewContext(`${source.slice(start, end)}; currentPointerTarget()`, { lastPointer, document: { elementFromPoint } });
}

test("tooltip keyboard focus without finite coordinates never calls browser hit testing", () => {
  const target = {};
  for (const [x, y] of [[undefined, undefined], [NaN, 20], [20, Infinity]]) {
    assert.equal(pointerTarget({ x, y, target }, () => { throw new Error("invalid browser hit test"); }), target);
  }
});

test("tooltip real pointer coordinates keep normal hit testing and detached-target fallback", () => {
  const target = {};
  const hit = {};
  assert.equal(pointerTarget({ x: 0, y: 20, target }, (x, y) => {
    assert.equal(x, 0);
    assert.equal(y, 20);
    return hit;
  }), hit);
  assert.equal(pointerTarget({ x: 10, y: 20, target }, () => null), target);
  assert.equal(pointerTarget(null, () => { throw new Error("no pointer"); }), null);
});

test("repeated keyboard focus does not overwrite the last real pointer within a tooltip session", () => {
  assert.match(source, /if \(tooltipObserverExpiryTimer\) \{\s*if \(event\?\.type !== "focusin"\) rememberPointer\(event\);\s*return;/);
});
