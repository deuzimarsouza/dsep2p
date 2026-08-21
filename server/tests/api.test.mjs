import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import request from "supertest";
import {
  createApp,
  getExtension,
  loadConfig,
  MAX_UPLOAD_SIZE,
  MAX_UPLOAD_SIZE_MB,
  normalizeCode,
  sanitizeFilename,
} from "../src/app.mjs";

let temporaryDirectory;
let app;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ponte-api-test-"));
  app = createApp({
    storageDir: temporaryDirectory,
    sharesDir: path.join(temporaryDirectory, "shares"),
    incomingDir: path.join(temporaryDirectory, ".incoming"),
    usageFile: path.join(temporaryDirectory, "usage.json"),
    frontendOrigins: ["https://deuzimarsouza.github.io"],
    shareTtlMs: 60_000,
    ttlHours: 1,
    maxFileSize: 1024 * 1024,
    maxFileSizeMb: 1,
    maxBatchSize: 2 * 1024 * 1024,
    maxBatchSizeMb: 2,
    dailyQuota: 4 * 1024 * 1024,
    dailyQuotaMb: 4,
    maxFiles: 3,
    disableRateLimit: true,
    trustProxy: 0,
  });
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("cria uma ponte, consulta, baixa com hash e apaga com token", async () => {
  const source = Buffer.from("arquivo de teste da Ponte");
  const created = await request(app)
    .post("/api/shares")
    .set("Origin", "https://deuzimarsouza.github.io")
    .attach("files", source, { filename: "relatório.pdf", contentType: "application/pdf" })
    .expect(201);

  assert.match(created.body.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(created.body.files.length, 1);
  assert.equal(created.body.files[0].name, "relatório.pdf");
  assert.equal(created.body.files[0].sha256, crypto.createHash("sha256").update(source).digest("hex"));
  assert.equal(typeof created.body.deleteToken, "string");

  const share = await request(app).get(`/api/shares/${created.body.code}`).expect(200);
  assert.equal(share.body.deleteToken, undefined);
  assert.equal(share.body.files[0].id, created.body.files[0].id);

  const downloaded = await request(app)
    .get(`/api/shares/${created.body.code}/files/${created.body.files[0].id}`)
    .buffer(true)
    .parse((response, callback) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  assert.deepEqual(downloaded.body, source);
  assert.equal(downloaded.headers["x-file-sha256"], created.body.files[0].sha256);
  assert.match(downloaded.headers["content-disposition"], /attachment/);

  await request(app)
    .delete(`/api/shares/${created.body.code}`)
    .set("X-Delete-Token", "incorreto")
    .expect(403);
  await request(app)
    .delete(`/api/shares/${created.body.code}`)
    .set("X-Delete-Token", created.body.deleteToken)
    .expect(204);
  await request(app).get(`/api/shares/${created.body.code}`).expect(404);
});

test("aceita formatos arbitrários, MIME divergente e arquivo sem extensão", async () => {
  const created = await request(app)
    .post("/api/shares")
    .set("Origin", "https://deuzimarsouza.github.io")
    .attach("files", Buffer.from("MZ"), { filename: "programa.exe", contentType: "application/octet-stream" })
    .attach("files", Buffer.from("json"), { filename: "imagem.jpg", contentType: "application/json" })
    .attach("files", Buffer.from("sem extensão"), { filename: "LEIA-ME", contentType: "application/x-custom" })
    .expect(201);

  assert.deepEqual(
    created.body.files.map((file) => file.name),
    ["programa.exe", "imagem.jpg", "LEIA-ME"],
  );

  const metadata = JSON.parse(
    await readFile(path.join(temporaryDirectory, "shares", created.body.code, "metadata.json"), "utf8"),
  );
  const extensionlessFile = metadata.files.find((file) => file.name === "LEIA-ME");
  assert.ok(extensionlessFile);
  assert.equal(extensionlessFile.storedName.endsWith("."), false);

  const config = await request(app).get("/api/config").expect(200);
  assert.equal(config.body.acceptsAnyFileType, true);
  assert.deepEqual(config.body.allowedExtensions, ["*"]);
});

test("rejeita origem desconhecida e cota excedida", async () => {
  await request(app)
    .get("/api/config")
    .set("Origin", "https://site-invalido.example")
    .expect(403);

  const quotaApp = createApp({
    storageDir: temporaryDirectory,
    sharesDir: path.join(temporaryDirectory, "quota-shares"),
    incomingDir: path.join(temporaryDirectory, "quota-incoming"),
    usageFile: path.join(temporaryDirectory, "quota-usage.json"),
    frontendOrigins: ["*"],
    maxFileSize: 1024,
    maxFileSizeMb: 1,
    maxBatchSize: 1024,
    maxBatchSizeMb: 1,
    dailyQuota: 4,
    dailyQuotaMb: 0.000004,
    maxFiles: 1,
    disableRateLimit: true,
    trustProxy: 0,
  });
  await request(quotaApp)
    .post("/api/shares")
    .attach("files", Buffer.from("cinco"), { filename: "a.pdf", contentType: "application/pdf" })
    .expect(429)
    .expect(({ body }) => assert.equal(body.error.code, "DAILY_QUOTA_EXCEEDED"));
});

test("aplica limites individual e agregado de forma inclusiva", async () => {
  const limitsDirectory = path.join(temporaryDirectory, "limits");
  const limitsApp = createApp({
    storageDir: limitsDirectory,
    frontendOrigins: ["*"],
    maxFileSize: 10,
    maxBatchSize: 10,
    dailyQuota: 100,
    maxFiles: 3,
    disableRateLimit: true,
    trustProxy: 0,
  });

  await request(limitsApp)
    .post("/api/shares")
    .attach("files", Buffer.alloc(10), { filename: "exatamente.bin" })
    .expect(201);

  await request(limitsApp)
    .post("/api/shares")
    .attach("files", Buffer.alloc(11), { filename: "maior.bin" })
    .expect(413)
    .expect(({ body }) => assert.equal(body.error.code, "FILE_TOO_LARGE"));

  await request(limitsApp)
    .post("/api/shares")
    .attach("files", Buffer.alloc(9), { filename: "menor.bin" })
    .expect(201);

  await request(limitsApp)
    .post("/api/shares")
    .attach("files", Buffer.alloc(5), { filename: "a.bin" })
    .attach("files", Buffer.alloc(5), { filename: "b.bin" })
    .expect(201);

  await request(limitsApp)
    .post("/api/shares")
    .attach("files", Buffer.alloc(6), { filename: "a.bin" })
    .attach("files", Buffer.alloc(5), { filename: "b.bin" })
    .expect(413)
    .expect(({ body }) => assert.equal(body.error.code, "BATCH_TOO_LARGE"));

  assert.deepEqual(await readdir(path.join(limitsDirectory, ".incoming")), []);
});

test("mantém o teto do servidor em 200 MiB e permite apenas reduzi-lo por ambiente", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.maxFileSize, MAX_UPLOAD_SIZE);
  assert.equal(defaults.maxBatchSize, MAX_UPLOAD_SIZE);
  assert.equal(defaults.maxFileSizeMb, MAX_UPLOAD_SIZE_MB);
  assert.equal(defaults.maxBatchSizeMb, MAX_UPLOAD_SIZE_MB);

  const clamped = loadConfig({ MAX_FILE_SIZE_MB: "500", MAX_BATCH_SIZE_MB: "900" });
  assert.equal(clamped.maxFileSize, MAX_UPLOAD_SIZE);
  assert.equal(clamped.maxBatchSize, MAX_UPLOAD_SIZE);

  const reduced = loadConfig({ MAX_FILE_SIZE_MB: "25", MAX_BATCH_SIZE_MB: "100" });
  assert.equal(reduced.maxFileSize, 25 * 1024 * 1024);
  assert.equal(reduced.maxBatchSize, 100 * 1024 * 1024);
});

