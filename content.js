(() => {
  if (location.href !== "https://otc.trkbit.co/bk/clientes/depositos") return;

  const QWEN_CHAT_COMPLETIONS_URL = "https://qwenvl.kevyn.com.br/v1/chat/completions";
  const PDFJS_MODULE_URL = chrome.runtime.getURL("node_modules/pdfjs-dist/build/pdf.mjs");
  const PDFJS_WORKER_URL = chrome.runtime.getURL("node_modules/pdfjs-dist/build/pdf.worker.mjs");
  const PDF_PENDING_PREVIEW = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='300' viewBox='0 0 240 300'%3E%3Crect width='240' height='300' fill='%23f5f7fa'/%3E%3Crect x='42' y='34' width='156' height='212' rx='8' fill='%23ffffff' stroke='%23cfd7e3'/%3E%3Cpath d='M156 34v52h42' fill='%23e7edf5'/%3E%3Ctext x='120' y='162' text-anchor='middle' font-family='Arial,Helvetica,sans-serif' font-size='34' font-weight='700' fill='%23647084'%3EPDF%3C/text%3E%3Ctext x='120' y='192' text-anchor='middle' font-family='Arial,Helvetica,sans-serif' font-size='13' fill='%23647084'%3Epage 1%3C/text%3E%3C/svg%3E";
  const DEFAULT_CLIENT = "JukaCross";
  const DEFAULT_CLIENT_ID = "39";
  const DEFAULT_DEPOSIT_BANK = "Creditag";
  const DEFAULT_DEPOSIT_BANK_ID = "10";
  const FILTERS_LIST_URL = "https://otc.trkbit.co/api/filters/list";
  const DEPOSIT_INSERT_URL = "https://otc.trkbit.co/api/operation/deposit/insert";
  const DEPOSIT_DEFAULTS = {
    idAsset: 3,
    status: "AWAITING",
    idCompany: 1,
    type: "TED",
    idBank: DEFAULT_DEPOSIT_BANK_ID,
    idUser: DEFAULT_CLIENT_ID,
    idDepositor: ""
  };
  const INSERT_HIDE_AFTER_MS = 1000;
  const QWEN_CONCURRENCY = 5;

  const state = {
    items: [],
    currentIndex: -1,
    processing: false,
    aborted: false,
    panelOpen: false,
    overlayOpen: false,
    inserting: false,
    nextId: 1,
    activeQwenRequestIds: new Set(),
    payerNameReloadingItemId: null,
    payerNameReloadErrorItemId: null,
    payerNameReloadError: "",
    amountReloadingItemId: null,
    amountReloadErrorItemId: null,
    amountReloadError: "",
    fullReloadingItemId: null,
    runId: 0,
    batchDate: "",
    batchClientId: DEFAULT_CLIENT_ID,
    batchClientName: DEFAULT_CLIENT,
    dateStepOpen: false,
    advancedOpen: false,
    filters: {
      banks: [{ idBank: DEFAULT_DEPOSIT_BANK_ID, name: DEFAULT_DEPOSIT_BANK }],
      clients: [{ idUser: DEFAULT_CLIENT_ID, username: DEFAULT_CLIENT }]
    },
    filtersLoading: false,
    filtersError: "",
    filtersPromise: null
  };

  const prompt = [
    "Extract bank transfer receipt data from this Brazilian receipt image or PDF page.",
    "Return only valid minified JSON. Do not use markdown.",
    "Required keys:",
    "raw_text, bank, destination_bank, source_bank, beneficiary, pix_key, payer_name, payer_document, amount, date, time, transaction_id.",
    "raw_text must be the visible receipt OCR text, preserving labels and line breaks as much as possible.",
    "bank and destination_bank must be the receiver/destination institution, not the sender/source bank, app, or bank that issued the receipt. Look for labels such as Instituição Destino, Instituição do destinatário, Instituição under Dados de quem vai receber, Instituição under Dados do recebedor, Para, Favorecido, or Destinatário.",
    "source_bank is optional and may contain the origin bank/app, such as Banco Bradesco S.A., C6 Bank, Mercado Pago, Sicredi, or Unicred.",
    "If the receiver is Cross Intermediação LTDA, Cross Intermediacao LTDA, BRASIL CASH IP S.A., BRASIL CASH INSTITUICAO DE PAGAMENTO S.A, or pix_key financeirojk@cross-otc.com, return bank as Creditag.",
    "pix_key must be empty unless a visible receiver/destination Pix key is explicitly printed under labels such as Chave, Chave Pix, or Chave PIX. Do not infer pix_key from prior receipts, destination name, destination CNPJ, BRASIL CASH, Cross Intermediação, or financeirojk@cross-otc.com unless that exact value is visibly printed next to a Chave label on this receipt.",
    "payer_name must be the depositor/sender/originator of the money, not the recipient.",
    "Look for labels and sections such as Conta de origem, Enviado por, Solicitante, Pagador, Nome do pagador, Remetente, Ordenante, Origem, De, Depositante, Dados do pagador, Dados da conta, Empresa, Favorecido pagador, or Titular da conta origem.",
    "For ARQ receipts, payer_name is the value under Enviado por. For Sicredi receipts, payer_name may be Solicitante or Nome do pagador. For Bradesco receipts, payer_name is usually the Empresa under Dados da conta, not the Nome under Dados de quem vai receber.",
    "For Itau/Itaú receipts with sections de and para, payer_name is the bold company/person immediately under de. Do not skip it because the section label is short; for example, if the de section shows VIP LINE LTDA, return payer_name as VIP LINE LTDA.",
    "For Mercado Pago receipts, payer_name is the bold company/person immediately under De. Ignore OCR artifacts printed after the legal name, such as trailing .-, . -, - or isolated punctuation; for example, return BROTHERCELL MANUTENCAO DE EQUIPAMENTOS ELETRONICOS LTDA, not BROTHERCELL MANUTENCAO DE EQUIPAMENTOS ELETRONICOS LTDA .-.",
    "For C6 Bank receipts, payer_name is the person or company shown in the Conta de origem section, after the initials/avatar, for example Track Cell. Do not use the first account block above the transaction details as payer_name because that is the destination/recipient.",
    "For Stone receipts, payer_name is the Nome under Dados de Origem. The name may wrap to a second line with a trailing number (e.g. FRANCISCO CANINDE BEZERRA FILHO on one line and 00859969126 on the next); include both lines joined with a space as the payer_name.",
    "Ignore beneficiary/destination labels and values for payer_name, including destinatário, beneficiário, recebedor, favorecido, destino, Para, Dados de quem vai receber, Cross Intermediação LTDA, Cross Intermediacao Ltda, BRASIL CASH, financeirojk@cross-otc.com, or CNPJ 52.006.135/0001-68.",
    "Preserve the payer name exactly as printed except trim extra spaces and remove trailing punctuation-only OCR noise, including capitalization.",
    "Use amount as a decimal number string with dot separator, for example 13030.00.",
    "Use date as DD/MM/YYYY. If a value is unknown, use an empty string."
  ].join(" ");

  const root = document.createElement("div");
  root.id = "rth-root";
  document.documentElement.appendChild(root);

  root.innerHTML = `
    <button class="rth-fab" type="button" title="Start receipt import">+</button>
    <section class="rth-panel" hidden>
      <div class="rth-panel-header">
        <div>
          <h2 class="rth-title">Receipt Import</h2>
          <div class="rth-muted">Drop receipts and keep using the page while Qwen reads them.</div>
        </div>
        <button class="rth-icon-button" type="button" data-action="close-panel" title="Close">x</button>
      </div>
      <div class="rth-panel-body">
        <label class="rth-dropzone">
          <input class="rth-file-input" type="file" accept="image/*,application/pdf,.pdf" multiple>
          <span><strong>Drop receipt images here</strong><br><span class="rth-muted">or click to choose files</span></span>
        </label>
        <div class="rth-progress-wrap">
          <div class="rth-progress-row">
            <span class="rth-progress-label">No receipts imported</span>
            <span class="rth-progress-count">0/0</span>
          </div>
          <div class="rth-progress"><div class="rth-progress-fill"></div></div>
        </div>
        <div class="rth-actions">
          <button class="rth-button rth-button-danger" type="button" data-action="abort">Abort</button>
        </div>
      </div>
    </section>
    <section class="rth-overlay" aria-hidden="true">
      <div class="rth-review">
        <div class="rth-overlay-header">
          <div>
            <h2 class="rth-title">Review Receipt</h2>
            <div class="rth-muted rth-review-subtitle">No receipt selected</div>
          </div>
          <button class="rth-icon-button" type="button" data-action="hide-overlay" title="Hide">x</button>
        </div>
        <div class="rth-review-strip" aria-label="Receipt pages"></div>
        <main class="rth-overlay-main">
          <div class="rth-image-pane"><img class="rth-receipt-image" alt="Receipt preview"></div>
          <div class="rth-form-pane">
            <div class="rth-form-pane-toolbar">
              <button class="rth-icon-button rth-reload-button rth-reload-all-button" type="button" data-action="rerun-all" title="Re-read all fields with Qwen" aria-label="Re-read all fields with Qwen">↻</button>
            </div>
            <div class="rth-duplicate-note" hidden></div>
            <div class="rth-form-grid">
              <div class="rth-field">
                <label for="rth-bank">Bank</label>
                <select id="rth-bank" data-field="bank_id"></select>
              </div>
              <div class="rth-field rth-field-full">
                <div class="rth-field-label-row">
                  <label for="rth-payer-name">Depositor</label>
                  <button class="rth-icon-button rth-field-icon-button rth-reload-button" type="button" data-action="rerun-payer-name" title="Read this depositor again with Qwen" aria-label="Read this depositor again with Qwen">↻</button>
                </div>
                <input id="rth-payer-name" data-field="payer_name" autocomplete="off">
                <div class="rth-payer-name-preview"></div>
              </div>
              <div class="rth-field">
                <div class="rth-field-label-row">
                  <label for="rth-amount">Amount</label>
                  <button class="rth-icon-button rth-field-icon-button rth-reload-button rth-reload-amount-button" type="button" data-action="rerun-amount" title="Read this amount again with Qwen" aria-label="Read this amount again with Qwen">↻</button>
                </div>
                <input id="rth-amount" data-field="amount" inputmode="decimal" autocomplete="off">
                <div class="rth-amount-preview"></div>
              </div>
              <div class="rth-field rth-field-full">
                <label for="rth-pix-key">Pix key</label>
                <input id="rth-pix-key" data-field="pix_key" autocomplete="off">
              </div>
              <div class="rth-field rth-field-full">
                <button class="rth-advanced-toggle" type="button" data-action="toggle-advanced" aria-expanded="false">Advanced</button>
              </div>
              <div class="rth-advanced-fields rth-field-full" hidden>
                <div class="rth-field">
                  <label for="rth-date">Purchase date</label>
                  <input id="rth-date" data-field="date" autocomplete="off" placeholder="DD/MM/YYYY">
                </div>
                <div class="rth-field">
                  <label for="rth-time">Time</label>
                  <input id="rth-time" data-field="time" autocomplete="off">
                </div>
                <div class="rth-field">
                  <label for="rth-document">Payer document</label>
                  <input id="rth-document" data-field="payer_document" autocomplete="off">
                </div>
                <div class="rth-field rth-field-full">
                  <label for="rth-beneficiary">Beneficiary</label>
                  <input id="rth-beneficiary" data-field="beneficiary" autocomplete="off">
                </div>
                <div class="rth-field rth-field-full">
                  <label for="rth-transaction">Transaction ID</label>
                  <input id="rth-transaction" data-field="transaction_id" autocomplete="off">
                </div>
                <div class="rth-field rth-field-full">
                  <label for="rth-notes">Notes</label>
                  <textarea id="rth-notes" data-field="notes"></textarea>
                </div>
              </div>
            </div>
            <div class="rth-error" hidden></div>
          </div>
        </main>
        <div class="rth-overlay-footer">
          <div class="rth-footer-left">
            <button class="rth-button rth-button-danger" type="button" data-action="abort">Abort</button>
          </div>
          <div class="rth-footer-right">
            <button class="rth-button rth-button-primary" type="button" data-action="fill">Fill</button>
            <button class="rth-button rth-button-primary" type="button" data-action="conclude" hidden>Conclude</button>
          </div>
        </div>
      </div>
    </section>
    <section class="rth-date-step" aria-hidden="true">
      <div class="rth-date-card">
        <div class="rth-panel-header">
          <div>
            <h2 class="rth-title">API Date</h2>
            <div class="rth-muted">This date will be used for every receipt in this upload.</div>
          </div>
        </div>
        <div class="rth-date-body">
          <label class="rth-field">
            <span>API date</span>
            <input class="rth-batch-date-input" type="date">
          </label>
          <label class="rth-field">
            <span>Client</span>
            <select class="rth-batch-client-select"></select>
          </label>
          <div class="rth-muted rth-filters-status"></div>
          <div class="rth-error rth-date-error" hidden></div>
        </div>
        <div class="rth-overlay-footer">
          <div class="rth-footer-left">
            <button class="rth-button rth-button-danger" type="button" data-action="abort">Abort</button>
          </div>
          <div class="rth-footer-right">
            <button class="rth-button rth-button-primary" type="button" data-action="confirm-date">Continue</button>
          </div>
        </div>
      </div>
    </section>
  `;

  const els = {
    fab: root.querySelector(".rth-fab"),
    panel: root.querySelector(".rth-panel"),
    dropzone: root.querySelector(".rth-dropzone"),
    fileInput: root.querySelector(".rth-file-input"),
    strip: root.querySelector(".rth-review-strip"),
    progressLabel: root.querySelector(".rth-progress-label"),
    progressCount: root.querySelector(".rth-progress-count"),
    progressFill: root.querySelector(".rth-progress-fill"),
    overlay: root.querySelector(".rth-overlay"),
    review: root.querySelector(".rth-review"),
    dateStep: root.querySelector(".rth-date-step"),
    batchDateInput: root.querySelector(".rth-batch-date-input"),
    batchClientSelect: root.querySelector(".rth-batch-client-select"),
    dateError: root.querySelector(".rth-date-error"),
    filtersStatus: root.querySelector(".rth-filters-status"),
    subtitle: root.querySelector(".rth-review-subtitle"),
    image: root.querySelector(".rth-receipt-image"),
    error: root.querySelector(".rth-error"),
    duplicateNote: root.querySelector(".rth-duplicate-note"),
    amountPreview: root.querySelector(".rth-amount-preview"),
    advancedToggle: root.querySelector(".rth-advanced-toggle"),
    advancedFields: root.querySelector(".rth-advanced-fields"),
    payerNamePreview: root.querySelector(".rth-payer-name-preview"),
    reloadButton: root.querySelector('[data-action="rerun-payer-name"]'),
    reloadAmountButton: root.querySelector('[data-action="rerun-amount"]'),
    reloadAllButton: root.querySelector('[data-action="rerun-all"]'),
    fillButton: root.querySelector('[data-action="fill"]'),
    concludeButton: root.querySelector('[data-action="conclude"]')
  };

  const fieldNodes = Array.from(root.querySelectorAll("[data-field]"));
  let pdfjsPromise = null;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "RTH_TOGGLE_PANEL") togglePanel();
  });

  els.fab.addEventListener("click", () => {
    if (hasReviewableItem()) openOverlay();
    else togglePanel();
  });

  document.addEventListener("keydown", (event) => {
    if (!state.overlayOpen || isTypingTarget(event.target)) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    navigateReceipt(event.key === "ArrowRight" ? 1 : -1);
  });

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "close-panel") setPanelOpen(false);
    if (action === "hide-overlay") hideOverlay();
    if (action === "abort") abortSession();
    if (action === "conclude") concludeSession();
    if (action === "confirm-date") await confirmBatchDate();
    if (action === "toggle-advanced") toggleAdvancedFields();
    if (action === "fill") await insertCurrentAndAdvance();
    if (action === "rerun-payer-name") await rerunCurrentPayerName();
    if (action === "rerun-amount") await rerunCurrentAmount();
    if (action === "rerun-all") await rerunAllFields();
  });

  fieldNodes.forEach((node) => {
    const applyNodeValue = () => {
      const item = getCurrentItem();
      if (!item) return;
      applyFieldValue(item, node.dataset.field, node.value);
      item.status = item.status === "inserted" ? "reviewed" : item.status;
      render();
    };
    node.addEventListener("input", applyNodeValue);
    node.addEventListener("change", applyNodeValue);
  });

  els.duplicateNote.addEventListener("click", (event) => {
    const btn = event.target.closest(".rth-dup-link");
    if (!btn) return;
    const index = parseInt(btn.dataset.dupIndex, 10);
    if (!Number.isFinite(index) || !state.items[index]) return;
    state.currentIndex = index;
    state.advancedOpen = false;
    render();
  });

  els.batchClientSelect.addEventListener("change", () => {
    const selected = getSelectedClient();
    state.batchClientId = selected.id;
    state.batchClientName = selected.name;
    state.items.forEach((item) => {
      item.data.client_id = selected.id;
      item.data.client = selected.name;
    });
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove("is-dragging");
    });
  });

  els.dropzone.addEventListener("drop", (event) => {
    addFiles(Array.from(event.dataTransfer?.files || []));
  });

  els.fileInput.addEventListener("change", () => {
    addFiles(Array.from(els.fileInput.files || []));
    els.fileInput.value = "";
  });

  function togglePanel() {
    setPanelOpen(!state.panelOpen);
  }

  function setPanelOpen(isOpen) {
    state.panelOpen = isOpen;
    els.panel.hidden = !isOpen;
    render();
  }

  function addFiles(files) {
    const receiptFiles = files.filter(isSupportedReceiptFile);
    if (!receiptFiles.length) return;
    state.aborted = false;
    state.runId += 1;
    receiptFiles.forEach((file) => {
      const isPdf = isPdfFile(file);
      const item = {
        id: state.nextId++,
        file,
        name: file.name || `Receipt ${state.nextId}`,
        objectUrl: isPdf ? PDF_PENDING_PREVIEW : URL.createObjectURL(file),
        objectUrlIsBlob: !isPdf,
        dataUrl: "",
        kind: isPdf ? "pdf" : "image",
        status: "queued",
        error: "",
        rawResponse: "",
        data: defaultReceiptData()
      };
      state.items.push(item);
    });
    if (state.currentIndex === -1) {
      state.currentIndex = state.items.findIndex((item) => item.status !== "inserted");
    }
    setPanelOpen(false);
    openDateStep();
    render();
  }

  function openDateStep() {
    state.dateStepOpen = true;
    state.batchDate = "";
    state.batchClientId = DEFAULT_CLIENT_ID;
    state.batchClientName = DEFAULT_CLIENT;
    els.batchDateInput.value = todayInputValue();
    els.dateError.hidden = true;
    els.dateError.textContent = "";
    els.dateStep.classList.add("is-open");
    els.dateStep.setAttribute("aria-hidden", "false");
    renderFilterSelects();
    state.filtersPromise = refreshFiltersForDateStep();
    window.setTimeout(() => els.batchDateInput.focus(), 0);
  }

  function hideDateStep() {
    state.dateStepOpen = false;
    els.dateStep.classList.remove("is-open");
    els.dateStep.setAttribute("aria-hidden", "true");
  }

  async function refreshFiltersForDateStep() {
    state.filtersLoading = true;
    state.filtersError = "";
    renderFilterSelects();
    try {
      const filters = await fetchFiltersList();
      state.filters = {
        banks: normalizeBankList(filters.banks),
        clients: normalizeClientList(filters.clients)
      };
      const defaultClient = findClientByName(DEFAULT_CLIENT) || state.filters.clients[0] || { idUser: DEFAULT_CLIENT_ID, username: DEFAULT_CLIENT };
      state.batchClientId = String(defaultClient.idUser);
      state.batchClientName = defaultClient.username;
      state.items.forEach((item) => {
        item.data.client_id = state.batchClientId;
        item.data.client = state.batchClientName;
      });
    } catch (error) {
      state.filtersError = error instanceof Error ? error.message : String(error);
    } finally {
      state.filtersLoading = false;
      renderFilterSelects();
      renderReview();
    }
  }

  async function fetchFiltersList() {
    const token = findBearerToken();
    const headers = {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json"
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(FILTERS_LIST_URL, {
      method: "GET",
      headers,
      credentials: "include"
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Could not load bank/client filters: HTTP ${response.status}${text ? ` - ${text.slice(0, 160)}` : ""}`);
    }
    return text ? JSON.parse(text) : {};
  }

  function normalizeBankList(banks) {
    const list = Array.isArray(banks) ? banks : [];
    const normalized = list
      .filter((bank) => bank?.idBank && bank?.name)
      .map((bank) => ({ idBank: String(bank.idBank), name: cleanText(bank.name) }));
    if (!normalized.some((bank) => bank.idBank === DEFAULT_DEPOSIT_BANK_ID)) {
      normalized.push({ idBank: DEFAULT_DEPOSIT_BANK_ID, name: DEFAULT_DEPOSIT_BANK });
    }
    return normalized;
  }

  function normalizeClientList(clients) {
    const list = Array.isArray(clients) ? clients : [];
    const normalized = list
      .filter((client) => client?.idUser && client?.username)
      .map((client) => ({ idUser: String(client.idUser), username: cleanText(client.username) }));
    if (!normalized.some((client) => client.idUser === DEFAULT_CLIENT_ID)) {
      normalized.push({ idUser: DEFAULT_CLIENT_ID, username: DEFAULT_CLIENT });
    }
    return normalized;
  }

  function renderFilterSelects() {
    renderClientSelect();
    renderBankSelect();
    els.filtersStatus.textContent = state.filtersLoading
      ? "Loading banks and clients..."
      : state.filtersError
        ? state.filtersError
        : "";
  }

  function renderClientSelect() {
    const currentValue = state.batchClientId || DEFAULT_CLIENT_ID;
    els.batchClientSelect.innerHTML = "";
    state.filters.clients.forEach((client) => {
      const option = document.createElement("option");
      option.value = String(client.idUser);
      option.textContent = client.username;
      els.batchClientSelect.appendChild(option);
    });
    els.batchClientSelect.value = state.filters.clients.some((client) => String(client.idUser) === currentValue) ? currentValue : DEFAULT_CLIENT_ID;
  }

  function renderBankSelect() {
    const bankSelect = root.querySelector('[data-field="bank_id"]');
    if (!bankSelect) return;
    const item = getCurrentItem();
    const currentValue = item?.data?.bank_id || DEFAULT_DEPOSIT_BANK_ID;
    bankSelect.innerHTML = "";
    state.filters.banks.forEach((bank) => {
      const option = document.createElement("option");
      option.value = String(bank.idBank);
      option.textContent = bank.name;
      bankSelect.appendChild(option);
    });
    if (currentValue && !state.filters.banks.some((bank) => String(bank.idBank) === String(currentValue))) {
      const option = document.createElement("option");
      option.value = String(currentValue);
      option.textContent = item?.data?.bank || `Bank ${currentValue}`;
      bankSelect.appendChild(option);
    }
    bankSelect.value = String(currentValue);
  }

  function getSelectedClient() {
    const selectedId = els.batchClientSelect.value || state.batchClientId || DEFAULT_CLIENT_ID;
    const client = state.filters.clients.find((entry) => String(entry.idUser) === String(selectedId));
    return {
      id: String(client?.idUser || selectedId),
      name: cleanText(client?.username || state.batchClientName || DEFAULT_CLIENT)
    };
  }

  function findClientByName(name) {
    const target = normalizeComparableText(name);
    return state.filters.clients.find((client) => normalizeComparableText(client.username) === target);
  }

  function findBankByName(name) {
    const target = normalizeComparableText(name);
    if (!target) return null;
    return state.filters.banks.find((bank) => normalizeComparableText(bank.name) === target) || null;
  }

  function findBankById(id) {
    return state.filters.banks.find((bank) => String(bank.idBank) === String(id)) || null;
  }

  function resolveDepositBank({ receiptBank, destinationBank, data }) {
    const defaultBank = findBankById(DEFAULT_DEPOSIT_BANK_ID) || findBankByName(DEFAULT_DEPOSIT_BANK) || { idBank: DEFAULT_DEPOSIT_BANK_ID, name: DEFAULT_DEPOSIT_BANK };
    if (isKnownCrossDestination(data) || isBrasilCashBank(receiptBank) || isBrasilCashBank(destinationBank)) {
      return { id: String(defaultBank.idBank), name: defaultBank.name };
    }

    const matchedDestinationBank = findBankByName(destinationBank);
    if (matchedDestinationBank) {
      return { id: String(matchedDestinationBank.idBank), name: matchedDestinationBank.name };
    }

    const matchedReceiptBank = findBankByName(receiptBank);
    if (matchedReceiptBank && !isLikelySourceBankForCrossReceipt(matchedReceiptBank.name, data)) {
      return { id: String(matchedReceiptBank.idBank), name: matchedReceiptBank.name };
    }

    const existingBank = findBankById(data.bank_id) || findBankByName(data.bank);
    const bank = existingBank || defaultBank;
    return { id: String(bank.idBank), name: bank.name };
  }

  function isKnownCrossDestination(data) {
    return (
      isKnownDestinationName(data.beneficiary) ||
      isKnownCrossPixKey(data.pix_key) ||
      isKnownDestinationDocument(data.beneficiary_document)
    );
  }

  function isKnownCrossPixKey(value) {
    return normalizeComparableText(value) === "financeirojk@cross-otc.com";
  }

  function isKnownDestinationDocument(value) {
    return cleanText(value).replace(/\D/g, "") === "52006135000168";
  }

  function isBrasilCashBank(value) {
    const text = normalizeComparableText(value);
    return text.includes("brasil cash");
  }

  function isLikelySourceBankForCrossReceipt(bankName, data) {
    return isKnownCrossDestination(data) && !isBrasilCashBank(bankName);
  }

  async function confirmBatchDate() {
    if (state.filtersLoading && state.filtersPromise) {
      await state.filtersPromise.catch(() => {});
    }
    const value = els.batchDateInput.value;
    if (!value) {
      els.dateError.hidden = false;
      els.dateError.textContent = "Please choose a date before continuing.";
      return;
    }
    const selected = getSelectedClient();
    state.batchDate = value;
    state.batchClientId = selected.id;
    state.batchClientName = selected.name;
    state.items.forEach((item) => {
      item.data.client_id = selected.id;
      item.data.client = selected.name;
    });
    hideDateStep();
    openOverlay();
    processQueue(state.runId);
    render();
  }

  async function processQueue(runId) {
    if (state.processing || state.aborted) return;
    state.processing = true;
    render();
    await Promise.all(Array.from({ length: QWEN_CONCURRENCY }, () => processQueuedReceipts(runId)));
    if (runId === state.runId) {
      state.processing = false;
      render();
    }
  }

  async function processQueuedReceipts(runId) {
    while (!state.aborted && runId === state.runId) {
      const item = claimNextQueuedItem();
      if (!item) return;
      await processQueuedReceipt(item, runId);
    }
  }

  function claimNextQueuedItem() {
    const item = state.items.find((entry) => entry.status === "queued");
    if (!item) return null;
    item.status = "processing";
    item.error = "";
    render();
    return item;
  }

  async function processQueuedReceipt(item, runId) {
    try {
      const extracted = await extractReceipt(item);
      if (state.aborted || runId !== state.runId) {
        item.status = "aborted";
        return;
      }
      item.data = normalizeReceiptData(extracted, item.data);
      item.rawResponse = JSON.stringify(extracted);
      item.status = "reviewed";
      if (state.currentIndex === -1 || !getCurrentItem() || getCurrentItem().status === "inserted") {
        state.currentIndex = state.items.indexOf(item);
      }
    } catch (error) {
      if (state.aborted || runId !== state.runId) {
        item.status = "aborted";
        item.error = "";
      } else {
        item.status = "error";
        item.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      render();
    }
  }

  async function rerunCurrentPayerName() {
    const item = getCurrentItem();
    if (!item || !canRerunPayerName(item)) return;
    const sessionRunId = state.runId;
    state.aborted = false;
    state.payerNameReloadingItemId = item.id;
    state.payerNameReloadErrorItemId = null;
    state.payerNameReloadError = "";
    clearOverlayError();
    render();
    try {
      const extracted = await extractReceipt(item);
      if (state.aborted || sessionRunId !== state.runId || !state.items.includes(item)) {
        return;
      }
      item.data.payer_name = normalizeReceiptData(extracted, item.data).payer_name;
      item.rawResponse = JSON.stringify(extracted);
      state.payerNameReloadErrorItemId = null;
      state.payerNameReloadError = "";
      if (state.currentIndex === state.items.indexOf(item)) {
        const payerNameInput = root.querySelector('[data-field="payer_name"]');
        if (payerNameInput) payerNameInput.value = item.data.payer_name;
      }
    } catch (error) {
      if (!state.aborted && sessionRunId === state.runId) {
        state.payerNameReloadErrorItemId = item.id;
        state.payerNameReloadError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (sessionRunId === state.runId) {
        state.payerNameReloadingItemId = null;
        render();
      }
    }
  }

  function canRerunPayerName(item) {
    return Boolean(item) && !isAnyReceiptBeingRead() && !state.inserting && !state.payerNameReloadingItemId && !state.amountReloadingItemId && ["reviewed", "error"].includes(item.status);
  }

  function canRerunAmount(item) {
    return Boolean(item) && !isAnyReceiptBeingRead() && !state.inserting && !state.payerNameReloadingItemId && !state.amountReloadingItemId && ["reviewed", "error"].includes(item.status);
  }

  async function rerunCurrentAmount() {
    const item = getCurrentItem();
    if (!item || !canRerunAmount(item)) return;
    const sessionRunId = state.runId;
    state.aborted = false;
    state.amountReloadingItemId = item.id;
    state.amountReloadErrorItemId = null;
    state.amountReloadError = "";
    clearOverlayError();
    render();
    try {
      const extracted = await extractReceipt(item);
      if (state.aborted || sessionRunId !== state.runId || !state.items.includes(item)) return;
      item.data.amount = normalizeReceiptData(extracted, item.data).amount;
      item.rawResponse = JSON.stringify(extracted);
      state.amountReloadErrorItemId = null;
      state.amountReloadError = "";
      if (state.currentIndex === state.items.indexOf(item)) {
        const amountInput = root.querySelector('[data-field="amount"]');
        if (amountInput) amountInput.value = item.data.amount;
      }
    } catch (error) {
      if (!state.aborted && sessionRunId === state.runId) {
        state.amountReloadErrorItemId = item.id;
        state.amountReloadError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (sessionRunId === state.runId) {
        state.amountReloadingItemId = null;
        render();
      }
    }
  }

  function canRerunAllFields(item) {
    return Boolean(item) && !isAnyReceiptBeingRead() && !state.inserting && !state.payerNameReloadingItemId && !state.amountReloadingItemId && ["reviewed", "error"].includes(item.status);
  }

  async function rerunAllFields() {
    const item = getCurrentItem();
    if (!item || !canRerunAllFields(item)) return;
    const sessionRunId = state.runId;
    state.aborted = false;
    state.fullReloadingItemId = item.id;
    state.payerNameReloadErrorItemId = null;
    state.payerNameReloadError = "";
    state.amountReloadErrorItemId = null;
    state.amountReloadError = "";
    item.status = "processing";
    item.error = "";
    clearOverlayError();
    render();
    try {
      const extracted = await extractReceipt(item);
      if (state.aborted || sessionRunId !== state.runId || !state.items.includes(item)) return;
      item.data = normalizeReceiptData(extracted, item.data);
      item.rawResponse = JSON.stringify(extracted);
      item.status = "reviewed";
    } catch (error) {
      if (!state.aborted && sessionRunId === state.runId) {
        item.status = "error";
        item.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (sessionRunId === state.runId) {
        state.fullReloadingItemId = null;
        render();
      }
    }
  }

  function isAnyReceiptBeingRead() {
    return state.processing || state.items.some((item) => item.status === "processing");
  }

  async function extractReceipt(item) {
    ensureExtensionContext();
    const dataUrl = await getQwenImageDataUrl(item);
    ensureExtensionContext();
    const requestId = `rth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.activeQwenRequestIds.add(requestId);
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "RTH_QWEN_EXTRACT",
        requestId,
        url: QWEN_CHAT_COMPLETIONS_URL,
        body: {
          model: "Qwen/Qwen2.5-VL-7B-Instruct-AWQ",
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: dataUrl } }
              ]
            }
          ]
        }
      });
    } catch (error) {
      throw rephraseExtensionError(error);
    } finally {
      state.activeQwenRequestIds.delete(requestId);
    }
    if (!result?.ok) throw new Error(result?.error || "Qwen request failed.");
    const payload = result.payload;
    const content = payload?.choices?.[0]?.message?.content ?? payload?.content ?? payload?.text ?? payload;
    return parseJsonFromModel(content);
  }

  function ensureExtensionContext() {
    if (!chrome?.runtime?.id) {
      throw new Error("Extension was reloaded. Please refresh this page to continue.");
    }
  }

  function rephraseExtensionError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (/Extension context invalidated|message port closed|receiving end does not exist/i.test(message)) {
      return new Error("Extension was reloaded. Please refresh this page to continue.");
    }
    return error instanceof Error ? error : new Error(message);
  }

  function isSupportedReceiptFile(file) {
    return file.type.startsWith("image/") || isPdfFile(file);
  }

  function isPdfFile(file) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
  }

  async function getQwenImageDataUrl(item) {
    if (item.dataUrl) return item.dataUrl;
    if (item.kind === "pdf") {
      const dataUrl = await renderPdfFirstPageToDataUrl(item.file);
      item.dataUrl = dataUrl;
      item.objectUrl = dataUrl;
      item.objectUrlIsBlob = false;
      render();
      return dataUrl;
    }
    const dataUrl = await fileToDataUrl(item.file);
    item.dataUrl = dataUrl;
    return dataUrl;
  }

  async function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(PDFJS_MODULE_URL).then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return pdfjs;
      });
    }
    return pdfjsPromise;
  }

  async function renderPdfFirstPageToDataUrl(file) {
    const pdfjs = await loadPdfjs();
    const bytes = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2.4, Math.max(1.2, 1600 / baseViewport.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Could not create a canvas to render the PDF.");
    await page.render({ canvasContext: context, viewport }).promise;
    await pdf.destroy();
    return canvas.toDataURL("image/png");
  }

  function parseJsonFromModel(content) {
    if (typeof content === "object" && content !== null) return content;
    const text = String(content || "").trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : text;
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) {
      throw new Error("Qwen did not return JSON.");
    }
    const slice = candidate.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(slice);
    } catch (err) {
      // Qwen sometimes emits invalid JSON escapes (\ç, \ã) when OCRing accented words.
      // Strip the stray backslash so the JSON parses.
      const cleaned = slice.replace(/\\([^"\\\/bfnrtu])/g, "$1");
      return JSON.parse(cleaned);
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error("Could not read file."));
      reader.readAsDataURL(file);
    });
  }

  function defaultReceiptData() {
    return {
      bank: DEFAULT_DEPOSIT_BANK,
      bank_id: DEFAULT_DEPOSIT_BANK_ID,
      client: state.batchClientName || DEFAULT_CLIENT,
      client_id: state.batchClientId || DEFAULT_CLIENT_ID,
      beneficiary: "",
      beneficiary_document: "",
      pix_key: "",
      payer_name: "",
      payer_document: "",
      amount: "",
      date: "",
      time: "",
      transaction_id: "",
      notes: ""
    };
  }

  function normalizeReceiptData(extracted, previous) {
    const data = { ...defaultReceiptData(), ...previous };
    const rawText = getExtractedRawText(extracted);
    data.client = cleanText(data.client || state.batchClientName || DEFAULT_CLIENT);
    data.client_id = String(data.client_id || state.batchClientId || DEFAULT_CLIENT_ID);
    data.beneficiary = cleanText(extracted.beneficiary || extracted.destinatario || extracted.favorecido || data.beneficiary);
    data.beneficiary_document = cleanText(
      extracted.beneficiary_document ||
        extracted.documento_beneficiario ||
        extracted.documento_destinatario ||
        extracted.cpf_cnpj_beneficiario ||
        extracted.cpf_cnpj_destinatario ||
        extracted.cnpj_destinatario ||
        extracted.cnpj_beneficiario ||
        data.beneficiary_document
    );
    data.pix_key = resolvePixKey({ extracted, rawText, previousPixKey: data.pix_key });
    const destinationBank = cleanText(
      extracted.destination_bank ||
        extracted.receiver_bank ||
        extracted.destino_bank ||
        extracted.instituicao_destino ||
        extracted.instituicao_do_destinatario ||
        extracted.instituicao_destinatario ||
        extracted.instituicao_recebedor ||
        extracted.instituicao_do_recebedor ||
        ""
    );
    const receiptBank = cleanText(extractDestinationBankFromText(rawText) || destinationBank || extracted.bank || extracted.banco || "");
    const matchedBank = resolveDepositBank({ receiptBank, destinationBank, data });
    data.bank = matchedBank.name;
    data.bank_id = matchedBank.id;
    data.payer_name = cleanPayerName(
      extracted.payer_name ||
        extracted.sender_name ||
        extracted.depositor ||
        extracted.depositante ||
        extracted.solicitante ||
        extracted.pagador ||
        extracted.nome_pagador ||
        extracted.nome_do_pagador ||
        extracted.enviado_por ||
        extracted.empresa ||
        extracted.empresa_origem ||
        extracted.nome_empresa ||
        extracted.nome_da_empresa ||
        extracted.dados_da_conta_empresa ||
        extracted.conta_origem ||
        extracted.conta_de_origem ||
        extracted.nome_conta_origem ||
        extracted.nome_da_conta_origem ||
        extracted.remetente ||
        extracted.ordenante ||
        extracted.titular ||
        extracted.titular_origem ||
        extracted.originator ||
        data.payer_name
    ).toUpperCase();
    if (isKnownDestinationName(data.payer_name)) {
      data.payer_name = cleanPayerName(
        extracted.conta_origem ||
          extracted.conta_de_origem ||
          extracted.nome_conta_origem ||
          extracted.nome_da_conta_origem ||
          extracted.sender_name ||
          extracted.remetente ||
          extracted.originator ||
          ""
      ).toUpperCase();
    }
    data.payer_document = cleanText(
      extracted.payer_document ||
        extracted.documento_pagador ||
        extracted.cpf_cnpj_pagador ||
        extracted.cpf_pagador ||
        extracted.cnpj_pagador ||
        extracted.documento_remetente ||
        data.payer_document
    );
    if (digitsOnlyText(data.payer_document) === RECIPIENT_CNPJ_DIGITS) {
      data.payer_document = "";
    }
    if (!data.payer_name || isKnownDestinationName(data.payer_name)) {
      const fallback = extractPayerFromRawText(rawText);
      if (fallback?.name) {
        data.payer_name = cleanPayerName(fallback.name).toUpperCase();
        if (fallback.document && !data.payer_document) {
          data.payer_document = cleanText(fallback.document);
        }
        if (fallback.date && !data.date) data.date = fallback.date;
        if (fallback.time && !data.time) data.time = fallback.time;
      }
    }
    data.amount = normalizeAmount(extracted.amount || extracted.valor || data.amount);
    data.date = normalizeDate(extracted.date || extracted.data || data.date);
    data.time = cleanText(extracted.time || extracted.hora || data.time);
    data.transaction_id = cleanText(extracted.transaction_id || extracted.e2e_id || extracted.id_transacao || data.transaction_id);
    data.notes = cleanText(extracted.notes || data.notes || "");
    return data;
  }

  const RECIPIENT_CNPJ_DIGITS = "52006135000168";
  const PT_MONTHS = {
    jan: "01", janeiro: "01", fev: "02", fevereiro: "02",
    mar: "03", marco: "03", "março": "03",
    abr: "04", abril: "04", mai: "05", maio: "05",
    jun: "06", junho: "06", jul: "07", julho: "07",
    ago: "08", agosto: "08", set: "09", setembro: "09",
    out: "10", outubro: "10", nov: "11", novembro: "11",
    dez: "12", dezembro: "12"
  };

  function digitsOnlyText(value) {
    return String(value || "").replace(/\D+/g, "");
  }

  // Layout-specific fallback extractors. Only consulted when the model returned a blank
  // or recipient-named depositor — kept here so the prompt can stay short and fast.
  function extractPayerFromRawText(rawText) {
    const raw = String(rawText || "");
    if (!raw) return null;

    if (/Confirma[çc][ãa]o de Opera[çc][ãa]o/i.test(raw) && /Transferir/i.test(raw)) {
      const m = raw.match(/Empresa\s*:\s*([^\n\r]+)/i);
      if (m) return { name: m[1] };
    }

    if (/via SISPAG/i.test(raw)) {
      const nameMatch = raw.match(/(?:^|\n)\s*de\s*\n\s*([^\n]+?)\s*\n\s*ag[êe]ncia\b/i);
      if (nameMatch) {
        const cpfMatch = raw.match(/(?:^|\n)\s*de\s*\n[\s\S]{0,240}?CPF ou CNPJ\s+([0-9.\-/]+)/i);
        const dtMatch = raw.match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\.?\s+(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})/);
        const result = { name: nameMatch[1] };
        if (cpfMatch) result.document = cpfMatch[1];
        if (dtMatch) {
          const mon = PT_MONTHS[dtMatch[2].toLowerCase()];
          if (mon) {
            result.date = `${dtMatch[1].padStart(2, "0")}/${mon}/${dtMatch[3]}`;
            result.time = `${dtMatch[4].padStart(2, "0")}:${dtMatch[5]}:${dtMatch[6]}`;
          }
        }
        return result;
      }
    }

    const btg = raw.match(/(?:^|\n)\s*De\s*\n\s*Origem\s*\n\s*([^\n]+)/);
    if (btg && !isKnownDestinationName(btg[1])) {
      const cpfMatch = raw.match(/(?:^|\n)\s*De\s*\n\s*Origem\s*\n[\s\S]{0,200}?CPF\/CNPJ\s*\n?\s*([0-9.\-/*]+)/i);
      return { name: btg[1], document: cpfMatch ? cpfMatch[1] : "" };
    }

    if (/Dados de origem/i.test(raw)) {
      const m = raw.match(/Dados de origem[\s\S]{0,80}?Nome\s*\n\s*([^\n]+?)\s*\n(?:\s*(?:CPF|CNPJ)\s*\n)?\s*([0-9.\-/]{11,20})\s*\n[\s\S]{0,80}?Institui[çc][ãa]o/i);
      if (m && !isKnownDestinationName(m[1])) {
        const docDigits = digitsOnlyText(m[2]);
        if (docDigits.length >= 11) {
          return { name: `${m[1]} ${docDigits}`, document: m[2] };
        }
      }
    }

    const deBlock = raw.match(/(?:^|\n)\s*De\s*\n\s*([^\n]+?)\s*\n\s*(?:CPF|CNPJ)\s*[:\n]\s*([0-9.\-/*]+)/i);
    if (deBlock && !isKnownDestinationName(deBlock[1])) {
      return { name: deBlock[1], document: deBlock[2] };
    }

    const origemBlock = raw.match(/Origem[\s\S]{0,60}?Nome\s*\n\s*([^\n]+)/i);
    if (origemBlock && !isKnownDestinationName(origemBlock[1])) {
      return { name: origemBlock[1] };
    }

    return null;
  }

  function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function normalizeComparableText(value) {
    return cleanText(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function cleanPayerName(value) {
    const text = cleanText(value);
    const stripped = text.replace(/[\s.\-–—…]+$/u, "").trim();
    // Preserve the Brazilian corporate suffix "S.A." — if it was originally there as
    // the suffix and the trailing-noise strip ate its final dot, put it back.
    if (/\bS\.A$/i.test(stripped) && /\bS\.A\.[\s.\-–—…]*$/i.test(text)) {
      return `${stripped}.`;
    }
    return stripped;
  }

  function cleanPixKey(value) {
    return cleanText(value).replace(/^chave(?:\s+pix)?\s*[:\-]\s*/i, "").trim();
  }

  function getExtractedRawText(extracted) {
    const raw = extracted.raw_text || extracted.ocr_text || extracted.text || extracted.receipt_text || "";
    if (Array.isArray(raw)) return raw.map((line) => cleanText(line)).filter(Boolean).join("\n");
    return String(raw || "");
  }

  function resolvePixKey({ extracted, rawText, previousPixKey }) {
    const explicitPixKey = extractPixKeyFromText(rawText);
    if (explicitPixKey) return explicitPixKey;
    if (rawText) return "";

    if (isLikelyMercadoPagoReceipt(extracted)) return "";

    return cleanPixKey(
      extracted.chave ||
        extracted.chave_pix ||
        extracted.chavepix ||
        extracted.pix_key ||
        extracted.receiver_pix_key ||
        extracted.destination_pix_key ||
        extracted.destinatario_chave ||
        extracted.favorecido_chave ||
        previousPixKey
    );
  }

  function extractPixKeyFromText(rawText) {
    const lines = String(rawText || "")
      .split(/\r?\n/)
      .map((line) => cleanText(line))
      .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const inlineMatch = line.match(/\bchave(?:\s+pix)?\b\s*[:\-]?\s*(.+)$/i);
      if (inlineMatch) {
        const candidate = cleanPixKey(inlineMatch[1]);
        if (isValidPixKeyCandidate(candidate)) return candidate;
      }

      if (/^chave(?:\s+pix)?$/i.test(line)) {
        for (let next = index + 1; next < Math.min(lines.length, index + 3); next += 1) {
          const candidate = cleanPixKey(lines[next]);
          if (isValidPixKeyCandidate(candidate)) return candidate;
        }
      }
    }

    return "";
  }

  function isValidPixKeyCandidate(value) {
    const text = cleanPixKey(value);
    if (!text || text.length > 140) return false;
    if (/^(cpf|cnpj|valor|data|id|c[oó]digo|ag[êe]ncia|conta|institui[cç][aã]o)\b/i.test(text)) return false;
    return /@/.test(text) || /^\+?\d{10,14}$/.test(text.replace(/\D/g, "")) || /^[0-9a-f]{32}$/i.test(text) || /^[0-9a-f-]{36}$/i.test(text);
  }

  function extractDestinationBankFromText(rawText) {
    const text = String(rawText || "");
    const patterns = [
      /Institui[cç][aã]o\s+Destino\s*[:\-]?\s*([^\n\r]+)/i,
      /Institui[cç][aã]o\s+do\s+destinat[aá]rio\s*[:\-]?\s*([^\n\r]+)/i,
      /Institui[cç][aã]o\s+do\s+recebedor\s*[:\-]?\s*([^\n\r]+)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return cleanText(match[1]);
    }
    return "";
  }

  function isLikelyMercadoPagoReceipt(extracted) {
    return JSON.stringify(extracted || {}).toLowerCase().includes("mercado pago");
  }

  function getDuplicateKeys() {
    const counts = new Map();
    state.items.forEach((item) => {
      const key = getDuplicateKey(item);
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return new Set(Array.from(counts).filter(([, count]) => count > 1).map(([key]) => key));
  }

  function getDuplicateKey(item) {
    if (!item?.data) return "";
    const date = normalizeDate(item.data.date);
    const time = cleanText(item.data.time);
    const payerDocument = cleanText(item.data.payer_document).replace(/\D/g, "");
    const amount = normalizeAmount(item.data.amount);
    const payerName = cleanPayerName(item.data.payer_name).toUpperCase();
    if (!date || !amount || !payerName) return "";
    return `${date}|${time}|${payerDocument}|${amount}|${payerName}`;
  }

  function getDuplicateReceiptNumbers(item) {
    const key = getDuplicateKey(item);
    if (!key) return [];
    return state.items
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry !== item && getDuplicateKey(entry) === key)
      .map(({ index }) => index + 1);
  }

  function isKnownDestinationName(value) {
    const text = normalizeComparableText(value);
    return text.includes("cross intermediacao") || text.includes("brasil cash");
  }

  function normalizeAmount(value) {
    const text = cleanText(value);
    if (!text) return "";
    const onlyNumber = text.replace(/[^\d,.]/g, "");
    if (!onlyNumber) return text;
    const decimal = parseLocalizedAmount(onlyNumber);
    return Number.isFinite(decimal) ? decimal.toFixed(2) : text;
  }

  function formatAmountForDisplay(value) {
    const amount = parseLocalizedAmount(value);
    if (!Number.isFinite(amount)) return "";
    return amount.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL"
    });
  }

  function parseLocalizedAmount(value) {
    const text = cleanText(value).replace(/[^\d,.]/g, "");
    if (!text) return Number.NaN;
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");

    if (lastComma !== -1 && lastDot !== -1) {
      const decimalSeparator = lastComma > lastDot ? "," : ".";
      return amountFromParts(text, decimalSeparator);
    }

    const separator = lastComma !== -1 ? "," : lastDot !== -1 ? "." : "";
    if (!separator) return Number(text);

    const parts = text.split(separator);
    if (parts.length > 2) {
      const cents = parts[parts.length - 1];
      if (cents.length <= 2) return amountFromParts(text, separator);
      return Number(parts.join(""));
    }

    const [whole, fraction] = parts;
    if (fraction.length === 3 && whole.length <= 3) return Number(`${whole}${fraction}`);
    if (fraction.length <= 2) return amountFromParts(text, separator);
    return Number(parts.join(""));
  }

  function amountFromParts(value, decimalSeparator) {
    const separatorIndex = value.lastIndexOf(decimalSeparator);
    const whole = value.slice(0, separatorIndex).replace(/[^\d]/g, "");
    const fraction = value.slice(separatorIndex + 1).replace(/[^\d]/g, "").padEnd(2, "0").slice(0, 2);
    return Number(`${whole || "0"}.${fraction}`);
  }

  function normalizeDate(value) {
    const text = cleanText(value);
    const match = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (!match) return text;
    const day = match[1].padStart(2, "0");
    const month = match[2].padStart(2, "0");
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${day}/${month}/${year}`;
  }

  function openOverlay(selectNextReviewable = false) {
    if (!state.overlayOpen) state.advancedOpen = false;
    if (selectNextReviewable) {
      const index = findNextReviewableIndex();
      if (index !== -1) state.currentIndex = index;
    }
    if (state.currentIndex === -1 && state.items.length) state.currentIndex = 0;
    if (!getCurrentItem()) {
      setPanelOpen(true);
      return;
    }
    state.overlayOpen = true;
    els.overlay.classList.add("is-open");
    els.overlay.setAttribute("aria-hidden", "false");
    render();
  }

  function hideOverlay() {
    state.overlayOpen = false;
    state.advancedOpen = false;
    els.overlay.classList.remove("is-open");
    els.overlay.setAttribute("aria-hidden", "true");
    render();
  }

  function toggleAdvancedFields() {
    state.advancedOpen = !state.advancedOpen;
    renderAdvancedFields();
  }

  function hasReviewableItem() {
    return state.items.some((item) => ["queued", "processing", "reviewed", "error", "inserted"].includes(item.status));
  }

  function getCurrentItem() {
    return state.items[state.currentIndex] || null;
  }

  function isTypingTarget(target) {
    const node = target instanceof Element ? target : null;
    if (!node) return false;
    return Boolean(node.closest("input, textarea, select, [contenteditable='true']"));
  }

  function navigateReceipt(direction) {
    if (!state.items.length) return;
    const startIndex = state.currentIndex === -1 ? 0 : state.currentIndex;
    const nextIndex = Math.min(state.items.length - 1, Math.max(0, startIndex + direction));
    if (nextIndex === state.currentIndex) return;
    state.currentIndex = nextIndex;
    state.advancedOpen = false;
    render();
  }

  function findNextReviewableIndex(startIndex = 0) {
    let index = state.items.findIndex((item, position) => position >= startIndex && ["reviewed", "error"].includes(item.status));
    if (index === -1) index = state.items.findIndex((item) => ["reviewed", "error"].includes(item.status));
    return index;
  }

  function abortSession() {
    state.aborted = true;
    state.runId += 1;
    state.activeQwenRequestIds.forEach((requestId) => {
      chrome.runtime.sendMessage({ type: "RTH_QWEN_ABORT", requestId }).catch(() => {});
    });
    state.activeQwenRequestIds.clear();
    state.items.forEach((item) => {
      if (item.objectUrlIsBlob) URL.revokeObjectURL(item.objectUrl);
    });
    state.items = [];
    state.currentIndex = -1;
    state.processing = false;
    state.inserting = false;
    state.payerNameReloadingItemId = null;
    state.payerNameReloadErrorItemId = null;
    state.payerNameReloadError = "";
    state.amountReloadingItemId = null;
    state.amountReloadErrorItemId = null;
    state.amountReloadError = "";
    state.fullReloadingItemId = null;
    state.batchDate = "";
    state.batchClientId = DEFAULT_CLIENT_ID;
    state.batchClientName = DEFAULT_CLIENT;
    state.advancedOpen = false;
    els.fileInput.value = "";
    hideDateStep();
    hideOverlay();
    setPanelOpen(false);
    render();
  }

  function concludeSession() {
    const unconfirmed = state.items.filter((item) => item.status !== "inserted").length;
    if (unconfirmed > 0) {
      const label = unconfirmed === 1 ? "1 receipt was not confirmed" : `${unconfirmed} receipts were not confirmed`;
      if (!window.confirm(`${label}. Conclude anyway?`)) return;
    }
    abortSession();
  }

  async function insertCurrentAndAdvance() {
    const item = getCurrentItem();
    if (!item || state.inserting) return;
    applyFieldsToItem(item);
    state.inserting = true;
    item.status = "inserting";
    clearOverlayError();
    render();
    const hideTimer = window.setTimeout(() => {
      if (state.inserting) hideOverlay();
    }, INSERT_HIDE_AFTER_MS);
    try {
      await insertDepositViaApi(item.data);
      const insertedIndex = state.items.indexOf(item);
      item.status = "inserted";
      item.error = "";
      window.clearTimeout(hideTimer);
      state.inserting = false;
      advanceToNextReviewable();
      if (getCurrentItem()) openOverlay();
      else {
        state.currentIndex = insertedIndex;
        openOverlay();
      }
      render();
    } catch (error) {
      window.clearTimeout(hideTimer);
      state.inserting = false;
      item.status = "error";
      item.error = error instanceof Error ? error.message : String(error);
      openOverlay();
      render();
    }
  }

  function applyFieldsToItem(item) {
    fieldNodes.forEach((node) => {
      applyFieldValue(item, node.dataset.field, node.value);
    });
    item.data.amount = normalizeAmount(item.data.amount);
  }

  function applyFieldValue(item, field, value) {
    if (field === "bank_id") {
      const bank = findBankById(value);
      item.data.bank_id = String(value || DEFAULT_DEPOSIT_BANK_ID);
      item.data.bank = cleanText(bank?.name || item.data.bank || DEFAULT_DEPOSIT_BANK);
      return;
    }
    if (field === "amount") {
      item.data.amount = value;
      return;
    }
    item.data[field] = value;
  }

  function advanceToNextReviewable() {
    const next = findNextReviewableIndex(state.currentIndex + 1);
    state.currentIndex = next;
    state.advancedOpen = false;
  }

  async function insertDepositViaApi(data) {
    const token = findBearerToken();
    if (!token) {
      throw new Error("Could not find the TRKBIT authorization token in browser storage. Please stay logged in and reload the page.");
    }

    const payload = {
      ...DEPOSIT_DEFAULTS,
      idBank: String(data.bank_id || DEFAULT_DEPOSIT_BANK_ID),
      idUser: String(data.client_id || state.batchClientId || DEFAULT_CLIENT_ID),
      amount: parseAmountForApi(data.amount),
      holder: cleanText(data.payer_name).slice(0, 45),
      date: parseBatchDateToIso(state.batchDate)
    };

    if (!payload.holder) throw new Error("Depositor name is empty.");
    if (!Number.isFinite(payload.amount) || payload.amount <= 0) throw new Error("Deposit amount is invalid.");

    const response = await fetch(DEPOSIT_INSERT_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload),
      credentials: "include"
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Deposit API failed: HTTP ${response.status}${responseText ? ` - ${responseText.slice(0, 240)}` : ""}`);
    }
  }

  function findBearerToken() {
    const sessionToken = extractJwt(sessionStorage.getItem("token"));
    if (sessionToken) return sessionToken;

    const directKeys = ["token", "accessToken", "access_token", "authToken", "jwt"];
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of directKeys) {
        const token = extractJwt(storage.getItem(key));
        if (token) return token;
      }
      for (let index = 0; index < storage.length; index += 1) {
        const token = extractJwt(storage.getItem(storage.key(index)));
        if (token) return token;
      }
    }
    return "";
  }

  function extractJwt(value) {
    if (!value) return "";
    const text = String(value);
    const match = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (match) return match[0];
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        for (const key of ["token", "accessToken", "access_token", "authToken", "jwt"]) {
          const token = extractJwt(parsed[key]);
          if (token) return token;
        }
      }
    } catch (_error) {
      return "";
    }
    return "";
  }

  function parseAmountForApi(value) {
    const text = cleanText(value);
    if (!text) return Number.NaN;
    return parseLocalizedAmount(text);
  }

  function parseBatchDateToIso(value) {
    const match = cleanText(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new Error("Batch deposit date is invalid.");
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    return new Date(year, month, day, 12, 0, 0, 0).toISOString();
  }

  function todayInputValue() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatBatchDateForDisplay(value) {
    const match = cleanText(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "";
    return `${match[3]}/${match[2]}/${match[1]}`;
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function render() {
    renderProgress();
    renderFab();
    renderThumbnails();
    renderFilterSelects();
    renderReview();
  }

  function renderProgress() {
    const total = state.items.length;
    const done = state.items.filter((item) => ["reviewed", "inserted", "error", "aborted"].includes(item.status)).length;
    const inserted = state.items.filter((item) => item.status === "inserted").length;
    const percent = total ? Math.round((done / total) * 100) : 0;
    els.progressLabel.textContent = total ? `${inserted} inserted, ${done} ready/handled` : "No receipts imported";
    els.progressCount.textContent = `${done}/${total}`;
    els.progressFill.style.width = `${percent}%`;
  }

  function renderFab() {
    const total = state.items.length;
    const inserted = state.items.filter((item) => item.status === "inserted").length;
    const processing = state.items.some((item) => item.status === "processing") || state.dateStepOpen;
    const active = total > 0;
    els.fab.textContent = active ? "✎" : "+";
    els.fab.title = active
      ? `${inserted === total ? "Conclude" : "Continue"} receipt import: ${inserted}/${total}${processing ? " processing" : ""}`
      : "Start receipt import";
  }

  function renderThumbnails() {
    els.strip.innerHTML = "";
    const duplicateKeys = getDuplicateKeys();
    state.items.forEach((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `rth-thumb rth-thumb-${item.status}`;
      const isDuplicate = duplicateKeys.has(getDuplicateKey(item));
      if (isDuplicate) row.classList.add("is-duplicate");
      if (index === state.currentIndex) row.classList.add("is-current");
      const disabled = ["queued", "processing", "aborted"].includes(item.status);
      row.setAttribute("aria-disabled", disabled ? "true" : "false");
      row.title = `${index + 1}. ${statusText(item)}${isDuplicate ? " - duplicate match" : ""}`;
      row.innerHTML = `
        <img class="rth-thumb-image" alt="" src="${item.objectUrl}">
        <span class="rth-thumb-loading" aria-hidden="true"></span>
        <span class="rth-thumb-badge">${index + 1}</span>
        <span class="rth-thumb-remove" role="button" aria-label="Remove receipt ${index + 1}" title="Remove receipt">x</span>
      `;
      row.addEventListener("click", () => {
        if (disabled) return;
        state.currentIndex = state.items.indexOf(item);
        state.advancedOpen = false;
        if (["reviewed", "error", "inserted"].includes(item.status)) openOverlay();
      });
      row.querySelector(".rth-thumb-remove").addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeReceiptFromReview(item);
      });
      els.strip.appendChild(row);
    });
  }

  function removeReceiptFromReview(item) {
    const index = state.items.indexOf(item);
    if (index === -1) return;
    if (!window.confirm(`Remove receipt ${index + 1} from review?`)) return;
    if (item.objectUrlIsBlob) URL.revokeObjectURL(item.objectUrl);
    state.items.splice(index, 1);
    if (!state.items.length) {
      state.currentIndex = -1;
      state.advancedOpen = false;
      hideOverlay();
      setPanelOpen(false);
      render();
      return;
    }
    if (state.currentIndex === index) {
      state.currentIndex = Math.min(index, state.items.length - 1);
      state.advancedOpen = false;
    } else if (state.currentIndex > index) {
      state.currentIndex -= 1;
    }
    render();
  }

  function renderReview() {
    const item = getCurrentItem();
    if (!item) {
      els.subtitle.textContent = "No receipt selected";
      els.image.removeAttribute("src");
      els.review.classList.remove("has-duplicate");
      els.duplicateNote.hidden = true;
      renderAdvancedFields();
      clearOverlayError();
      els.amountPreview.textContent = "";
      els.payerNamePreview.textContent = "";
      fieldNodes.forEach((node) => {
        node.value = "";
      });
      renderReviewActions(null);
      return;
    }
    const batchDateText = formatBatchDateForDisplay(state.batchDate);
    const clientText = cleanText(item.data.client || state.batchClientName || DEFAULT_CLIENT);
    const isDuplicate = getDuplicateKeys().has(getDuplicateKey(item));
    const duplicateReceiptNumbers = getDuplicateReceiptNumbers(item);
    els.subtitle.textContent = `${state.currentIndex + 1} of ${state.items.length}${batchDateText ? ` - ${batchDateText}` : ""}${clientText ? ` - Client: ${clientText}` : ""}`;
    els.review.classList.toggle("has-duplicate", isDuplicate);
    els.duplicateNote.hidden = !isDuplicate;
    els.duplicateNote.innerHTML = isDuplicate
      ? `Duplicate receipt — matches ${duplicateReceiptNumbers.map((n) => `<button class="rth-dup-link" data-dup-index="${n - 1}" type="button">#${n}</button>`).join(", ")}.`
      : "";
    els.image.src = item.objectUrl;
    renderAdvancedFields();
    fieldNodes.forEach((node) => {
      node.value = item.data[node.dataset.field] || "";
    });
    els.amountPreview.textContent = formatAmountPreview(item.data.amount);
    const payerNameFull = cleanText(item.data.payer_name || "");
    els.payerNamePreview.textContent = payerNameFull.length > 45 ? payerNameFull.slice(0, 45) : "";
    if (item.error) showOverlayError(item.error);
    else if (state.payerNameReloadErrorItemId === item.id && state.payerNameReloadError) showOverlayError(state.payerNameReloadError);
    else if (state.amountReloadErrorItemId === item.id && state.amountReloadError) showOverlayError(state.amountReloadError);
    else clearOverlayError();
    renderReviewActions(item);
  }

  function renderReviewActions(item) {
    const canFill = item && ["reviewed", "error"].includes(item.status) && hasRequiredFillFields(item);
    const canConclude = item?.status === "inserted" || (!canFill && state.items.some((entry) => entry.status === "inserted"));
    const isReloadingPayerName = Boolean(item && state.payerNameReloadingItemId === item.id);
    const isReloadingAmount = Boolean(item && state.amountReloadingItemId === item.id);
    const isReloadingAll = Boolean(item && state.fullReloadingItemId === item.id);
    els.reloadButton.disabled = isReloadingPayerName || !canRerunPayerName(item);
    els.reloadButton.classList.toggle("is-loading", isReloadingPayerName);
    els.reloadButton.title = isReloadingPayerName ? "Reading depositor with Qwen" : "Read this depositor again with Qwen";
    els.reloadAmountButton.disabled = isReloadingAmount || !canRerunAmount(item);
    els.reloadAmountButton.classList.toggle("is-loading", isReloadingAmount);
    els.reloadAmountButton.title = isReloadingAmount ? "Reading amount with Qwen" : "Read this amount again with Qwen";
    els.reloadAllButton.disabled = isReloadingAll || !canRerunAllFields(item);
    els.reloadAllButton.classList.toggle("is-loading", isReloadingAll);
    els.reloadAllButton.title = isReloadingAll ? "Re-reading all fields with Qwen" : "Re-read all fields with Qwen";
    els.fillButton.hidden = !canFill;
    els.fillButton.disabled = state.inserting || !canFill;
    els.concludeButton.hidden = !canConclude;
    els.concludeButton.disabled = state.inserting || !canConclude;
  }

  function hasRequiredFillFields(item) {
    if (!item?.data) return false;
    const depositor = cleanText(item.data.payer_name);
    const amount = parseAmountForApi(item.data.amount);
    return Boolean(depositor) && Number.isFinite(amount) && amount > 0;
  }

  function formatAmountPreview(value) {
    const text = cleanText(value);
    if (!text) return "";
    const formatted = formatAmountForDisplay(text);
    return formatted;
  }

  function renderAdvancedFields() {
    els.advancedFields.hidden = !state.advancedOpen;
    els.advancedToggle.textContent = state.advancedOpen ? "Hide advanced" : "Advanced";
    els.advancedToggle.setAttribute("aria-expanded", state.advancedOpen ? "true" : "false");
  }

  function statusText(item) {
    const labels = {
      queued: "Waiting for Qwen",
      processing: "Reading with Qwen",
      reviewed: "Ready to review",
      inserting: "Inserting into TRKBIT",
      inserted: "Inserted",
      error: `Needs attention${item.error ? `: ${item.error}` : ""}`,
      aborted: "Aborted"
    };
    return labels[item.status] || item.status;
  }

  function showOverlayError(message) {
    els.error.hidden = false;
    els.error.textContent = message;
  }

  function clearOverlayError() {
    els.error.hidden = true;
    els.error.textContent = "";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  render();
})();
