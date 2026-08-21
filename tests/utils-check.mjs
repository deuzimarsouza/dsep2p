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
const MB = 1024 * 1024;

assert.equal(utils.normalizeCode("abci 0123-xyz9"), "ABC23XYZ");
assert.equal(utils.displayCode("ABCDEFGH"), "ABCD EFGH");
assert.equal(utils.getExtension("Relatório.Final.PDF"), "pdf");
assert.equal(utils.sanitizeFilename("../../relatório.pdf"), "relatório.pdf");

const longName = `${"a".repeat(220)}.pdf`;
const sanitizedLongName = utils.sanitizeFilename(longName);
assert.equal(sanitizedLongName.length, 180);
assert(sanitizedLongName.endsWith(".pdf"), "Nomes longos precisam preservar a extensão.");

assert.equal(utils.DEFAULT_LIMITS.maxFileSize, 200 * MB);
assert.equal(utils.DEFAULT_LIMITS.maxBatchSize, 200 * MB);
assert.equal(utils.validateFileMeta({ name: "foto.JPG", size: 200 * MB - 1, type: "image/jpeg" }).ok, true);
assert.equal(
  utils.validateFileMeta({ name: "foto.jpg", size: 200 * MB, type: "image/jpeg" }).reason,
  "FILE_TOO_LARGE",
  "Um arquivo individual de exatamente 200 MiB deve ser rejeitado.",
);
assert.equal(
  utils.validateFileMeta({ name: "foto.jpg", size: 10, type: "text/html" }).ok,
  true,
  "O MIME informado pelo navegador não deve restringir o formato.",
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
assert.equal(
  utils.validateFileMeta({ name: "programa.exe", size: 10, type: "application/x-msdownload" }).ok,
  true,
  "Extensões fora da lista de ícones também devem ser aceitas.",
);
assert.equal(
  utils.validateFileMeta({ name: "LEIA-ME", size: 10, type: "application/x-custom" }).ok,
  true,
  "Arquivos sem extensão também devem ser aceitos.",
);

const exactBatch = utils.validateFileBatch([
  { name: "parte-a.bin", size: 100 * MB, type: "application/octet-stream" },
  { name: "parte-b.dat", size: 100 * MB, type: "application/x-custom" },
]);
assert.equal(exactBatch.ok, true, "Um lote de vários arquivos pode somar exatamente 200 MiB.");
assert.equal(exactBatch.totalSize, 200 * MB);

const oversizedBatch = utils.validateFileBatch([
  { name: "parte-a.bin", size: 100 * MB, type: "application/octet-stream" },
  { name: "parte-b.dat", size: 100 * MB + 1, type: "application/x-custom" },
]);
assert.equal(oversizedBatch.ok, false);
assert.equal(oversizedBatch.reason, "BATCH_TOO_LARGE", "Um lote acima de 200 MiB deve ser rejeitado.");

assert.match(
  utils.fileSelectionErrorMessage({ reason: "FILE_TOO_LARGE", name: "grande.bin" }),
  /menos de 200 MB/,
);
assert.match(
  utils.fileSelectionErrorMessage({ reason: "BATCH_TOO_LARGE", name: "parte-b.dat" }),
  /no máximo 200 MB/,
);

const cappedLimits = utils.normalizeUploadLimits({ maxFileSize: 500 * MB, maxBatchSize: 500 * MB });
assert.equal(cappedLimits.maxFileSize, 200 * MB, "A API não pode elevar o teto individual do frontend.");
assert.equal(cappedLimits.maxBatchSize, 200 * MB, "A API não pode elevar o teto do lote no frontend.");
const lowerLimits = utils.normalizeUploadLimits({ maxFileSize: 50 * MB, maxBatchSize: 80 * MB });
assert.equal(lowerLimits.maxFileSize, 50 * MB, "O frontend deve respeitar um limite menor informado pela API.");
assert.equal(lowerLimits.maxBatchSize, 80 * MB, "O frontend deve respeitar um lote menor informado pela API.");

const universalConfig = {
  maxFileSize: 200 * MB,
  maxBatchSize: 200 * MB,
  maxFiles: 10,
  acceptsAnyFileType: true,
};
assert.equal(utils.validateApiConfig(universalConfig), universalConfig);
assert.throws(
  () => utils.validateApiConfig({ ...universalConfig, acceptsAnyFileType: false }),
  /qualquer formato/,
  "O frontend deve recusar uma API que ainda filtre formatos.",
);
assert.throws(
  () => utils.validateApiConfig({ ...universalConfig, maxBatchSize: 0 }),
  /inválida/,
  "Limites numéricos inválidos não podem ser aplicados.",
);
assert.equal(utils.formatBytes(1024), "1,0 KB");
assert.equal(utils.normalizeApiUrl("https://ponte-api.up.railway.app/"), "https://ponte-api.up.railway.app");
assert.equal(utils.normalizeApiUrl("http://localhost:3000"), "http://localhost:3000");
assert.throws(() => utils.normalizeApiUrl("http://example.com"), /HTTPS/);
assert.throws(() => utils.normalizeApiUrl("https://example.com/api"), /domínio/);

const digest = await utils.sha256Hex(new TextEncoder().encode("Ponte"));
assert.equal(digest, "e49ac1d397f642d71df4afda3193c182dc9d4153be4cddcfa32c300b9807fafb");

console.log("OK — códigos, nomes, limites, URL da API e SHA-256 verificados.");
