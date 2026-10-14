const { AUTO_MODEL_ID } = require("./constants.cjs");
const { modelIdentifier } = require("./resolver.cjs");

function createModelCatalog() {
  let modelsByKey = new Map();
  let complete = false;
  let updatedAt = 0;

  function copyModels(target, models) {
    for (const model of Array.isArray(models) ? models : []) {
      const key = modelIdentifier(model);
      if (!key || key.toLowerCase() === AUTO_MODEL_ID) continue;
      target.set(key, JSON.parse(JSON.stringify(model)));
    }
  }

  function addModels(models) {
    copyModels(modelsByKey, models);
    updatedAt = Date.now();
  }

  function replaceModels(models) {
    // 完整候选先独立复制，避免分页失败或复制异常破坏最近一次可用目录。
    const candidate = new Map();
    copyModels(candidate, models);
    modelsByKey = candidate;
    complete = true;
    updatedAt = Date.now();
  }

  return {
    addModels,
    clear() {
      modelsByKey.clear();
      complete = false;
      updatedAt = Date.now();
    },
    isComplete() {
      return complete;
    },
    replaceModels,
    snapshot() {
      return {
        complete,
        updatedAt,
        models: Array.from(modelsByKey.values()),
      };
    },
    models() {
      return Array.from(modelsByKey.values()).map((model) => JSON.parse(JSON.stringify(model)));
    },
  };
}

module.exports = { createModelCatalog };
