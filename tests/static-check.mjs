import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(testsDirectory, "..");
const [html, css, javascript, configSource, workflow, manifestSource, serviceWorker, serverPackage, railwayConfig] =
  await Promise.all([
    readFile(path.join(projectDirectory, "index.html"), "utf8"),
    readFile(path.join(projectDirectory, "styles.css"), "utf8"),
    readFile(path.join(projectDirectory, "app.js"), "utf8"),
    readFile(path.join(projectDirectory, "config.js"), "utf8"),
    readFile(path.join(projectDirectory, ".github", "workflows", "pages.yml"), "utf8"),
    readFile(path.join(projectDirectory, "manifest.webmanifest"), "utf8"),
    readFile(path.join(projectDirectory, "sw.js"), "utf8"),
    readFile(path.join(projectDirectory, "server", "package.json"), "utf8"),
    readFile(path.join(projectDirectory, "server", "railway.json"), "utf8"),
  ]);
const manifest = JSON.parse(manifestSource);
const apiPackage = JSON.parse(serverPackage);
const railway = JSON.parse(railwayConfig);

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const uniqueIds = new Set(ids);
assert.equal(uniqueIds.size, ids.length, "O HTML não pode ter IDs duplicados.");

const queriedIds = [...javascript.matchAll(/querySelector\("#([A-Za-z][\w-]*)"\)/g)].map((match) => match[1]);
for (const id of queriedIds) {
  assert(uniqueIds.has(id), `O JavaScript procura #${id}, mas esse ID não existe no HTML.`);
}

for (const match of html.matchAll(/aria-(?:controls|describedby|labelledby)="([^"]+)"/g)) {
  for (const id of match[1].split(/\s+/)) {
    assert(uniqueIds.has(id), `O atributo ARIA aponta para #${id}, mas esse ID não existe.`);
  }
}

const fileInputTag = html.match(/<input\b[^>]*\bid="fileInput"[^>]*>/)?.[0];
assert(fileInputTag, "O seletor de arquivos precisa existir.");
assert(!/\baccept\s*=/i.test(fileInputTag), "O seletor não pode restringir extensões nem tipos MIME.");
assert(html.includes("Qualquer formato de arquivo"), "A interface precisa comunicar a aceitação universal.");
assert(html.includes("menos de 200 MB"), "A interface precisa explicar o limite individual estrito.");
assert(html.includes("lote de até 200 MB"), "A interface precisa explicar o limite acumulado.");

