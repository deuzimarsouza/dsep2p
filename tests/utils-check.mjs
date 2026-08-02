import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.resolve(testsDirectory, "..", "app.js"), "utf8");
const elements = new Map();

function createElementStub() {
  return {
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    dataset: {},
    firstChild: { textContent: "" },
    classList: { add() {}, remove() {} },
    addEventListener() {},
    setAttribute() {},
    replaceChildren() {},
    append() {},
    querySelector() { return null; },
  };
}

const documentStub = {
  querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, createElementStub());
    return elements.get(selector);
  },
  activeElement: null,
};

const windowStub = {
  __PONTE_TEST__: true,
  addEventListener() {},
  setTimeout,
  clearTimeout,
  location: { hash: "", pathname: "/", search: "", href: "https://example.test/" },
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  navigator: { userAgent: "Test", onLine: true },
  history: { replaceState() {} },
  crypto: webcrypto,
  performance,
  URL,
  Blob,
  ArrayBuffer,
  Uint8Array,
  console,
  setTimeout,
  clearTimeout,
};

vm.runInNewContext(source, sandbox, { filename: "app.js" });
const utils = windowStub.PonteUtils;
assert(utils, "As funções de validação precisam ser expostas para teste.");

assert.equal(utils.normalizeCode("abci 0123-xyz9"), "ABC23XYZ");
assert.equal(utils.displayCode("ABCDEFGH"), "ABCD EFGH");
assert.equal(utils.getExtension("Relatório.Final.PDF"), "pdf");
assert.equal(utils.sanitizeFilename("../../relatório.pdf"), "relatório.pdf");

const longName = `${"a".repeat(220)}.pdf`;
const sanitizedLongName = utils.sanitizeFilename(longName);
assert.equal(sanitizedLongName.length, 180);
assert(sanitizedLongName.endsWith(".pdf"), "Nomes longos precisam preservar a extensão.");

assert.equal(
  utils.validateFileMeta({ name: "foto.JPG", size: 25 * 1024 * 1024, type: "image/jpeg" }).ok,
  true,
);
assert.equal(
  utils.validateFileMeta({ name: "foto.jpg", size: 25 * 1024 * 1024 + 1, type: "image/jpeg" }).reason,
  "FILE_TOO_LARGE",
);
assert.equal(
  utils.validateFileMeta({ name: "foto.jpg", size: 10, type: "text/html" }).reason,
  "MIME_MISMATCH",
);
assert.equal(utils.validateFileMeta({ name: "planilha.xlsx", size: 10, type: "" }).ok, true);
assert.equal(
  utils.validateFileMeta({
    type: "file-offer",
    name: "documento.pdf",
    size: 10,
    mime: "application/pdf",
  }).ok,
  true,
  "A ação file-offer não pode ser confundida com o MIME do arquivo.",
);
assert.equal(utils.validateFileMeta({ name: "programa.exe", size: 10, type: "" }).reason, "TYPE_NOT_ALLOWED");
assert.equal(utils.formatBytes(1024), "1,0 KB");
assert.equal(utils.normalizeApiUrl("https://ponte-api.up.railway.app/"), "https://ponte-api.up.railway.app");
assert.equal(utils.normalizeApiUrl("http://localhost:3000"), "http://localhost:3000");
assert.throws(() => utils.normalizeApiUrl("http://example.com"), /HTTPS/);
assert.throws(() => utils.normalizeApiUrl("https://example.com/api"), /domínio/);

const digest = await utils.sha256Hex(new TextEncoder().encode("Ponte"));
assert.equal(digest, "e49ac1d397f642d71df4afda3193c182dc9d4153be4cddcfa32c300b9807fafb");

console.log("OK — códigos, nomes, limites, URL da API e SHA-256 verificados.");
