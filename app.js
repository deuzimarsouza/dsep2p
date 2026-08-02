(() => {
  "use strict";

  const MB = 1024 * 1024;
  const DEFAULT_LIMITS = Object.freeze({
    ttlHours: 24,
    maxFileSize: 25 * MB,
    maxFileSizeMb: 25,
    maxBatchSize: 100 * MB,
    maxBatchSizeMb: 100,
    dailyQuotaMb: 100,
    maxFiles: 10,
  });
  const API_STORAGE_KEY = "ponte-api-base-url";
  const LAST_SHARE_KEY = "ponte-last-created-share";
  const INSTALL_DISMISS_KEY = "ponte-install-dismissed-at";
  const INSTALL_REMINDER_DELAY = 7 * 24 * 60 * 60 * 1000;

  const ALLOWED_EXTENSIONS = Object.freeze({
    jpg: { family: "image", label: "JPG", mimes: ["image/jpeg", "application/octet-stream"] },
    jpeg: { family: "image", label: "JPEG", mimes: ["image/jpeg", "application/octet-stream"] },
    png: { family: "image", label: "PNG", mimes: ["image/png", "application/octet-stream"] },
    pdf: { family: "pdf", label: "PDF", mimes: ["application/pdf", "application/octet-stream"] },
    doc: {
      family: "word",
      label: "DOC",
      mimes: ["application/msword", "application/doc", "application/vnd.ms-office", "application/octet-stream"],
    },
    docx: {
      family: "word",
      label: "DOCX",
      mimes: [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/zip",
        "application/octet-stream",
      ],
    },
    xls: {
      family: "excel",
      label: "XLS",
      mimes: [
        "application/vnd.ms-excel",
        "application/xls",
        "application/x-excel",
        "application/vnd.ms-office",
        "application/octet-stream",
      ],
    },
    xlsx: {
      family: "excel",
      label: "XLSX",
      mimes: [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/zip",
        "application/octet-stream",
      ],
    },
    ppt: {
      family: "powerpoint",
      label: "PPT",
      mimes: [
        "application/vnd.ms-powerpoint",
        "application/powerpoint",
        "application/mspowerpoint",
        "application/x-mspowerpoint",
        "application/vnd.ms-office",
        "application/octet-stream",
      ],
    },
    pptx: {
      family: "powerpoint",
      label: "PPTX",
      mimes: [
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/zip",
        "application/octet-stream",
      ],
    },
  });

  class PonteError extends Error {
    constructor(message, code = "UNKNOWN_ERROR", status = 0) {
      super(message);
      this.name = "PonteError";
      this.code = code;
      this.status = status;
    }
  }

  function normalizeCode(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, "")
      .replace(/[IO01]/g, "")
      .slice(0, 8);
  }

  function displayCode(value) {
    const code = normalizeCode(value);
    return code.length > 4 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
  }

  function getExtension(filename) {
    const clean = String(filename || "").trim();
    const lastDot = clean.lastIndexOf(".");
    if (lastDot <= 0 || lastDot === clean.length - 1) return "";
    return clean.slice(lastDot + 1).toLowerCase();
  }

  function sanitizeFilename(filename) {
    const cleaned = String(filename || "arquivo")
      .normalize("NFC")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\.{2,}/g, "-")
      .replace(/^[.\s-]+/, "")
      .trim();
    const safe = cleaned || "arquivo";
    if (safe.length <= 180) return safe;
    const lastDot = safe.lastIndexOf(".");
    const suffix = lastDot > 0 ? safe.slice(lastDot) : "";
    if (suffix.length > 1 && suffix.length <= 12) return `${safe.slice(0, 180 - suffix.length)}${suffix}`;
    return safe.slice(0, 180);
  }

  function validateFileMeta(meta, limits = DEFAULT_LIMITS) {
    const name = sanitizeFilename(meta?.name);
    const extension = getExtension(name);
    const definition = ALLOWED_EXTENSIONS[extension];
    const size = Number(meta?.size);
    const mime = String(meta?.mime || meta?.type || "application/octet-stream")
      .toLowerCase()
      .split(";", 1)[0]
      .trim() || "application/octet-stream";
    if (!definition) return { ok: false, reason: "TYPE_NOT_ALLOWED", name, extension, size };
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileSize) {
      return { ok: false, reason: "FILE_TOO_LARGE", name, extension, size };
    }
    if (!definition.mimes.includes(mime)) return { ok: false, reason: "MIME_MISMATCH", name, extension, size };
    return { ok: true, name, extension, size, mime, ...definition };
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const amount = value / 1024 ** unitIndex;
    const decimals = unitIndex === 0 || amount >= 10 ? 0 : 1;
    return `${amount.toFixed(decimals).replace(".", ",")} ${units[unitIndex]}`;
  }

  function normalizeApiUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || /seu-servi[cç]o|seu-projeto/i.test(raw)) return "";
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new PonteError("Informe uma URL completa, começando por https://.", "INVALID_API_URL");
    }
    const isLocalHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !isLocalHttp) {
      throw new PonteError("A API precisa usar HTTPS. HTTP só é aceito em localhost.", "INSECURE_API_URL");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new PonteError("Use somente o domínio público da API, sem usuário, parâmetros ou fragmentos.", "INVALID_API_URL");
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      throw new PonteError("Use apenas o domínio da API, sem caminhos depois de .app.", "INVALID_API_URL");
    }
    return url.origin;
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  window.PonteUtils = Object.freeze({
    ALLOWED_EXTENSIONS,
    DEFAULT_LIMITS,
    normalizeCode,
    displayCode,
    getExtension,
    sanitizeFilename,
    validateFileMeta,
    formatBytes,
    normalizeApiUrl,
    sha256Hex,
  });

  if (window.__PONTE_TEST__) return;

  const elements = {
    connectionStatus: document.querySelector("#connectionStatus"),
    connectionStatusText: document.querySelector("#connectionStatusText"),
    shareEmptyPanel: document.querySelector("#shareEmptyPanel"),
    shareReadyPanel: document.querySelector("#shareReadyPanel"),
    ownCode: document.querySelector("#ownCode"),
    qrCode: document.querySelector("#qrCode"),
    shareExpiry: document.querySelector("#shareExpiry"),
    copyLinkButton: document.querySelector("#copyLinkButton"),
    deleteShareButton: document.querySelector("#deleteShareButton"),
    receiveForm: document.querySelector("#receiveForm"),
    remoteCode: document.querySelector("#remoteCode"),
    receiveButton: document.querySelector("#receiveButton"),
    codeError: document.querySelector("#codeError"),
    fileInput: document.querySelector("#fileInput"),
    dropZone: document.querySelector("#dropZone"),
    fileFormats: document.querySelector("#fileFormats"),
    selectionPanel: document.querySelector("#selectionPanel"),
    selectionSummary: document.querySelector("#selectionSummary"),
    selectionList: document.querySelector("#selectionList"),
    clearSelectionButton: document.querySelector("#clearSelectionButton"),
    uploadButton: document.querySelector("#uploadButton"),
    uploadProgressPanel: document.querySelector("#uploadProgressPanel"),
    uploadProgressTitle: document.querySelector("#uploadProgressTitle"),
    uploadProgressPercent: document.querySelector("#uploadProgressPercent"),
    uploadProgressTrack: document.querySelector("#uploadProgressTrack"),
    uploadProgressFill: document.querySelector("#uploadProgressFill"),
    cancelUploadButton: document.querySelector("#cancelUploadButton"),
    downloadSummary: document.querySelector("#downloadSummary"),
    clearDownloadButton: document.querySelector("#clearDownloadButton"),
    downloadEmpty: document.querySelector("#downloadEmpty"),
    downloadList: document.querySelector("#downloadList"),
    downloadExpiry: document.querySelector("#downloadExpiry"),
    menuButton: document.querySelector("#menuButton"),
    menuDialog: document.querySelector("#menuDialog"),
    howButton: document.querySelector("#howButton"),
    howDialog: document.querySelector("#howDialog"),
    aboutButton: document.querySelector("#aboutButton"),
    aboutDialog: document.querySelector("#aboutDialog"),
    settingsButton: document.querySelector("#settingsButton"),
    settingsDialog: document.querySelector("#settingsDialog"),
    settingsCloseButton: document.querySelector("#settingsCloseButton"),
    apiConfigForm: document.querySelector("#apiConfigForm"),
    apiUrlInput: document.querySelector("#apiUrlInput"),
    apiUrlError: document.querySelector("#apiUrlError"),
    saveApiButton: document.querySelector("#saveApiButton"),
    privacyButton: document.querySelector("#privacyButton"),
    privacyDialog: document.querySelector("#privacyDialog"),
    installSuggestion: document.querySelector("#installSuggestion"),
    installButton: document.querySelector("#installButton"),
    installDismissButton: document.querySelector("#installDismissButton"),
    toastRegion: document.querySelector("#toastRegion"),
    announcer: document.querySelector("#announcer"),
  };

  const state = {
    apiBaseUrl: "https://dsep2p-production.up.railway.app",
    apiReady: false,
    apiProbePromise: null,
    limits: { ...DEFAULT_LIMITS },
    selectedFiles: [],
    uploadXhr: null,
    currentShare: null,
    currentDeleteToken: "",
    currentShareLink: "",
    loadedShare: null,
    downloadStates: new Map(),
    expiryTimer: null,
    deferredInstallPrompt: null,
    installTimer: null,
    modalScrollY: 0,
    modalLocked: false,
    pendingCode: normalizeCode(new URL(window.location.href).searchParams.get("codigo")),
  };

  function storageGet(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A aplicação continua funcionando mesmo se o navegador bloquear armazenamento local.
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Sem ação adicional.
    }
  }

  function setStatus(text, status = "loading") {
    elements.connectionStatusText.textContent = text;
    elements.connectionStatus.dataset.state = status;
  }

  function announce(message) {
    elements.announcer.textContent = "";
    window.setTimeout(() => {
      elements.announcer.textContent = message;
    }, 20);
  }

  function showToast(message, tone = "success", duration = 5000) {
    const toast = document.createElement("div");
    const copy = document.createElement("span");
    const close = document.createElement("button");
    toast.className = "toast";
    toast.dataset.tone = tone;
    toast.setAttribute("role", tone === "error" ? "alert" : "status");
    copy.textContent = message;
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Fechar aviso");
    toast.append(copy, close);
    elements.toastRegion.append(toast);
    announce(message);

    let timer;
    const remove = () => {
      window.clearTimeout(timer);
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 190);
    };
    close.addEventListener("click", remove);
    timer = window.setTimeout(remove, duration);
  }

  function syncModalLock() {
    const hasOpenDialog = Boolean(document.querySelector("dialog[open]"));
    if (hasOpenDialog && !state.modalLocked) {
      state.modalScrollY = window.scrollY;
      document.documentElement.classList.add("has-open-dialog");
      document.body.style.top = `-${state.modalScrollY}px`;
      state.modalLocked = true;
    } else if (!hasOpenDialog && state.modalLocked) {
      document.documentElement.classList.remove("has-open-dialog");
      document.body.style.top = "";
      state.modalLocked = false;
      window.scrollTo(0, state.modalScrollY);
    }
  }

  function openDialog(dialog) {
    if (!dialog || dialog.open) return;
    const current = document.querySelector("dialog[open]");
    if (current) current.close("navigate");
    window.setTimeout(() => {
      dialog.showModal();
      syncModalLock();
    }, current ? 20 : 0);
  }

  function setCodeError(message = "") {
    elements.codeError.textContent = message;
    elements.remoteCode.setAttribute("aria-invalid", message ? "true" : "false");
  }

  function setApiError(message = "") {
    elements.apiUrlError.textContent = message;
    elements.apiUrlInput.setAttribute("aria-invalid", message ? "true" : "false");
  }

  async function fetchWithTimeout(url, options = {}, timeout = 12_000) {
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromExternal = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error.name === "AbortError" && !externalSignal?.aborted) {
        throw new PonteError("O Railway demorou para responder. Tente novamente.", "API_TIMEOUT");
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }

  async function parseApiError(response) {
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return new PonteError(
      body?.error?.message || `O servidor respondeu com erro ${response.status}.`,
      body?.error?.code || "API_ERROR",
      response.status,
    );
  }

  async function testApi(baseUrl) {
    const healthResponse = await fetchWithTimeout(`${baseUrl}/health`, { cache: "no-store" });
    if (!healthResponse.ok) throw await parseApiError(healthResponse);
    const health = await healthResponse.json().catch(() => null);
    if (health?.status !== "ok") throw new PonteError("O endereço respondeu, mas não parece ser a API da Ponte.", "INVALID_API");

    const configResponse = await fetchWithTimeout(`${baseUrl}/api/config`, { cache: "no-store" });
    if (!configResponse.ok) throw await parseApiError(configResponse);
    const config = await configResponse.json();
    if (!Number.isSafeInteger(config.maxFileSize) || !Array.isArray(config.allowedExtensions)) {
      throw new PonteError("A configuração retornada pela API é inválida.", "INVALID_API_CONFIG");
    }
    return config;
  }

  function applyLimits(config) {
    state.limits = { ...DEFAULT_LIMITS, ...config };
    elements.fileFormats.textContent = `JPG, PNG, PDF, Word, Excel e PowerPoint — até ${state.limits.maxFileSizeMb} MB por arquivo; ${state.limits.maxBatchSizeMb} MB no total`;
  }

  async function connectApi(baseUrl, { persist = true } = {}) {
    state.apiReady = false;
    setStatus("Verificando o Railway", "loading");
    try {
      const config = await testApi(baseUrl);
      state.apiBaseUrl = baseUrl;
      state.apiReady = true;
      applyLimits(config);
      if (persist) storageSet(API_STORAGE_KEY, baseUrl);
      setStatus("Railway conectado", "connected");
      return true;
    } catch (error) {
      state.apiReady = false;
      setStatus(navigator.onLine ? "Railway indisponível" : "Sem internet", navigator.onLine ? "error" : "offline");
      throw error instanceof PonteError
        ? error
        : new PonteError("Não foi possível acessar a API. Confira o domínio e o CORS.", "API_UNREACHABLE");
    }
  }

  function resolveInitialApiUrl() {
    const pageUrl = new URL(window.location.href);
    const candidates = [
      pageUrl.searchParams.get("api"),
      storageGet(API_STORAGE_KEY),
      window.PONTE_CONFIG?.apiBaseUrl,
    ];
    for (const candidate of candidates) {
      try {
        const normalized = normalizeApiUrl(candidate);
        if (normalized) return normalized;
      } catch {
        // Tenta a próxima fonte de configuração.
      }
    }
    return "";
  }

  async function ensureApiReady() {
    if (state.apiReady) return true;
    if (!state.apiBaseUrl) {
      elements.apiUrlInput.value = "";
      openDialog(elements.settingsDialog);
      throw new PonteError("Configure primeiro o domínio público do Railway.", "API_NOT_CONFIGURED");
    }
    if (!state.apiProbePromise) {
      state.apiProbePromise = connectApi(state.apiBaseUrl).finally(() => {
        state.apiProbePromise = null;
      });
    }
    await state.apiProbePromise;
    return true;
  }

  function selectionKey(file) {
    return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
  }

  function fileDefinition(filename) {
    const extension = getExtension(filename);
    return ALLOWED_EXTENSIONS[extension] || { family: "file", label: extension.toUpperCase() || "ARQ" };
  }

  function createFileIcon(filename) {
    const definition = fileDefinition(filename);
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.dataset.family = definition.family;
    icon.textContent = definition.label;
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  function renderSelection() {
    elements.selectionList.replaceChildren();
    const totalSize = state.selectedFiles.reduce((sum, file) => sum + file.size, 0);
    const count = state.selectedFiles.length;
    elements.selectionPanel.hidden = count === 0;
    elements.selectionSummary.textContent = count
      ? `${count} ${count === 1 ? "arquivo" : "arquivos"} • ${formatBytes(totalSize)}`
      : "0 arquivos";

    state.selectedFiles.forEach((file, index) => {
      const item = document.createElement("article");
      const main = document.createElement("div");
      const name = document.createElement("p");
      const size = document.createElement("p");
      const remove = document.createElement("button");
      item.className = "selection-item";
      main.className = "transfer-main";
      name.className = "file-name";
      name.textContent = sanitizeFilename(file.name);
      name.title = name.textContent;
      size.className = "file-meta";
      size.textContent = formatBytes(file.size);
      remove.type = "button";
      remove.className = "mini-icon-button";
      remove.dataset.removeIndex = String(index);
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remover ${name.textContent}`);
      main.append(name, size);
      item.append(createFileIcon(file.name), main, remove);
      elements.selectionList.append(item);
    });
  }

  function addSelectedFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    const existing = new Set(state.selectedFiles.map(selectionKey));
    const accepted = [...state.selectedFiles];
    let totalSize = accepted.reduce((sum, file) => sum + file.size, 0);

    for (const file of incoming) {
      if (existing.has(selectionKey(file))) continue;
      if (accepted.length >= state.limits.maxFiles) {
        showToast(`Envie no máximo ${state.limits.maxFiles} arquivos por ponte.`, "error");
        break;
      }
      const validation = validateFileMeta(file, state.limits);
      if (!validation.ok) {
        const messages = {
          TYPE_NOT_ALLOWED: `“${validation.name}” tem um formato não permitido.`,
          FILE_TOO_LARGE: `“${validation.name}” ultrapassa ${state.limits.maxFileSizeMb} MB.`,
          MIME_MISMATCH: `“${validation.name}” não combina com o tipo informado pelo navegador.`,
        };
        showToast(messages[validation.reason] || `Não foi possível aceitar “${validation.name}”.`, "error", 6500);
        continue;
      }
      if (totalSize + file.size > state.limits.maxBatchSize) {
        showToast(`O envio pode ter no máximo ${state.limits.maxBatchSizeMb} MB no total.`, "error", 6500);
        continue;
      }
      accepted.push(file);
      existing.add(selectionKey(file));
      totalSize += file.size;
    }
    state.selectedFiles = accepted;
    elements.fileInput.value = "";
    renderSelection();
  }

  function updateUploadProgress(percent, title = "Enviando ao Railway") {
    const safe = Math.max(0, Math.min(100, Math.round(percent)));
    elements.uploadProgressTitle.textContent = title;
    elements.uploadProgressPercent.textContent = `${safe}%`;
    elements.uploadProgressFill.style.width = `${safe}%`;
    elements.uploadProgressTrack.setAttribute("aria-valuenow", String(safe));
  }

  function uploadViaXhr(formData) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      state.uploadXhr = xhr;
      xhr.open("POST", `${state.apiBaseUrl}/api/shares`);
      xhr.responseType = "json";
      xhr.timeout = 10 * 60 * 1000;
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) updateUploadProgress((event.loaded / event.total) * 100);
      });
      xhr.addEventListener("load", () => {
        state.uploadXhr = null;
        const body = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new PonteError(body?.error?.message || "O Railway recusou o envio.", body?.error?.code || "UPLOAD_FAILED", xhr.status));
      });
      xhr.addEventListener("error", () => {
        state.uploadXhr = null;
        reject(new PonteError("A conexão caiu durante o envio.", "UPLOAD_NETWORK_ERROR"));
      });
      xhr.addEventListener("timeout", () => {
        state.uploadXhr = null;
        reject(new PonteError("O envio demorou demais e foi interrompido.", "UPLOAD_TIMEOUT"));
      });
      xhr.addEventListener("abort", () => {
        state.uploadXhr = null;
        reject(new PonteError("O envio foi cancelado.", "UPLOAD_CANCELLED"));
      });
      xhr.send(formData);
    });
  }

  function buildShareLink(code) {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("codigo", normalizeCode(code));
    url.searchParams.set("api", state.apiBaseUrl);
    return url.href;
  }

  function renderQrCode(link) {
    elements.qrCode.replaceChildren();
    elements.qrCode.dataset.state = "ready";
    try {
      if (typeof window.QRCode !== "function") throw new Error("Biblioteca de QR Code indisponível");
      new window.QRCode(elements.qrCode, {
        text: link,
        width: 180,
        height: 180,
        colorDark: "#18332b",
        colorLight: "#ffffff",
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    } catch {
      elements.qrCode.dataset.state = "error";
      const message = document.createElement("span");
      message.textContent = "Não foi possível gerar o QR Code. Use Copiar link.";
      elements.qrCode.append(message);
    }
  }

  function rememberDeleteToken(code, token) {
    if (!token) return;
    state.currentDeleteToken = token;
    storageSet(`ponte-delete-${normalizeCode(code)}`, token);
  }

  function showCreatedShare(share) {
    const savedShare = {
      code: normalizeCode(share.code),
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      files: Array.isArray(share.files) ? share.files : [],
    };
    state.currentShare = savedShare;
    state.currentShareLink = buildShareLink(share.code);
    rememberDeleteToken(share.code, share.deleteToken || storageGet(`ponte-delete-${savedShare.code}`));
    storageSet(LAST_SHARE_KEY, JSON.stringify({ apiBaseUrl: state.apiBaseUrl, share: savedShare }));
    elements.ownCode.textContent = displayCode(share.code);
    elements.shareEmptyPanel.hidden = true;
    elements.shareReadyPanel.hidden = false;
    renderQrCode(state.currentShareLink);
    updateExpiryCopies();
  }

  function clearCreatedShare() {
    state.currentShare = null;
    state.currentDeleteToken = "";
    state.currentShareLink = "";
    elements.shareReadyPanel.hidden = true;
    elements.shareEmptyPanel.hidden = false;
    elements.ownCode.textContent = "•••• ••••";
    elements.qrCode.replaceChildren();
    storageRemove(LAST_SHARE_KEY);
  }

  function restoreCreatedShare() {
    let saved;
    try {
      saved = JSON.parse(storageGet(LAST_SHARE_KEY));
    } catch {
      storageRemove(LAST_SHARE_KEY);
      return;
    }
    const share = saved?.share;
    if (
      saved?.apiBaseUrl !== state.apiBaseUrl ||
      normalizeCode(share?.code).length !== 8 ||
      !Number.isFinite(Date.parse(share?.expiresAt)) ||
      Date.parse(share.expiresAt) <= Date.now()
    ) {
      storageRemove(LAST_SHARE_KEY);
      return;
    }
    showCreatedShare(share);
  }

  async function startUpload() {
    if (!state.selectedFiles.length || state.uploadXhr) return;
    try {
      await ensureApiReady();
    } catch (error) {
      showToast(error.message, "error");
      return;
    }

    const formData = new FormData();
    for (const file of state.selectedFiles) formData.append("files", file, sanitizeFilename(file.name));
    elements.selectionPanel.hidden = true;
    elements.dropZone.hidden = true;
    elements.uploadProgressPanel.hidden = false;
    updateUploadProgress(0);

    try {
      const share = await uploadViaXhr(formData);
      updateUploadProgress(100, "Envio concluído");
      showCreatedShare(share);
      state.selectedFiles = [];
      renderSelection();
      showToast(`Código ${displayCode(share.code)} criado. Agora compartilhe com o outro aparelho.`);
    } catch (error) {
      if (error.code !== "UPLOAD_CANCELLED") showToast(error.message, "error", 7000);
      else showToast("Envio cancelado.", "info");
    } finally {
      window.setTimeout(() => {
        elements.uploadProgressPanel.hidden = true;
        elements.dropZone.hidden = false;
        updateUploadProgress(0);
        renderSelection();
      }, 450);
    }
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.userSelect = "text";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Falha ao copiar");
  }

  async function deleteCreatedShare() {
    if (!state.currentShare) return;
    const code = state.currentShare.code;
    const token = state.currentDeleteToken || storageGet(`ponte-delete-${code}`);
    if (!token) {
      showToast("A chave de exclusão não está mais disponível neste navegador.", "error");
      return;
    }
    if (!window.confirm("Apagar agora todos os arquivos desta ponte? Essa ação não pode ser desfeita.")) return;
    elements.deleteShareButton.disabled = true;
    try {
      const response = await fetchWithTimeout(`${state.apiBaseUrl}/api/shares/${code}`, {
        method: "DELETE",
        headers: { "X-Delete-Token": token },
      });
      if (!response.ok && response.status !== 404) throw await parseApiError(response);
      storageRemove(`ponte-delete-${code}`);
      clearCreatedShare();
      showToast("Arquivos apagados do Railway.");
    } catch (error) {
      showToast(error.message || "Não foi possível apagar os arquivos.", "error");
    } finally {
      elements.deleteShareButton.disabled = false;
    }
  }

  function relativeExpiry(expiresAt) {
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return "expirou";
    const minutes = Math.max(1, Math.ceil(remaining / 60_000));
    if (minutes < 60) return `expira em ${minutes} min`;
    const hours = Math.ceil(minutes / 60);
    return `expira em ${hours} h`;
  }

  function exactDate(expiresAt) {
    const date = new Date(expiresAt);
    if (!Number.isFinite(date.getTime())) return "horário indisponível";
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
  }

  function updateExpiryCopies() {
    if (state.currentShare) {
      const expired = Date.parse(state.currentShare.expiresAt) <= Date.now();
      elements.shareExpiry.textContent = expired
        ? "Este envio expirou e foi removido."
        : `${relativeExpiry(state.currentShare.expiresAt)} • ${exactDate(state.currentShare.expiresAt)}`;
      elements.copyLinkButton.disabled = expired;
      elements.deleteShareButton.disabled = expired;
    }
    if (state.loadedShare) {
      const expired = Date.parse(state.loadedShare.expiresAt) <= Date.now();
      elements.downloadExpiry.textContent = expired
        ? "Esta ponte expirou. Atualize a busca para confirmar a remoção."
        : `${relativeExpiry(state.loadedShare.expiresAt)} • ${exactDate(state.loadedShare.expiresAt)}`;
      elements.downloadExpiry.dataset.tone = expired ? "error" : "normal";
    }
  }

  function statusForDownload(file) {
    const record = state.downloadStates.get(file.id) || { status: "ready", progress: 0 };
    const statuses = {
      ready: { copy: "Pronto para baixar", tone: "waiting" },
      downloading: { copy: `Baixando • ${Math.round(record.progress || 0)}%`, tone: "normal" },
      verifying: { copy: "Conferindo SHA‑256", tone: "normal" },
      completed: { copy: "Hash conferido • download iniciado", tone: "success" },
      cancelled: { copy: "Download cancelado", tone: "error" },
      failed: { copy: record.error || "Não foi possível baixar", tone: "error" },
    };
    return { record, ...(statuses[record.status] || statuses.ready) };
  }

  function renderDownloads() {
    elements.downloadList.replaceChildren();
    const share = state.loadedShare;
    const files = share?.files || [];
    elements.downloadEmpty.hidden = files.length > 0;
    elements.downloadList.hidden = files.length === 0;
    elements.clearDownloadButton.hidden = files.length === 0;
    elements.downloadExpiry.hidden = files.length === 0;
    elements.downloadSummary.textContent = files.length
      ? `Código ${displayCode(share.code)} • ${files.length} ${files.length === 1 ? "arquivo" : "arquivos"}`
      : "Digite um código para localizar os arquivos";

    for (const file of files) {
      const statusInfo = statusForDownload(file);
      const item = document.createElement("article");
      const main = document.createElement("div");
      const name = document.createElement("p");
      const meta = document.createElement("p");
      const size = document.createElement("span");
      const separator = document.createElement("span");
      const status = document.createElement("span");
      const progressTrack = document.createElement("div");
      const progressFill = document.createElement("div");
      const actions = document.createElement("div");
      const button = document.createElement("button");
      const active = statusInfo.record.status === "downloading" || statusInfo.record.status === "verifying";

      item.className = "transfer-item";
      item.dataset.fileId = file.id;
      main.className = "transfer-main";
      name.className = "file-name";
      name.textContent = sanitizeFilename(file.name);
      name.title = name.textContent;
      meta.className = "file-meta";
      size.textContent = formatBytes(file.size);
      separator.textContent = "•";
      separator.setAttribute("aria-hidden", "true");
      status.className = "status-copy";
      status.dataset.tone = statusInfo.tone;
      status.textContent = statusInfo.copy;
      meta.append(size, separator, status);
      main.append(name, meta);

      if (active) {
        progressTrack.className = "progress-track";
        progressTrack.setAttribute("role", "progressbar");
        progressTrack.setAttribute("aria-label", `Download de ${name.textContent}`);
        progressTrack.setAttribute("aria-valuemin", "0");
        progressTrack.setAttribute("aria-valuemax", "100");
        progressTrack.setAttribute("aria-valuenow", String(Math.round(statusInfo.record.progress || 0)));
        progressFill.className = "progress-fill";
        progressFill.style.width = `${Math.max(0, Math.min(100, statusInfo.record.progress || 0))}%`;
        progressTrack.append(progressFill);
        main.append(progressTrack);
      }

      actions.className = "transfer-actions";
      button.type = "button";
      button.dataset.downloadId = file.id;
      if (active) {
        button.className = "mini-button mini-button--danger";
        button.textContent = "Cancelar";
      } else {
        button.className = "mini-button";
        button.textContent = statusInfo.record.status === "completed" ? "Baixar novamente" : "Baixar";
      }
      actions.append(button);
      item.append(createFileIcon(file.name), main, actions);
      elements.downloadList.append(item);
    }
    updateExpiryCopies();
  }

  async function loadShare(rawCode, { updateUrl = true } = {}) {
    const code = normalizeCode(rawCode);
    if (code.length !== 8) {
      setCodeError("Digite os oito caracteres do código.");
      return;
    }
    setCodeError();
    try {
      await ensureApiReady();
      elements.receiveButton.disabled = true;
      elements.receiveButton.firstChild.textContent = "Buscando ";
      const response = await fetchWithTimeout(`${state.apiBaseUrl}/api/shares/${code}`, { cache: "no-store" });
      if (!response.ok) throw await parseApiError(response);
      state.loadedShare = await response.json();
      state.downloadStates.clear();
      elements.remoteCode.value = displayCode(code);
      renderDownloads();
      if (updateUrl) {
        const url = new URL(window.location.href);
        url.searchParams.set("codigo", code);
        url.searchParams.set("api", state.apiBaseUrl);
        history.replaceState(null, "", url);
      }
      showToast(`${state.loadedShare.files.length} ${state.loadedShare.files.length === 1 ? "arquivo encontrado" : "arquivos encontrados"}.`);
      document.querySelector("#downloadTitle")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      const messages = {
        SHARE_NOT_FOUND: "Código não encontrado. Confira e tente novamente.",
        SHARE_EXPIRED: "Esta ponte expirou e os arquivos já foram apagados.",
      };
      const message = messages[error.code] || error.message || "Não foi possível buscar a ponte.";
      setCodeError(message);
      showToast(message, "error", 6500);
    } finally {
      elements.receiveButton.disabled = false;
      elements.receiveButton.firstChild.textContent = "Buscar ";
    }
  }

  function clearLoadedShare() {
    for (const record of state.downloadStates.values()) record.controller?.abort();
    state.downloadStates.clear();
    state.loadedShare = null;
    elements.remoteCode.value = "";
    renderDownloads();
    const url = new URL(window.location.href);
    url.searchParams.delete("codigo");
    history.replaceState(null, "", url);
  }

  function saveBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = sanitizeFilename(filename);
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }

  async function downloadFile(file) {
    const existing = state.downloadStates.get(file.id);
    if (existing?.controller && ["downloading", "verifying"].includes(existing.status)) {
      existing.controller.abort();
      return;
    }
    const controller = new AbortController();
    const record = { status: "downloading", progress: 0, controller, error: "" };
    state.downloadStates.set(file.id, record);
    renderDownloads();

    try {
      const response = await fetch(`${state.apiBaseUrl}/api/shares/${state.loadedShare.code}/files/${file.id}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw await parseApiError(response);
      if (!response.body) throw new PonteError("Este navegador não permite acompanhar o download.", "STREAM_UNAVAILABLE");

      const expectedSize = Number(file.size);
      const responseSize = Number(response.headers.get("Content-Length") || expectedSize);
      const expectedHash = String(response.headers.get("X-File-Sha256") || file.sha256 || "").toLowerCase();
      if (responseSize !== expectedSize) throw new PonteError("O tamanho informado pelo servidor não confere.", "SIZE_MISMATCH");

      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      let lastProgress = -1;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        const progress = expectedSize ? Math.min(100, Math.floor((received / expectedSize) * 100)) : 0;
        if (progress !== lastProgress) {
          record.progress = progress;
          lastProgress = progress;
          if (progress % 2 === 0 || progress === 100) renderDownloads();
        }
      }
      if (received !== expectedSize) throw new PonteError("O arquivo chegou incompleto.", "INCOMPLETE_DOWNLOAD");

      record.status = "verifying";
      record.progress = 100;
      renderDownloads();
      const blob = new Blob(chunks, { type: file.mime || "application/octet-stream" });
      const digest = await sha256Hex(await blob.arrayBuffer());
      if (!expectedHash || digest !== expectedHash || (file.sha256 && digest !== String(file.sha256).toLowerCase())) {
        throw new PonteError("A verificação SHA‑256 falhou. O download foi bloqueado.", "HASH_MISMATCH");
      }
      saveBlob(blob, file.name);
      record.status = "completed";
      record.controller = null;
      renderDownloads();
      showToast(`“${sanitizeFilename(file.name)}” foi conferido e baixado.`);
    } catch (error) {
      if (error.name === "AbortError") {
        record.status = "cancelled";
        record.error = "";
        showToast("Download cancelado.", "info");
      } else {
        record.status = "failed";
        record.error = error.message || "Não foi possível baixar";
        showToast(record.error, "error", 7000);
      }
      record.controller = null;
      renderDownloads();
    }
  }

  function handleDownloadClick(event) {
    const button = event.target.closest("button[data-download-id]");
    if (!button || !state.loadedShare) return;
    const file = state.loadedShare.files.find((candidate) => candidate.id === button.dataset.downloadId);
    if (file) void downloadFile(file);
  }

  function initializeInstallExperience() {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.deferredInstallPrompt = event;
      const dismissedAt = Number(storageGet(INSTALL_DISMISS_KEY));
      if (dismissedAt && Date.now() - dismissedAt < INSTALL_REMINDER_DELAY) return;
      state.installTimer = window.setTimeout(() => {
        elements.installSuggestion.hidden = false;
      }, 3500);
    });
    window.addEventListener("appinstalled", () => {
      elements.installSuggestion.hidden = true;
      state.deferredInstallPrompt = null;
      showToast("Ponte instalada com sucesso.");
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
        showToast("O modo instalável não pôde ser preparado.", "info");
      });
    });
  }

  function bindEvents() {
    elements.remoteCode.addEventListener("input", () => {
      elements.remoteCode.value = displayCode(elements.remoteCode.value);
      if (elements.codeError.textContent) setCodeError();
    });
    elements.receiveForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void loadShare(elements.remoteCode.value);
    });

    elements.dropZone.addEventListener("click", () => elements.fileInput.click());
    elements.fileInput.addEventListener("change", () => addSelectedFiles(elements.fileInput.files));
    for (const eventName of ["dragenter", "dragover"]) {
      elements.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.add("is-dragging");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      elements.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.remove("is-dragging");
      });
    }
    elements.dropZone.addEventListener("drop", (event) => addSelectedFiles(event.dataTransfer.files));
    elements.selectionList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-remove-index]");
      if (!button) return;
      state.selectedFiles.splice(Number(button.dataset.removeIndex), 1);
      renderSelection();
    });
    elements.clearSelectionButton.addEventListener("click", () => {
      state.selectedFiles = [];
      renderSelection();
    });
    elements.uploadButton.addEventListener("click", () => void startUpload());
    elements.cancelUploadButton.addEventListener("click", () => state.uploadXhr?.abort());

    elements.copyLinkButton.addEventListener("click", async () => {
      if (!state.currentShareLink) return;
      try {
        await copyText(state.currentShareLink);
        showToast("Link copiado.");
      } catch {
        showToast("Não foi possível copiar. Use o QR Code.", "error");
      }
    });
    elements.deleteShareButton.addEventListener("click", () => void deleteCreatedShare());
    elements.downloadList.addEventListener("click", handleDownloadClick);
    elements.clearDownloadButton.addEventListener("click", clearLoadedShare);

    elements.menuButton.addEventListener("click", () => {
      elements.menuButton.setAttribute("aria-expanded", "true");
      openDialog(elements.menuDialog);
    });
    elements.menuDialog.addEventListener("close", () => {
      elements.menuButton.setAttribute("aria-expanded", "false");
    });
    elements.howButton.addEventListener("click", () => openDialog(elements.howDialog));
    elements.aboutButton.addEventListener("click", () => openDialog(elements.aboutDialog));
    elements.settingsButton.addEventListener("click", () => {
      elements.apiUrlInput.value = state.apiBaseUrl;
      setApiError();
      openDialog(elements.settingsDialog);
    });
    elements.privacyButton.addEventListener("click", () => openDialog(elements.privacyDialog));
    elements.settingsCloseButton.addEventListener("click", () => elements.settingsDialog.close("close"));

    elements.apiUrlInput.addEventListener("input", () => setApiError());
    elements.apiConfigForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      let baseUrl;
      try {
        baseUrl = normalizeApiUrl(elements.apiUrlInput.value);
        if (!baseUrl) throw new PonteError("Informe o domínio público gerado pelo Railway.", "INVALID_API_URL");
      } catch (error) {
        setApiError(error.message);
        return;
      }
      elements.saveApiButton.disabled = true;
      elements.saveApiButton.textContent = "Testando…";
      try {
        await connectApi(baseUrl);
        setApiError();
        elements.settingsDialog.close("saved");
        showToast("Railway conectado e salvo neste aparelho.");
        restoreCreatedShare();
        if (state.pendingCode) {
          const code = state.pendingCode;
          state.pendingCode = "";
          void loadShare(code, { updateUrl: false });
        }
      } catch (error) {
        setApiError(error.message);
      } finally {
        elements.saveApiButton.disabled = false;
        elements.saveApiButton.textContent = "Testar e salvar";
      }
    });

    for (const dialog of document.querySelectorAll("dialog")) {
      dialog.addEventListener("close", () => window.setTimeout(syncModalLock, 0));
      dialog.addEventListener("cancel", () => window.setTimeout(syncModalLock, 0));
    }

    elements.installDismissButton.addEventListener("click", () => {
      storageSet(INSTALL_DISMISS_KEY, String(Date.now()));
      elements.installSuggestion.hidden = true;
    });
    elements.installButton.addEventListener("click", async () => {
      const promptEvent = state.deferredInstallPrompt;
      if (!promptEvent) return;
      elements.installSuggestion.hidden = true;
      await promptEvent.prompt();
      state.deferredInstallPrompt = null;
    });

    window.addEventListener("offline", () => setStatus("Sem internet", "offline"));
    window.addEventListener("online", () => {
      if (state.apiBaseUrl) {
        state.apiProbePromise = connectApi(state.apiBaseUrl).catch(() => {}).finally(() => {
          state.apiProbePromise = null;
        });
      } else setStatus("Railway não configurado", "error");
    });
    window.addEventListener("pagehide", () => {
      window.clearInterval(state.expiryTimer);
      window.clearTimeout(state.installTimer);
      state.uploadXhr?.abort();
      for (const record of state.downloadStates.values()) record.controller?.abort();
    });
  }

  async function start() {
    bindEvents();
    renderSelection();
    renderDownloads();
    initializeInstallExperience();
    registerServiceWorker();
    state.expiryTimer = window.setInterval(updateExpiryCopies, 30_000);

    state.apiBaseUrl = resolveInitialApiUrl();
    if (!state.apiBaseUrl) {
      setStatus("Railway não configurado", "error");
      elements.apiUrlInput.value = "";
      window.setTimeout(() => openDialog(elements.settingsDialog), 400);
      return;
    }

    state.apiProbePromise = connectApi(state.apiBaseUrl)
      .then(() => {
        restoreCreatedShare();
        if (state.pendingCode) {
          const code = state.pendingCode;
          state.pendingCode = "";
          elements.remoteCode.value = displayCode(code);
          return loadShare(code, { updateUrl: false });
        }
        return null;
      })
      .catch((error) => {
        showToast(error.message, "error", 7000);
        elements.apiUrlInput.value = state.apiBaseUrl;
        openDialog(elements.settingsDialog);
      })
      .finally(() => {
        state.apiProbePromise = null;
      });
  }

  void start();
})();