assert(html.includes("qrcodejs@1.0.0"), "A versão do gerador de QR Code precisa ficar fixada.");
assert(html.includes("integrity=\"sha384-"), "A dependência externa precisa manter SRI.");
assert(!html.toLowerCase().includes("peerjs"), "A versão em nuvem não deve carregar PeerJS.");
assert(html.indexOf("./config.js") < html.indexOf("./app.js"), "A configuração deve carregar antes da aplicação.");
assert(html.includes("id=\"copyLinkButton\""), "O remetente precisa copiar o link temporário.");
assert(html.includes("id=\"deleteShareButton\""), "O remetente precisa apagar os arquivos antes do prazo.");
assert(html.includes("id=\"settingsDialog\""), "A página precisa permitir configurar o domínio do Railway.");
assert(html.includes("id=\"downloadList\""), "O receptor precisa ver os arquivos disponíveis.");
assert(html.includes("temporariamente no Volume do Railway"), "A explicação de privacidade precisa informar o armazenamento real.");
assert(html.includes("não promete criptografia ponta a ponta"), "A página não pode prometer E2E no modo servidor.");
assert(!html.match(/(?:src|href)="\//), "Recursos absolutos quebram na subpasta do GitHub Pages.");

assert(!javascript.includes("innerHTML"), "Dados externos nunca devem ser inseridos com innerHTML.");
assert(javascript.includes("/api/shares"), "O frontend precisa usar a API de compartilhamento.");
assert(javascript.includes("new FormData()"), "O upload deve usar multipart binário.");
assert(javascript.includes("new XMLHttpRequest()"), "O upload precisa acompanhar o progresso real.");
assert(javascript.includes("crypto.subtle.digest(\"SHA-256\""), "O navegador precisa conferir SHA-256 antes de baixar.");
assert(javascript.includes("X-File-Sha256"), "O hash informado pela API precisa ser comparado.");
assert(javascript.includes("X-Delete-Token"), "A exclusão antecipada precisa exigir a chave do remetente.");
assert(javascript.includes("searchParams.set(\"api\""), "O link deve transportar o endereço público da API.");
assert(javascript.includes("200 * MB"), "O teto padrão de 200 MiB precisa permanecer explícito.");
assert(javascript.includes("size >= limits.maxFileSize"), "O arquivo individual de 200 MiB deve ser rejeitado.");
assert(javascript.includes("totalSize > limits.maxBatchSize"), "O lote de exatamente 200 MiB deve ser aceito.");
assert(javascript.includes("acceptsAnyFileType !== true"), "O frontend deve confirmar a aceitação universal da API.");
assert(!javascript.includes("TYPE_NOT_ALLOWED"), "O frontend não pode bloquear uma extensão arbitrária.");
assert(!javascript.includes("MIME_MISMATCH"), "O frontend não pode bloquear um MIME arbitrário.");
assert(javascript.includes("beforeinstallprompt"), "A experiência instalável precisa continuar disponível.");
assert(javascript.includes("serviceWorker.register"), "A aplicação precisa registrar o service worker.");

assert(configSource.includes('apiBaseUrl: ""'), "O repositório não deve fixar um domínio de API inexistente.");
assert(!configSource.match(/token|password|secret/i), "config.js não pode conter segredos.");
assert(workflow.includes("actions/checkout@v6"), "O workflow precisa usar checkout atual.");
assert(workflow.includes("actions/setup-node@v6"), "O workflow precisa preparar o Node atual.");
assert(workflow.includes("actions/upload-pages-artifact@v4"), "O frontend precisa ser empacotado para Pages.");
assert(workflow.includes("actions/deploy-pages@v4"), "O frontend precisa ser publicado no GitHub Pages.");
assert(workflow.includes("vars.PONTE_API_URL"), "O domínio do Railway deve vir de uma variável do repositório.");
assert(!workflow.includes("cp -r . dist"), "O código do servidor não deve ser publicado junto do site estático.");

assert.equal(apiPackage.scripts.start, "node src/index.mjs");
assert(apiPackage.dependencies.express, "A API precisa declarar Express.");
assert(apiPackage.dependencies.multer, "A API precisa declarar Multer para multipart.");
assert.equal(railway.deploy.healthcheckPath, "/health");
assert.equal(railway.build.builder, "DOCKERFILE");

assert.equal(manifest.display, "standalone", "O app instalado precisa abrir sem a interface do navegador.");
assert.equal(manifest.start_url, "./", "O manifesto precisa funcionar em subpastas.");
assert(manifest.icons.some((icon) => icon.sizes === "192x192"));
assert(manifest.icons.some((icon) => icon.sizes === "512x512"));
assert(manifest.icons.some((icon) => icon.purpose === "maskable"));
assert(serviceWorker.includes('"./config.js"'), "O shell offline precisa incluir a configuração.");
assert(serviceWorker.includes("request.mode === \"navigate\""), "A tela principal precisa abrir pelo cache.");

for (const icon of manifest.icons) await access(path.resolve(projectDirectory, icon.src));
await access(path.join(projectDirectory, "icons", "apple-touch-icon.png"));
await access(path.join(projectDirectory, "server", "package-lock.json"));
await access(path.join(projectDirectory, "server", "Dockerfile"));

const openBraces = [...css].filter((character) => character === "{").length;
const closeBraces = [...css].filter((character) => character === "}").length;
assert.equal(openBraces, closeBraces, "As chaves do CSS precisam estar balanceadas.");

console.log(`OK — ${queriedIds.length} controles, ${ids.length} IDs e arquitetura GitHub + Railway verificada.`);
