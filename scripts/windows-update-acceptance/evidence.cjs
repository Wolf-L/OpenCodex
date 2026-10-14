"use strict";

const JOURNAL_FIELDS = ["schemaVersion", "transactionId", "status", "targetVersion", "currentVersion", "userDataDir", "exePath", "installDir", "installerPath", "size", "sha256", "backupDir", "inventoryFile", "inventorySize", "inventorySha256", "createdAt", "updatedAt", "error"];
const IDENTITY_FIELDS = ["pid", "parentPid", "exePath", "born"];
const REGISTRY_FIELDS = ["key", "file", "size", "sha256"];
const PRIVATE_FIELD = /(?:token|password|secret|credential|authorization|api[_-]?key)/i;
const pick = (value, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));

// 证据只保留诊断字段；生产 journal 及其事务令牌仍留在隔离现场参与更新校验。
function journalEvidence(journal) {
  const result = pick(journal, JOURNAL_FIELDS);
  for (const field of ["parent", "helper", "candidate"]) {
    if (journal[field] && typeof journal[field] === "object") result[field] = pick(journal[field], IDENTITY_FIELDS);
  }
  if (Array.isArray(journal.registry)) result.registry = journal.registry.map(entry => pick(entry, REGISTRY_FIELDS));
  return sanitizeEvidence(result, typeof journal.token === "string" ? [journal.token] : []);
}

// 所有结构化日志共享递归脱敏；已知事务令牌即使出现在错误文本中也不能导出。
function sanitizeEvidence(value, secrets = []) {
  if (typeof value === "string") return secrets.filter(secret => typeof secret === "string" && secret.length > 0).reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map(entry => sanitizeEvidence(entry, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([field]) => !PRIVATE_FIELD.test(field)).map(([field, entry]) => [field, sanitizeEvidence(entry, secrets)]));
  return value;
}

module.exports = { journalEvidence, sanitizeEvidence };