test("bloqueia e remove uma ponte assim que o prazo vence", async () => {
  const expiringApp = createApp({
    storageDir: temporaryDirectory,
    sharesDir: path.join(temporaryDirectory, "expiring-shares"),
    incomingDir: path.join(temporaryDirectory, "expiring-incoming"),
    usageFile: path.join(temporaryDirectory, "expiring-usage.json"),
    frontendOrigins: ["*"],
    shareTtlMs: 10,
    ttlHours: 1,
    maxFileSize: 1024,
    maxFileSizeMb: 1,
    maxBatchSize: 1024,
    maxBatchSizeMb: 1,
    dailyQuota: 1024,
    dailyQuotaMb: 1,
    maxFiles: 1,
    disableRateLimit: true,
    trustProxy: 0,
  });
  const created = await request(expiringApp)
    .post("/api/shares")
    .attach("files", Buffer.from("pdf"), { filename: "a.pdf", contentType: "application/pdf" })
    .expect(201);

  await new Promise((resolve) => setTimeout(resolve, 25));
  await request(expiringApp)
    .get(`/api/shares/${created.body.code}`)
    .expect(410)
    .expect(({ body }) => assert.equal(body.error.code, "SHARE_EXPIRED"));
  await request(expiringApp).get(`/api/shares/${created.body.code}`).expect(404);
});

test("normaliza códigos e nomes sem permitir travessia de diretório", () => {
  assert.equal(normalizeCode("abci 0123-xyz9"), "ABC23XYZ");
  assert.equal(sanitizeFilename("../../relatório.final.PDF"), "relatório.final.PDF");
  assert.equal(getExtension("relatório.final.PDF"), "pdf");
});
