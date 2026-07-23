/* Care Hub — R1 tela de emergência (PT-BR).
 *
 * Etapa 1 (emergência): cartão de emergência com campos fixos + itens livres,
 * contatos na mesma tela, roteiros (checklists), perfil, identidade por nome,
 * offline e instalável. Tudo em português.
 *
 * ARMAZENAMENTO: tudo fica NESTE aparelho (localStorage). Nada é enviado a
 * lugar nenhum. O backend sincronizado e o link secreto são o próximo passo.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "carehub.r1.v1";
  const uid = () => "id-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  // Campos fixos do cartão de emergência (rótulos fornecidos pelo app; o
  // usuário preenche os valores). Isto NÃO é conteúdo médico — são apenas
  // etiquetas de um formulário, então não cruza a fronteira de "não é
  // dispositivo médico".
  const CARD_FIELDS = [
    { key: "allergies", label: "Alergias", emphasis: true,
      empty: "Não registrado — isso não significa que não há alergias.",
      hint: "Deixe em branco só se realmente não souber. Vazio aparece como “não registrado”, nunca como “nenhuma”." },
    { key: "bloodType", label: "Tipo sanguíneo", empty: "Não registrado" },
    { key: "insurance", label: "Plano de saúde", empty: "Não registrado",
      hint: "Operadora, número da carteirinha, telefone." },
    { key: "hospitals", label: "Hospitais para onde levar", empty: "Não registrado",
      hint: "Para onde levar em uma emergência, e o que evitar." },
  ];

  // ---------- Estado ----------
  const blank = () => ({
    me: { name: "" },
    profile: { name: "", dob: "", conditions: "", careNotes: "", updatedAt: "", updatedBy: "" },
    card: { fields: { allergies: "", bloodType: "", insurance: "", hospitals: "" },
            entries: [], reviewedAt: "", reviewedBy: "" },
    contacts: [],
    checklists: [],
    seenWelcome: false,
  });

  let state = load();
  let currentView = "emergency";

  function load() {
    let s;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      s = raw ? Object.assign(blank(), JSON.parse(raw)) : blank();
    } catch { s = blank(); }
    // Migrações leves para dados de versões anteriores:
    if (!s.card) s.card = blank().card;
    if (!s.card.fields) s.card.fields = { allergies: "", bloodType: "", insurance: "", hospitals: "" };
    if (!Array.isArray(s.card.entries)) s.card.entries = [];
    if (!s.profile) s.profile = blank().profile;
    // Alergias saíram do perfil e agora vivem no cartão de emergência.
    // Se havia alergia no perfil, move para o cartão automaticamente.
    if (s.profile.allergies && !s.card.fields.allergies) {
      s.card.fields.allergies = s.profile.allergies;
    }
    delete s.profile.allergies;
    return s;
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { alert("Não foi possível salvar neste aparelho — o armazenamento pode estar cheio ou bloqueado."); }
  }

  // ---------- Ajudantes de DOM ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const main = $("#main");
  const modalRoot = $("#modal-root");

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" });
  };
  function relTime(iso) {
    if (!iso) return "nunca";
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days <= 0) return "hoje";
    if (days === 1) return "ontem";
    if (days < 30) return `${days} dias atrás`;
    if (days < 60) return "há mais de um mês";
    return `há mais de ${Math.floor(days / 30)} meses`;
  }
  const stamp = (iso) => {
    if (!iso) return "";
    return new Date(iso).toLocaleString("pt-BR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  // ---------- Toast (confirmação visível) ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    // reflow para reiniciar a animação
    void t.offsetWidth;
    t.classList.add("toast--show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove("toast--show");
      setTimeout(() => (t.hidden = true), 250);
    }, 1800);
  }

  // ---------- Identidade ----------
  async function ensureName() {
    if (state.me.name) return true;
    const name = await nameDialog();
    if (name) { state.me.name = name.trim(); save(); renderHeader(); return true; }
    return false;
  }

  // ============================================================
  //  VISÕES
  // ============================================================
  const views = { emergency: renderEmergency, checklists: renderChecklists, profile: renderProfile };

  function setView(name) {
    currentView = name;
    document.querySelectorAll(".tab").forEach((t) =>
      t.setAttribute("aria-current", t.dataset.view === name ? "page" : "false"));
    render();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  function render() {
    main.innerHTML = "";
    (views[currentView] || renderEmergency)();
    main.appendChild(disclaimer());
  }
  function disclaimer() {
    return el("p", { class: "disclaimer" },
      "O Care Hub organiza as informações da sua própria família. Não é um dispositivo médico e não substitui orientação médica profissional. Mostra apenas o que a sua família registrou.");
  }

  // ============================================================
  //  EMERGÊNCIA (cartão + contatos, numa tela só)
  // ============================================================
  function renderEmergency() {
    // --- Cartão de emergência ---
    main.appendChild(el("div", { class: "section-head" },
      el("h2", {}, "Cartão de emergência"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Adicionar outro item ao cartão",
        onclick: () => editCardEntry() }, "＋")));

    main.appendChild(el("p", { class: "reviewed" },
      el("span", {}, state.card.reviewedAt
        ? `Revisado ${relTime(state.card.reviewedAt)}${state.card.reviewedBy ? " por " + state.card.reviewedBy : ""}`
        : "Ainda não revisado"),
      el("button", { class: "btn btn--ghost", style: "min-height:2.4rem;padding:0.3rem 0.7rem",
        onclick: markReviewed }, "Marcar como revisado")));

    // Campos fixos
    CARD_FIELDS.forEach((f) => {
      const val = state.card.fields[f.key];
      const box = el("div", { class: "item" + (f.emphasis ? " allergy-box" : ""),
        role: "button", tabindex: "0", style: "cursor:pointer",
        "aria-label": `${f.label}: ${val || "não registrado"}. Toque para editar.`,
        onclick: () => editCardField(f),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); editCardField(f); } } },
        el("div", { class: "row" },
          el("div", { class: "row__main" },
            f.emphasis ? el("span", { class: "badge-critical" }, f.label) : el("p", { class: "item__meta", style: "margin:0 0 0.2rem" }, f.label),
            val ? el("p", { class: "item__body" }, val) : el("p", { class: "item__body muted-none" }, f.empty)),
          el("span", { class: "row__controls", "aria-hidden": "true" }, el("span", { class: "icon-btn icon-btn--bordered" }, "✎"))));
      main.appendChild(box);
    });

    // Itens livres (o usuário cria o próprio título)
    const entries = sortedEntries();
    if (entries.length) {
      main.appendChild(el("p", { class: "reviewed", style: "margin-top:1rem" }, el("span", {}, "Outros itens")));
      entries.forEach((entry, idx) => {
        main.appendChild(el("div", { class: "item " + (entry.critical ? "item--critical" : "") },
          el("div", { class: "row" },
            el("div", { class: "row__main" },
              entry.critical ? el("span", { class: "badge-critical" }, "Crítico") : null,
              el("p", { class: "item__label" }, entry.label || "(sem título)"),
              entry.body ? el("p", { class: "item__body" }, entry.body) : el("p", { class: "item__body muted-none" }, "Sem detalhes")),
            el("div", { class: "row__controls" },
              moveBtn("up", idx, entries, moveEntry),
              moveBtn("down", idx, entries, moveEntry),
              el("button", { class: "icon-btn icon-btn--bordered", "aria-label": `Editar ${entry.label || "item"}`,
                onclick: () => editCardEntry(entry) }, "✎")))));
      });
    }
    main.appendChild(el("button", { class: "btn btn--ghost btn--block", style: "margin-top:0.6rem",
      onclick: () => editCardEntry() }, "＋ Adicionar outro item"));

    // --- Contatos de emergência (mesma tela) ---
    main.appendChild(el("div", { class: "section-head", style: "margin-top:2rem" },
      el("h2", {}, "Contatos de emergência"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Adicionar contato",
        onclick: () => editContact() }, "＋")));

    if (!state.contacts.length) {
      main.appendChild(el("div", { class: "empty" },
        el("strong", {}, "Nenhum contato ainda"),
        el("span", {}, "Adicione quem ligar primeiro. Você escolhe a ordem — o app nunca reordena.")));
    } else {
      state.contacts.forEach((c, idx) => {
        const actions = el("div", { style: "display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.6rem" },
          c.phone ? el("a", { class: "btn btn--call", href: `tel:${telHref(c.phone)}`, "aria-label": `Ligar para ${c.name}` }, "☎ Ligar") : null,
          c.phone && c.whatsapp ? el("a", { class: "btn btn--wa", href: `https://wa.me/${waNumber(c.phone)}`, target: "_blank", rel: "noopener", "aria-label": `WhatsApp de ${c.name}` }, "WhatsApp") : null);
        main.appendChild(el("div", { class: "item" },
          el("div", { class: "row" },
            el("div", { class: "row__main" },
              el("p", { class: "item__label" }, c.name || "(sem nome)"),
              el("p", { class: "item__body" }, c.role || el("span", { class: "muted-none" }, "Sem função")),
              el("p", { class: "item__meta" }, c.phone || "Sem número")),
            el("div", { class: "row__controls" },
              moveBtn("up", idx, state.contacts, moveContact),
              moveBtn("down", idx, state.contacts, moveContact),
              el("button", { class: "icon-btn icon-btn--bordered", "aria-label": `Editar ${c.name}`,
                onclick: () => editContact(c) }, "✎"))),
          actions));
      });
    }
  }

  function markReviewed() {
    ensureName().then((ok) => {
      if (!ok) return;
      state.card.reviewedAt = new Date().toISOString();
      state.card.reviewedBy = state.me.name;
      save(); render();
      toast("✓ Marcado como revisado hoje");
    });
  }
  function touchReview() {
    state.card.reviewedAt = new Date().toISOString();
    state.card.reviewedBy = state.me.name;
  }

  async function editCardField(f) {
    if (!(await ensureName())) return;
    const input = field(f.label, "textarea", state.card.fields[f.key], f.hint);
    openModal(f.label, [input.wrap], {
      submitText: "Salvar",
      onSubmit: () => {
        state.card.fields[f.key] = input.input.value.trim();
        touchReview(); save(); render(); toast("✓ Salvo"); return true;
      },
    });
  }

  const sortedEntries = () =>
    state.card.entries.map((e, i) => ({ e, i }))
      .sort((a, b) => (b.e.critical - a.e.critical) || ((a.e.order ?? 0) - (b.e.order ?? 0)) || (a.i - b.i))
      .map((x) => x.e);
  function moveEntry(entry, dir) {
    const group = sortedEntries().filter((e) => !!e.critical === !!entry.critical);
    const pos = group.indexOf(entry);
    const swap = group[pos + (dir === "up" ? -1 : 1)];
    if (!swap) return;
    group.forEach((e, i) => (e.order = i));
    const a = entry.order, b = swap.order;
    entry.order = b; swap.order = a;
    save(); render();
  }
  async function editCardEntry(entry) {
    if (!(await ensureName())) return;
    const isNew = !entry;
    const data = entry || { id: uid(), label: "", body: "", critical: false, order: state.card.entries.length };
    const label = field("Título", "text", data.label, "ex.: Desejo sobre reanimação, Contato da hospice");
    const body = field("Detalhes", "textarea", data.body, "");
    const crit = checkField("Marcar como crítico (aparece no topo, com aviso)", data.critical);
    const err = el("p", { class: "field-error", hidden: true });
    openModal(isNew ? "Adicionar item ao cartão" : "Editar item", [label.wrap, body.wrap, crit.wrap, err], {
      submitText: isNew ? "Adicionar" : "Salvar",
      onSubmit: () => {
        if (!label.input.value.trim() && !body.input.value.trim()) {
          err.hidden = false; err.textContent = "Escreva um título ou algum detalhe."; return false;
        }
        data.label = label.input.value.trim();
        data.body = body.input.value.trim();
        data.critical = crit.input.checked;
        if (isNew) state.card.entries.push(data);
        touchReview(); save(); render(); toast("✓ Salvo"); return true;
      },
      onDelete: isNew ? null : () => { state.card.entries = state.card.entries.filter((e) => e.id !== data.id); touchReview(); save(); render(); },
    });
  }

  // ---------- Contatos ----------
  function moveContact(c, dir) {
    const i = state.contacts.indexOf(c), j = i + (dir === "up" ? -1 : 1);
    if (j < 0 || j >= state.contacts.length) return;
    [state.contacts[i], state.contacts[j]] = [state.contacts[j], state.contacts[i]];
    save(); render();
  }
  async function editContact(c) {
    if (!(await ensureName())) return;
    const isNew = !c;
    const data = c || { id: uid(), name: "", role: "", phone: "", whatsapp: false };
    const name = field("Nome", "text", data.name, "");
    const role = field("Função ou relação", "text", data.role, "ex.: Hospice, Filha, Clínico");
    const phone = field("Telefone", "tel", data.phone, "Com DDD. Para WhatsApp, inclua o país (ex.: +55).");
    const wa = checkField("Também tem WhatsApp neste número", data.whatsapp);
    const err = el("p", { class: "field-error", hidden: true });
    openModal(isNew ? "Adicionar contato" : "Editar contato", [name.wrap, role.wrap, phone.wrap, wa.wrap, err], {
      submitText: isNew ? "Adicionar" : "Salvar",
      onSubmit: () => {
        if (!name.input.value.trim()) { err.hidden = false; err.textContent = "O nome é obrigatório."; return false; }
        Object.assign(data, { name: name.input.value.trim(), role: role.input.value.trim(),
          phone: phone.input.value.trim(), whatsapp: wa.input.checked });
        if (isNew) state.contacts.push(data);
        save(); render(); toast("✓ Salvo"); return true;
      },
      onDelete: isNew ? null : () => { state.contacts = state.contacts.filter((x) => x.id !== data.id); save(); render(); },
    });
  }
  const telHref = (p) => p.replace(/[^\d+]/g, "");
  const waNumber = (p) => p.replace(/[^\d]/g, "");

  // ============================================================
  //  ROTEIROS (checklists)
  // ============================================================
  let openChecklistId = null;
  let checkedSteps = new Set();

  function renderChecklists() {
    if (openChecklistId) return renderChecklistDetail();
    main.appendChild(el("div", { class: "section-head" },
      el("h2", {}, "Roteiros de emergência"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Adicionar roteiro", onclick: () => editChecklist() }, "＋")));
    if (!state.checklists.length) {
      main.appendChild(el("div", { class: "empty" },
        el("strong", {}, "Nenhum roteiro ainda"),
        el("span", {}, "Escreva os passos para uma situação que você quer estar pronto para enfrentar — uma queda, engasgo, uma reação. O app nunca escreve isso por você.")));
      return;
    }
    state.checklists.forEach((cl) => {
      main.appendChild(el("button", { class: "item", style: "display:block;width:100%;text-align:left;cursor:pointer",
        onclick: () => openChecklist(cl.id) },
        el("p", { class: "item__label" }, cl.title || "(sem título)"),
        el("p", { class: "item__meta" }, `${cl.steps.length} passo${cl.steps.length === 1 ? "" : "s"} · revisado ${relTime(cl.reviewedAt)}`)));
    });
  }
  function openChecklist(id) { openChecklistId = id; checkedSteps = new Set(); render(); }
  function renderChecklistDetail() {
    const cl = state.checklists.find((c) => c.id === openChecklistId);
    if (!cl) { openChecklistId = null; return renderChecklists(); }
    main.appendChild(el("div", { class: "section-head" },
      el("button", { class: "btn btn--ghost", style: "min-height:2.6rem", onclick: () => { openChecklistId = null; render(); } }, "← Voltar"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Editar este roteiro", onclick: () => editChecklist(cl) }, "✎")));
    main.appendChild(el("h2", {}, cl.title || "(sem título)"));
    if (cl.source) main.appendChild(el("p", { class: "reviewed" }, el("span", {}, "Fonte: " + cl.source)));
    cl.steps.forEach((s, i) => {
      const cb = el("input", { type: "checkbox", id: "st-" + s.id, "aria-label": `Passo ${i + 1}` });
      cb.checked = checkedSteps.has(s.id);
      const txt = el("label", { class: "step__text" + (cb.checked ? " checked" : ""), for: "st-" + s.id }, s.text || "");
      cb.addEventListener("change", () => { cb.checked ? checkedSteps.add(s.id) : checkedSteps.delete(s.id); txt.classList.toggle("checked", cb.checked); });
      const contact = s.contactId && state.contacts.find((c) => c.id === s.contactId);
      main.appendChild(el("div", { class: "step" },
        cb, el("span", { class: "step__num" }, (i + 1) + "."),
        el("div", { style: "flex:1" }, txt,
          contact && contact.phone ? el("a", { class: "btn btn--call", style: "margin-top:0.5rem", href: `tel:${telHref(contact.phone)}` }, `☎ Ligar para ${contact.name}`) : null)));
    });
    main.appendChild(el("p", { class: "reviewed", style: "margin-top:1rem" }, el("span", {}, "As marcações são um apoio — elas se limpam quando você reabre o roteiro.")));
  }
  async function editChecklist(cl) {
    if (!(await ensureName())) return;
    const isNew = !cl;
    const data = cl ? JSON.parse(JSON.stringify(cl)) : { id: uid(), title: "", source: "", steps: [], reviewedAt: "", reviewedBy: "" };
    if (!data.steps.length) data.steps.push({ id: uid(), text: "", contactId: "" });
    const title = field("Título", "text", data.title, "ex.: Se ela cair");
    const source = field("De onde vêm estes passos (opcional)", "text", data.source, "ex.: Neurologista, Dra. Alves");
    const stepsWrap = el("div", {});
    const err = el("p", { class: "field-error", hidden: true });
    const contactOptions = () => [el("option", { value: "" }, "— sem contato ligado —"),
      ...state.contacts.map((c) => el("option", { value: c.id }, c.name))];
    function drawSteps() {
      stepsWrap.innerHTML = "";
      stepsWrap.appendChild(el("label", { style: "font-weight:650;display:block;margin-bottom:0.4rem" }, "Passos, em ordem"));
      data.steps.forEach((s, i) => {
        const input = el("input", { type: "text", value: s.text, "aria-label": `Passo ${i + 1}`, placeholder: `Passo ${i + 1}` });
        input.addEventListener("input", () => (s.text = input.value));
        const sel = el("select", { "aria-label": `Contato do passo ${i + 1}`, style: "min-height:2.6rem;max-width:9rem" }, ...contactOptions());
        sel.value = s.contactId || "";
        sel.addEventListener("change", () => (s.contactId = sel.value));
        const del = el("button", { class: "icon-btn icon-btn--bordered", "aria-label": `Remover passo ${i + 1}`,
          onclick: () => { data.steps.splice(i, 1); if (!data.steps.length) data.steps.push({ id: uid(), text: "", contactId: "" }); drawSteps(); } }, "✕");
        stepsWrap.appendChild(el("div", { class: "step-editor" }, el("span", { class: "step__num" }, (i + 1) + "."), input));
        stepsWrap.appendChild(el("div", { style: "display:flex;gap:0.5rem;margin:-0.2rem 0 0.7rem 1.6rem" },
          state.contacts.length ? sel : null, del));
      });
      stepsWrap.appendChild(el("button", { class: "btn btn--ghost", type: "button",
        onclick: () => { data.steps.push({ id: uid(), text: "", contactId: "" }); drawSteps(); } }, "＋ Adicionar passo"));
    }
    drawSteps();
    openModal(isNew ? "Novo roteiro" : "Editar roteiro", [title.wrap, source.wrap, stepsWrap, err], {
      submitText: isNew ? "Criar" : "Salvar",
      onSubmit: () => {
        if (!title.input.value.trim()) { err.hidden = false; err.textContent = "O título é obrigatório."; return false; }
        data.title = title.input.value.trim();
        data.source = source.input.value.trim();
        data.steps = data.steps.filter((s) => s.text.trim());
        if (!data.steps.length) { err.hidden = false; err.textContent = "Adicione ao menos um passo."; return false; }
        data.reviewedAt = new Date().toISOString(); data.reviewedBy = state.me.name;
        const idx = state.checklists.findIndex((c) => c.id === data.id);
        if (idx >= 0) state.checklists[idx] = data; else state.checklists.push(data);
        save(); render(); toast("✓ Salvo"); return true;
      },
      onDelete: isNew ? null : () => { state.checklists = state.checklists.filter((c) => c.id !== data.id); openChecklistId = null; save(); render(); },
    });
  }

  // ============================================================
  //  PERFIL (sem alergias — agora vivem no cartão)
  // ============================================================
  function renderProfile() {
    main.appendChild(el("div", { class: "section-head" },
      el("h2", {}, "Perfil"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Editar perfil", onclick: () => editProfile() }, "✎")));
    const p = state.profile;
    field2("Nome", p.name);
    field2("Data de nascimento", p.dob ? fmtDate(p.dob) : "");
    field2("Condições", p.conditions);
    field2("Notas de cuidado", p.careNotes);
    main.appendChild(el("p", { class: "reviewed", style: "margin-top:0.8rem" },
      el("span", {}, "As alergias ficam no Cartão de emergência, não aqui.")));
    if (p.updatedAt) main.appendChild(el("p", { class: "reviewed" },
      el("span", {}, `Última edição ${stamp(p.updatedAt)}${p.updatedBy ? " por " + p.updatedBy : ""}`)));
    function field2(labelText, value) {
      main.appendChild(el("div", { class: "item" },
        el("p", { class: "item__meta", style: "margin:0 0 0.2rem" }, labelText),
        value ? el("p", { class: "item__body" }, value) : el("p", { class: "item__body muted-none" }, "Não registrado")));
    }
  }
  async function editProfile() {
    if (!(await ensureName())) return;
    const p = state.profile;
    const name = field("Nome", "text", p.name, "");
    const dob = field("Data de nascimento", "date", p.dob, "");
    const conditions = field("Condições", "textarea", p.conditions, "");
    const notes = field("Notas de cuidado", "textarea", p.careNotes, "");
    openModal("Editar perfil", [name.wrap, dob.wrap, conditions.wrap, notes.wrap], {
      submitText: "Salvar",
      onSubmit: () => {
        Object.assign(p, { name: name.input.value.trim(), dob: dob.input.value,
          conditions: conditions.input.value.trim(), careNotes: notes.input.value.trim(),
          updatedAt: new Date().toISOString(), updatedBy: state.me.name });
        save(); render(); toast("✓ Salvo"); return true;
      },
    });
  }

  // ============================================================
  //  Peças reutilizáveis
  // ============================================================
  function moveBtn(dir, idx, arr, fn) {
    const disabled = dir === "up" ? idx === 0 : idx === arr.length - 1;
    const item = arr[idx];
    return el("button", { class: "icon-btn icon-btn--bordered", "aria-label": dir === "up" ? "Mover para cima" : "Mover para baixo",
      disabled: disabled || undefined, onclick: () => fn(item, dir) }, dir === "up" ? "↑" : "↓");
  }
  function field(labelText, type, value, hint) {
    const id = uid();
    const input = type === "textarea" ? el("textarea", { id, rows: 3 }) : el("input", { id, type });
    input.value = value || "";
    const wrap = el("div", { class: "field" }, el("label", { for: id }, labelText), input,
      hint ? el("p", { class: "hint" }, hint) : null);
    return { wrap, input };
  }
  function checkField(labelText, checked) {
    const id = uid();
    const input = el("input", { type: "checkbox", id });
    input.checked = !!checked;
    return { wrap: el("div", { class: "field field--check" }, input, el("label", { for: id }, labelText)), input };
  }

  // ---------- Modal ----------
  let lastFocus = null;
  function openModal(titleText, bodyNodes, { submitText = "Salvar", onSubmit, onDelete } = {}) {
    lastFocus = document.activeElement;
    modalRoot.innerHTML = "";
    const dialog = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": titleText });
    dialog.appendChild(el("h2", {}, titleText));
    bodyNodes.forEach((n) => n && dialog.appendChild(n));
    dialog.appendChild(el("div", { class: "modal__actions" },
      el("button", { class: "btn btn--ghost", type: "button", onclick: closeModal }, "Cancelar"),
      el("button", { class: "btn btn--primary", type: "button", onclick: () => { if (onSubmit() !== false) closeModal(); } }, submitText)));
    if (onDelete) dialog.appendChild(el("button", { class: "btn btn--danger btn--block", type: "button", style: "margin-top:0.6rem",
      onclick: () => { if (confirm("Excluir? Não dá para desfazer.")) { onDelete(); closeModal(); } } }, "Excluir"));
    modalRoot.appendChild(dialog);
    modalRoot.hidden = false;
    modalRoot.addEventListener("mousedown", backdropClose);
    document.addEventListener("keydown", escClose);
    const first = dialog.querySelector("input,textarea,select,button");
    if (first) first.focus();
  }
  function closeModal() {
    modalRoot.hidden = true; modalRoot.innerHTML = "";
    modalRoot.removeEventListener("mousedown", backdropClose);
    document.removeEventListener("keydown", escClose);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  const backdropClose = (e) => { if (e.target === modalRoot) closeModal(); };
  const escClose = (e) => { if (e.key === "Escape") closeModal(); };

  function nameDialog() {
    return new Promise((resolve) => {
      const f = field("Seu nome", "text", state.me.name, "É assim que suas anotações são assinadas, para os outros saberem quem registrou.");
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      lastFocus = document.activeElement;
      modalRoot.innerHTML = "";
      const dialog = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Seu nome" });
      dialog.appendChild(el("h2", {}, "Qual é o seu nome?"));
      dialog.appendChild(f.wrap);
      const err = el("p", { class: "field-error", hidden: true }, "Digite um nome.");
      dialog.appendChild(err);
      dialog.appendChild(el("div", { class: "modal__actions" },
        el("button", { class: "btn btn--primary btn--block", type: "button", onclick: () => {
          if (!f.input.value.trim()) { err.hidden = false; return; }
          modalRoot.hidden = true; modalRoot.innerHTML = "";
          if (lastFocus && lastFocus.focus) lastFocus.focus();
          finish(f.input.value.trim());
        } }, "Continuar")));
      modalRoot.appendChild(dialog);
      modalRoot.hidden = false;
      f.input.focus();
    });
  }

  // ---------- Configurações ----------
  function openMenu() {
    const nameField = field("Seu nome", "text", state.me.name, "Mudar aqui não renomeia registros antigos — eles mantêm o nome de quando foram feitos.");
    openModal("Configurações", [
      nameField.wrap,
      el("hr", { style: "border:none;border-top:1px solid var(--border);margin:1rem 0" }),
      el("p", { class: "hint" }, "Esta versão guarda tudo só neste aparelho. Nada é enviado a lugar nenhum."),
      el("button", { class: "btn btn--danger btn--block", type: "button", style: "margin-top:0.5rem",
        onclick: () => { if (confirm("Sair e apagar TODOS os dados do Care Hub DESTE aparelho? Não dá para desfazer.")) {
          localStorage.removeItem(STORAGE_KEY); state = blank(); closeModal(); renderHeader(); setView("emergency"); } } },
        "Sair e apagar deste aparelho"),
    ], {
      submitText: "Salvar nome",
      onSubmit: () => { if (nameField.input.value.trim()) { state.me.name = nameField.input.value.trim(); save(); renderHeader(); } return true; },
    });
  }

  // ---------- Cabeçalho / rede ----------
  function renderHeader() {
    $("#header-sub").textContent = state.me.name ? `Você: ${state.me.name}` : "Emergência e cuidados";
  }
  function updateNet() {
    const b = $("#net-banner");
    if (!navigator.onLine) { b.hidden = false; b.textContent = "Sem internet — mostrando sua cópia salva neste aparelho."; }
    else b.hidden = true;
  }

  // ============================================================
  //  Início
  // ============================================================
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
  $("#menu-btn").addEventListener("click", openMenu);
  window.addEventListener("online", updateNet);
  window.addEventListener("offline", updateNet);

  renderHeader();
  updateNet();
  setView("emergency");

  if (!state.seenWelcome) { state.seenWelcome = true; save(); ensureName(); }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
