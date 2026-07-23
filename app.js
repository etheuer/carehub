/* Care Hub — R1 (PT-BR). Abas: Rotina (principal), Emergência, Perfil.
 *
 * Rotina: linha do tempo do dia — medicamentos (horário fixo + SOS), tarefas de
 * cuidado, anotações livres e o relatório do dia. Cadastro e registro no mesmo
 * lugar. Sem "perdido" automático: dose/tarefa sem registro fica "não registrado".
 *
 * ARMAZENAMENTO: tudo fica NESTE aparelho (localStorage). Nada é enviado.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "carehub.r1.v1";
  const uid = () => "id-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const WD = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  // Campos fixos do cartão de emergência (rótulos do app; valores do usuário).
  const CARD_FIELDS = [
    { key: "allergies", label: "Alergias", emphasis: true,
      empty: "Não registrado — isso não significa que não há alergias.",
      hint: "Deixe em branco só se realmente não souber. Vazio aparece como “não registrado”, nunca como “nenhuma”." },
    { key: "bloodType", label: "Tipo sanguíneo", empty: "Não registrado" },
    { key: "insurance", label: "Plano de saúde", empty: "Não registrado", hint: "Operadora, número da carteirinha, telefone." },
    { key: "hospitals", label: "Hospitais para onde levar", empty: "Não registrado", hint: "Para onde levar em uma emergência, e o que evitar." },
  ];

  const blank = () => ({
    me: { name: "" },
    profile: { name: "", dob: "", conditions: "", careNotes: "", updatedAt: "", updatedBy: "" },
    card: { fields: { allergies: "", bloodType: "", insurance: "", hospitals: "" }, entries: [], reviewedAt: "", reviewedBy: "" },
    contacts: [],
    medications: [],   // {id,name,dose,howTo,kind:'fixed'|'prn',times:[],weekdays:[],minIntervalMin,active}
    tasks: [],         // {id,title,howTo,times:[],weekdays:[],active}
    medEvents: [],     // {id,medId,dateKey,time(null=SOS),outcome:'given'|'notGiven',at,note,by}
    taskEvents: [],    // {id,taskId,dateKey,time,outcome:'done'|'notDone',at,note,by}
    notes: [],         // {id,at,body,by,editedAt}
    reports: {},       // { "YYYY-MM-DD": {body,by,at} }
    seenWelcome: false,
  });

  let state = load();
  let currentView = "routine";
  let viewedDay = keyOf(new Date());

  function load() {
    let s;
    try { const raw = localStorage.getItem(STORAGE_KEY); s = raw ? Object.assign(blank(), JSON.parse(raw)) : blank(); }
    catch { s = blank(); }
    const b = blank();
    for (const k of ["profile", "card", "contacts", "medications", "tasks", "medEvents", "taskEvents", "notes", "reports"])
      if (s[k] == null) s[k] = b[k];
    if (!s.card.fields) s.card.fields = b.card.fields;
    if (!Array.isArray(s.card.entries)) s.card.entries = [];
    // Alergias saíram do perfil → cartão de emergência.
    if (s.profile.allergies && !s.card.fields.allergies) s.card.fields.allergies = s.profile.allergies;
    delete s.profile.allergies;
    delete s.checklists; // recurso removido do R1
    return s;
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { alert("Não foi possível salvar neste aparelho — o armazenamento pode estar cheio ou bloqueado."); }
  }

  // ---------- DOM ----------
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
    for (const c of children.flat()) { if (c == null || c === false) continue; node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
    return node;
  }

  // ---------- Datas/horas ----------
  function pad2(n) { return String(n).padStart(2, "0"); }
  function keyOf(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function parseKey(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }
  function weekdayOf(k) { return parseKey(k).getDay(); }
  function addDays(k, n) { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); }
  function hhmm(iso) { const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
  function nowHHMM() { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
  function headingFor(k) {
    const today = keyOf(new Date());
    if (k === today) return "Hoje";
    if (k === addDays(today, -1)) return "Ontem";
    if (k === addDays(today, 1)) return "Amanhã";
    const d = parseKey(k);
    return `${WD[d.getDay()]}, ${d.getDate()}/${pad2(d.getMonth() + 1)}`;
  }
  const stamp = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const fmtDate = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" }); };
  function relTime(iso) {
    if (!iso) return "nunca";
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days <= 0) return "hoje"; if (days === 1) return "ontem"; if (days < 30) return `${days} dias atrás`;
    if (days < 60) return "há mais de um mês"; return `há mais de ${Math.floor(days / 30)} meses`;
  }
  function sinceText(iso) {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "agora"; if (mins < 60) return `há ${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h < 24) return `há ${h}h${m ? " " + m + "min" : ""}`;
    return `há ${Math.floor(h / 24)} dia(s)`;
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false; void t.offsetWidth; t.classList.add("toast--show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove("toast--show"); setTimeout(() => (t.hidden = true), 250); }, 1800);
  }

  async function ensureName() {
    if (state.me.name) return true;
    const name = await nameDialog();
    if (name) { state.me.name = name.trim(); save(); renderHeader(); return true; }
    return false;
  }

  // ============================================================
  //  VISÕES
  // ============================================================
  const views = { routine: renderRoutine, emergency: renderEmergency, profile: renderProfile };
  function setView(name) {
    currentView = name;
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-current", t.dataset.view === name ? "page" : "false"));
    render(); main.focus({ preventScroll: true }); window.scrollTo(0, 0);
  }
  function render() { main.innerHTML = ""; (views[currentView] || renderRoutine)(); main.appendChild(disclaimer()); }
  function disclaimer() {
    return el("p", { class: "disclaimer" },
      "O Care Hub organiza as informações da sua própria família. Não é um dispositivo médico e não substitui orientação médica profissional. Mostra apenas o que a sua família registrou.");
  }

  // ============================================================
  //  ROTINA (feed do dia)
  // ============================================================
  const activeMeds = () => state.medications.filter((m) => m.active !== false);
  const prnMeds = () => activeMeds().filter((m) => m.kind === "prn");
  const findMedEv = (medId, dayKey, time) => state.medEvents.find((e) => e.medId === medId && e.dateKey === dayKey && e.time === time);
  const findTaskEv = (taskId, dayKey, time) => state.taskEvents.find((e) => e.taskId === taskId && e.dateKey === dayKey && e.time === time);
  const lastPrn = (medId) => state.medEvents.filter((e) => e.medId === medId && e.time === null).sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  // Uma ocorrência está no futuro se o dia é posterior a hoje, ou é hoje e a hora
  // ainda não chegou. Não se registra o que ainda não aconteceu.
  function isFutureOcc(dayKey, time) { const t = keyOf(new Date()); return dayKey > t || (dayKey === t && time > nowHHMM()); }

  function feedFor(dayKey) {
    const wd = weekdayOf(dayKey), rows = [];
    activeMeds().filter((m) => m.kind === "fixed").forEach((m) => {
      if (m.weekdays && m.weekdays.length && !m.weekdays.includes(wd)) return;
      (m.times || []).forEach((t) => rows.push({ sort: t, time: t, kind: "med", med: m, ev: findMedEv(m.id, dayKey, t) }));
    });
    state.tasks.filter((tk) => tk.active !== false).forEach((tk) => {
      if (tk.weekdays && tk.weekdays.length && !tk.weekdays.includes(wd)) return;
      (tk.times || []).forEach((t) => rows.push({ sort: t, time: t, kind: "task", task: tk, ev: findTaskEv(tk.id, dayKey, t) }));
    });
    state.medEvents.filter((e) => e.dateKey === dayKey && e.time === null).forEach((e) => {
      const m = state.medications.find((x) => x.id === e.medId);
      if (m) rows.push({ sort: hhmm(e.at), time: hhmm(e.at), kind: "prn", med: m, ev: e });
    });
    state.notes.filter((n) => keyOf(new Date(n.at)) === dayKey).forEach((n) => rows.push({ sort: hhmm(n.at), time: hhmm(n.at), kind: "note", note: n }));
    rows.sort((a, b) => a.sort.localeCompare(b.sort));
    return rows;
  }

  function renderRoutine() {
    // Navegação de dia
    main.appendChild(el("div", { class: "daynav" },
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Dia anterior", onclick: () => { viewedDay = addDays(viewedDay, -1); render(); } }, "‹"),
      el("button", { class: "daynav__label", onclick: () => { viewedDay = keyOf(new Date()); render(); }, "aria-label": "Ir para hoje" }, headingFor(viewedDay)),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Próximo dia", onclick: () => { viewedDay = addDays(viewedDay, 1); render(); } }, "›")));

    // Relatório do dia
    const rep = state.reports[viewedDay];
    main.appendChild(el("button", { class: "item report-card", style: "display:block;width:100%;text-align:left;cursor:pointer", onclick: () => editReport(viewedDay) },
      el("p", { class: "item__meta", style: "margin:0 0 0.2rem" }, "Relatório do dia"),
      rep && rep.body ? el("p", { class: "item__body" }, rep.body) : el("p", { class: "item__body muted-none" }, "Toque para escrever o relatório do dia"),
      rep && rep.body ? el("p", { class: "item__meta" }, `${sinceText(rep.at)} · ${rep.by || ""}`) : null));

    // Se precisar (SOS) — só faz sentido "agora", então aparece apenas no dia de hoje.
    if (viewedDay === keyOf(new Date()) && prnMeds().length) {
      main.appendChild(el("p", { class: "reviewed", style: "margin-top:1.2rem" }, el("span", {}, "Se precisar (SOS)")));
      prnMeds().forEach((m) => {
        const last = lastPrn(m.id);
        main.appendChild(el("div", { class: "item" },
          el("div", { class: "row" },
            el("div", { class: "row__main" },
              el("p", { class: "item__label" }, `${m.name}${m.dose ? " " + m.dose : ""}`),
              el("p", { class: "item__meta" }, last ? `Última vez ${sinceText(last.at)}${last.by ? " por " + last.by : ""}` : "Ainda não dado")),
            el("button", { class: "btn btn--primary", style: "min-height:2.6rem", onclick: () => registerPrn(m) }, "Registrar"))));
      });
    }

    // Linha do tempo
    main.appendChild(el("p", { class: "reviewed", style: "margin-top:1.2rem" }, el("span", {}, "Linha do tempo do dia")));
    const rows = feedFor(viewedDay);
    if (!rows.length) {
      main.appendChild(el("div", { class: "empty" },
        el("strong", {}, "Nada programado ainda"),
        el("span", {}, "Adicione um medicamento ou uma tarefa no botão “Adicionar”, ou escreva uma anotação.")));
    } else {
      const isToday = viewedDay === keyOf(new Date());
      const now = nowHHMM();
      let dividerPut = false;
      rows.forEach((r) => {
        if (isToday && !dividerPut && r.sort > now) { dividerPut = true; main.appendChild(el("div", { class: "now-divider" }, el("span", {}, "agora"))); }
        main.appendChild(feedRow(r));
      });
      if (isToday && !dividerPut) main.appendChild(el("div", { class: "now-divider" }, el("span", {}, "agora")));
    }

    // Ações
    main.appendChild(el("div", { class: "add-row" },
      el("button", { class: "btn btn--primary btn--block", onclick: openAdd }, "＋ Adicionar")));
    main.appendChild(el("button", { class: "btn btn--ghost btn--block", style: "margin-top:0.6rem", onclick: openPlano }, "Medicamentos e tarefas"));
  }

  function feedRow(r) {
    if (r.kind === "note") {
      return el("div", { class: "item feed feed--note" },
        el("div", { class: "row" },
          el("div", { class: "row__main" },
            el("p", { class: "item__meta", style: "margin:0" }, `${r.time} · Anotação · ${r.note.by || ""}${r.note.editedAt ? " (editada)" : ""}`),
            el("p", { class: "item__body" }, r.note.body)),
          r.note.by === state.me.name ? el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Editar anotação", onclick: () => editNote(r.note) }, "✎") : null));
    }
    if (r.kind === "prn") {
      return el("div", { class: "item feed" },
        el("p", { class: "item__meta", style: "margin:0" }, `${r.time} · SOS`),
        el("p", { class: "item__label" }, `💊 ${r.med ? r.med.name : "Medicamento"}${r.med && r.med.dose ? " " + r.med.dose : ""}`),
        el("div", { style: "display:flex;align-items:center;gap:0.5rem;margin-top:0.2rem" },
          chip("Dado", "ok"), r.ev.note ? el("span", { class: "item__meta" }, "· " + r.ev.note) : null));
    }
    // med / task programado
    const isMed = r.kind === "med";
    const label = isMed ? `💊 ${r.med.name}${r.med.dose ? " " + r.med.dose : ""}` : `✓ ${r.task.title}`;
    const status = outcomeChip(r, isMed);
    const future = isFutureOcc(viewedDay, r.time);
    const interactive = !future || !!r.ev; // futuro sem registro não é registrável
    const inner = el("div", { class: "row" },
      el("div", { class: "row__main" },
        el("p", { class: "item__meta", style: "margin:0" }, r.time + (future ? " · ainda não chegou" : "")),
        el("p", { class: "item__label" }, label),
        (isMed ? r.med.howTo : r.task.howTo) ? el("p", { class: "item__meta" }, isMed ? r.med.howTo : r.task.howTo) : null,
        r.ev && r.ev.note ? el("p", { class: "item__meta" }, "“" + r.ev.note + "”") : null),
      el("div", { style: "flex:none" }, status));
    if (interactive) return el("button", { class: "item feed", style: "display:block;width:100%;text-align:left;cursor:pointer",
      onclick: () => (isMed ? recordDose(r.med, viewedDay, r.time, r.ev) : recordTask(r.task, viewedDay, r.time, r.ev)) }, inner);
    return el("div", { class: "item feed", style: "opacity:0.65" }, inner);
  }

  function outcomeChip(r, isMed) {
    if (r.ev) {
      if (isMed) return r.ev.outcome === "given" ? chip("Dado", "ok") : chip("Não dado", "warn");
      return r.ev.outcome === "done" ? chip("Feita", "ok") : chip("Não feita", "warn");
    }
    const isToday = viewedDay === keyOf(new Date());
    const isPast = viewedDay < keyOf(new Date()) || (isToday && r.time <= nowHHMM());
    return isPast ? chip("Não registrado", "muted") : chip("Programado", "soft");
  }
  function chip(text, kind) { return el("span", { class: "chip chip--" + kind }, text); }

  // ---------- Registrar dose / tarefa ----------
  function recordDose(med, dayKey, time, ev) {
    if (!ev && isFutureOcc(dayKey, time)) { toast("Ainda não chegou a hora desta dose"); return; }
    recordOutcome({ title: `${med.name}${med.dose ? " " + med.dose : ""} · ${time}`, opts: [["given", "Dado"], ["notGiven", "Não dado"]], ev,
      onSave: (outcome, note) => upsertMedEvent(med.id, dayKey, time, outcome, note), onClear: ev ? () => removeMedEvent(ev) : null });
  }
  function recordTask(task, dayKey, time, ev) {
    if (!ev && isFutureOcc(dayKey, time)) { toast("Ainda não chegou a hora desta tarefa"); return; }
    recordOutcome({ title: `${task.title} · ${time}`, opts: [["done", "Feita"], ["notDone", "Não feita"]], ev,
      onSave: (outcome, note) => upsertTaskEvent(task.id, dayKey, time, outcome, note), onClear: ev ? () => removeTaskEvent(ev) : null });
  }

  async function recordOutcome({ title, opts, ev, onSave, onClear }) {
    if (!(await ensureName())) return;
    const seg = segmented(opts, ev ? ev.outcome : null);
    const note = field("Observação (opcional)", "textarea", ev ? ev.note : "", "");
    const err = el("p", { class: "field-error", hidden: true });
    openModal(title, [seg.wrap, note.wrap, err], {
      submitText: "Salvar",
      onSubmit: () => { if (!seg.get()) { err.hidden = false; err.textContent = "Escolha uma opção."; return false; }
        onSave(seg.get(), note.input.value.trim()); save(); render(); toast("✓ Registrado"); return true; },
      onDelete: onClear ? () => { onClear(); save(); render(); toast("Registro apagado"); } : null,
      deleteText: "Apagar registro",
    });
  }
  function upsertMedEvent(medId, dayKey, time, outcome, note) {
    const cur = findMedEv(medId, dayKey, time);
    if (cur) Object.assign(cur, { outcome, note, at: new Date().toISOString(), by: state.me.name });
    else state.medEvents.push({ id: uid(), medId, dateKey: dayKey, time, outcome, note, at: new Date().toISOString(), by: state.me.name });
  }
  function upsertTaskEvent(taskId, dayKey, time, outcome, note) {
    const cur = findTaskEv(taskId, dayKey, time);
    if (cur) Object.assign(cur, { outcome, note, at: new Date().toISOString(), by: state.me.name });
    else state.taskEvents.push({ id: uid(), taskId, dateKey: dayKey, time, outcome, note, at: new Date().toISOString(), by: state.me.name });
  }
  const removeMedEvent = (ev) => (state.medEvents = state.medEvents.filter((e) => e.id !== ev.id));
  const removeTaskEvent = (ev) => (state.taskEvents = state.taskEvents.filter((e) => e.id !== ev.id));

  async function registerPrn(med) {
    if (!(await ensureName())) return;
    const last = lastPrn(med.id);
    let warn = null;
    if (last && med.minIntervalMin) {
      const mins = Math.floor((Date.now() - new Date(last.at).getTime()) / 60000);
      if (mins < med.minIntervalMin)
        warn = el("p", { class: "field-error", hidden: false, style: "color:var(--warn-ink);background:var(--warn-bg);padding:0.6rem;border-radius:10px" },
          `Atenção: faz ${sinceText(last.at)} desde a última dose. O intervalo mínimo registrado é ${Math.round(med.minIntervalMin / 60 * 10) / 10}h. Você ainda pode registrar.`);
    }
    const note = field("Observação (opcional)", "textarea", "", "");
    openModal(`Registrar SOS — ${med.name}`, [
      el("p", { class: "reviewed" }, el("span", {}, last ? `Última vez ${sinceText(last.at)}${last.by ? " por " + last.by : ""}` : "Ainda não foi dado")),
      warn, note.wrap], {
      submitText: "Registrar agora",
      onSubmit: () => { state.medEvents.push({ id: uid(), medId: med.id, dateKey: keyOf(new Date()), time: null, outcome: "given", at: new Date().toISOString(), note: note.input.value.trim(), by: state.me.name });
        save(); render(); toast("✓ SOS registrado"); return true; },
    });
  }

  // ---------- Adicionar (chooser) ----------
  async function openAdd() {
    if (!(await ensureName())) return;
    openModal("Adicionar", [
      el("button", { class: "btn btn--ghost btn--block", style: "margin-bottom:0.6rem", onclick: () => { closeModal(); editNote(); } }, "📝 Anotação"),
      el("button", { class: "btn btn--ghost btn--block", style: "margin-bottom:0.6rem", onclick: () => { closeModal(); editMed(); } }, "💊 Medicamento"),
      el("button", { class: "btn btn--ghost btn--block", onclick: () => { closeModal(); editTask(); } }, "✓ Tarefa de cuidado"),
    ], { hideActions: true });
  }

  // ---------- Anotação ----------
  async function editNote(note) {
    if (!(await ensureName())) return;
    const body = field("Anotação", "textarea", note ? note.body : "", "O que você observou — como um bloco de notas do cuidado.");
    const err = el("p", { class: "field-error", hidden: true });
    openModal(note ? "Editar anotação" : "Nova anotação", [body.wrap, err], {
      submitText: note ? "Salvar" : "Publicar",
      onSubmit: () => { const v = body.input.value.trim(); if (!v) { err.hidden = false; err.textContent = "Escreva algo."; return false; }
        if (note) { note.body = v; note.editedAt = new Date().toISOString(); }
        else state.notes.push({ id: uid(), at: new Date().toISOString(), body: v, by: state.me.name });
        save(); render(); toast("✓ Salvo"); return true; },
      onDelete: note ? () => { state.notes = state.notes.filter((n) => n.id !== note.id); save(); render(); } : null,
    });
  }

  // ---------- Relatório do dia ----------
  async function editReport(dayKey) {
    if (!(await ensureName())) return;
    const cur = state.reports[dayKey];
    const body = field(`Relatório — ${headingFor(dayKey)}`, "textarea", cur ? cur.body : "", "Um resumo do dia, em poucas palavras. Um relatório por dia, que todos podem completar.");
    openModal("Relatório do dia", [body.wrap], {
      submitText: "Salvar",
      onSubmit: () => { const v = body.input.value.trim();
        if (!v) delete state.reports[dayKey];
        else state.reports[dayKey] = { body: v, by: state.me.name, at: new Date().toISOString() };
        save(); render(); toast("✓ Salvo"); return true; },
    });
  }

  // ---------- Medicamentos e tarefas (plano) ----------
  function openPlano() {
    const body = [];
    body.push(el("p", { class: "reviewed" }, el("span", {}, "Medicamentos")));
    if (!state.medications.length) body.push(el("p", { class: "muted-none", style: "margin:0 0 0.6rem" }, "Nenhum ainda."));
    state.medications.forEach((m) => body.push(el("button", { class: "item", style: "display:block;width:100%;text-align:left;cursor:pointer;margin-bottom:0.4rem", onclick: () => { closeModal(); editMed(m); } },
      el("p", { class: "item__label" }, `${m.name}${m.dose ? " " + m.dose : ""}${m.active === false ? " (suspenso)" : ""}`),
      el("p", { class: "item__meta" }, scheduleSummary(m)))));
    body.push(el("button", { class: "btn btn--ghost btn--block", style: "margin:0.2rem 0 1rem", onclick: () => { closeModal(); editMed(); } }, "＋ Medicamento"));
    body.push(el("p", { class: "reviewed" }, el("span", {}, "Tarefas de cuidado")));
    if (!state.tasks.length) body.push(el("p", { class: "muted-none", style: "margin:0 0 0.6rem" }, "Nenhuma ainda."));
    state.tasks.forEach((t) => body.push(el("button", { class: "item", style: "display:block;width:100%;text-align:left;cursor:pointer;margin-bottom:0.4rem", onclick: () => { closeModal(); editTask(t); } },
      el("p", { class: "item__label" }, `${t.title}${t.active === false ? " (suspensa)" : ""}`),
      el("p", { class: "item__meta" }, scheduleSummary(t)))));
    body.push(el("button", { class: "btn btn--ghost btn--block", onclick: () => { closeModal(); editTask(); } }, "＋ Tarefa"));
    openModal("Medicamentos e tarefas", body, { hideActions: true });
  }
  function scheduleSummary(x) {
    if (x.kind === "prn") return `Se precisar (SOS)${x.minIntervalMin ? " · mín. " + (Math.round(x.minIntervalMin / 60 * 10) / 10) + "h" : ""}`;
    const times = (x.times || []).join(", ") || "sem horário";
    const days = (x.weekdays && x.weekdays.length) ? x.weekdays.map((d) => WD[d]).join(", ") : "todos os dias";
    return `${times} · ${days}`;
  }

  // ---------- Editor de agenda (horários fixos ou SOS) ----------
  function scheduleEditor(initial, allowPrn) {
    const st = { kind: initial.kind || "fixed", times: (initial.times || []).slice(), weekdays: (initial.weekdays || []).slice(), minIntervalMin: initial.minIntervalMin || 0 };
    if (!st.times.length) st.times.push("08:00");
    const wrap = el("div", {});
    const fixedBox = el("div", {});
    const prnBox = el("div", { hidden: true });

    // seletor fixo/SOS (só para medicamentos)
    if (allowPrn) {
      const seg = segmented([["fixed", "Horário fixo"], ["prn", "Se precisar (SOS)"]], st.kind);
      seg.onChange((v) => { st.kind = v; fixedBox.hidden = v !== "fixed"; prnBox.hidden = v !== "prn"; });
      wrap.appendChild(seg.wrap);
      fixedBox.hidden = st.kind !== "fixed"; prnBox.hidden = st.kind !== "prn";
    }

    // horários
    const timesWrap = el("div", {});
    function drawTimes() {
      timesWrap.innerHTML = "";
      timesWrap.appendChild(el("label", { style: "font-weight:650;display:block;margin:0.3rem 0" }, "Horários"));
      st.times.forEach((t, i) => {
        const inp = el("input", { type: "time", value: t, "aria-label": `Horário ${i + 1}` });
        inp.addEventListener("change", () => (st.times[i] = inp.value));
        const del = el("button", { class: "icon-btn icon-btn--bordered", type: "button", "aria-label": "Remover horário",
          onclick: () => { st.times.splice(i, 1); if (!st.times.length) st.times.push("08:00"); drawTimes(); } }, "✕");
        timesWrap.appendChild(el("div", { class: "step-editor" }, inp, del));
      });
      timesWrap.appendChild(el("button", { class: "btn btn--ghost", type: "button", onclick: () => { st.times.push("12:00"); drawTimes(); } }, "＋ Horário"));
    }
    drawTimes();
    fixedBox.appendChild(timesWrap);

    // dias da semana
    fixedBox.appendChild(el("label", { style: "font-weight:650;display:block;margin:0.8rem 0 0.3rem" }, "Dias (nenhum marcado = todos os dias)"));
    const chipsRow = el("div", { class: "wd-row" });
    WD.forEach((name, i) => {
      const b = el("button", { type: "button", class: "wd-chip", "aria-pressed": st.weekdays.includes(i) ? "true" : "false",
        onclick: () => { const on = b.getAttribute("aria-pressed") === "true"; b.setAttribute("aria-pressed", on ? "false" : "true");
          if (on) st.weekdays = st.weekdays.filter((d) => d !== i); else st.weekdays.push(i); } }, name);
      chipsRow.appendChild(b);
    });
    fixedBox.appendChild(chipsRow);
    wrap.appendChild(fixedBox);

    // SOS: intervalo
    const iv = field("Intervalo mínimo entre doses (horas, opcional)", "text", st.minIntervalMin ? String(Math.round(st.minIntervalMin / 60 * 10) / 10) : "", "Ex.: 4. É só um aviso — nunca bloqueia.");
    iv.input.setAttribute("inputmode", "decimal");
    prnBox.appendChild(iv.wrap);
    wrap.appendChild(prnBox);

    return { wrap, get() {
      const hours = parseFloat((iv.input.value || "").replace(",", "."));
      return { kind: st.kind, times: st.times.slice(), weekdays: st.weekdays.slice(), minIntervalMin: st.kind === "prn" && hours > 0 ? Math.round(hours * 60) : 0 };
    } };
  }

  // ---------- Medicamento ----------
  async function editMed(med) {
    if (!(await ensureName())) return;
    const isNew = !med;
    const data = med || { id: uid(), name: "", dose: "", howTo: "", kind: "fixed", times: [], weekdays: [], minIntervalMin: 0, active: true };
    const name = field("Nome", "text", data.name, "");
    const dose = field("Dose", "text", data.dose, "ex.: 500 mg, 10 gotas");
    const howTo = field("Como toma (opcional)", "text", data.howTo, "ex.: com comida, amassado no iogurte");
    const sched = scheduleEditor(data, true);
    const err = el("p", { class: "field-error", hidden: true });
    openModal(isNew ? "Novo medicamento" : "Editar medicamento",
      [name.wrap, dose.wrap, howTo.wrap, el("hr", { class: "rule" }), sched.wrap, err,
       !isNew ? el("button", { class: "btn btn--ghost btn--block", type: "button", style: "margin-top:0.8rem",
         onclick: () => { data.active = data.active === false; save(); closeModal(); render(); toast(data.active === false ? "Suspenso" : "Reativado"); } },
         data.active === false ? "Reativar" : "Suspender") : null], {
      submitText: isNew ? "Adicionar" : "Salvar",
      onSubmit: () => {
        if (!name.input.value.trim()) { err.hidden = false; err.textContent = "O nome é obrigatório."; return false; }
        const s = sched.get();
        if (s.kind === "fixed" && !s.times.filter(Boolean).length) { err.hidden = false; err.textContent = "Adicione ao menos um horário."; return false; }
        Object.assign(data, { name: name.input.value.trim(), dose: dose.input.value.trim(), howTo: howTo.input.value.trim(),
          kind: s.kind, times: s.times, weekdays: s.weekdays, minIntervalMin: s.minIntervalMin });
        if (isNew) state.medications.push(data);
        save(); render(); toast("✓ Salvo"); return true;
      },
      onDelete: isNew ? null : () => { state.medications = state.medications.filter((m) => m.id !== data.id); save(); render(); },
      deleteText: "Excluir de vez",
    });
  }

  // ---------- Tarefa ----------
  async function editTask(task) {
    if (!(await ensureName())) return;
    const isNew = !task;
    const data = task || { id: uid(), title: "", howTo: "", times: [], weekdays: [], active: true };
    const title = field("Título", "text", data.title, "ex.: Reposicionar, Higiene bucal");
    const howTo = field("Como fazer (opcional)", "text", data.howTo, "");
    const sched = scheduleEditor(Object.assign({ kind: "fixed" }, data), false);
    const err = el("p", { class: "field-error", hidden: true });
    openModal(isNew ? "Nova tarefa" : "Editar tarefa",
      [title.wrap, howTo.wrap, el("hr", { class: "rule" }), sched.wrap, err,
       !isNew ? el("button", { class: "btn btn--ghost btn--block", type: "button", style: "margin-top:0.8rem",
         onclick: () => { data.active = data.active === false; save(); closeModal(); render(); toast(data.active === false ? "Suspensa" : "Reativada"); } },
         data.active === false ? "Reativar" : "Suspender") : null], {
      submitText: isNew ? "Adicionar" : "Salvar",
      onSubmit: () => {
        if (!title.input.value.trim()) { err.hidden = false; err.textContent = "O título é obrigatório."; return false; }
        const s = sched.get();
        if (!s.times.filter(Boolean).length) { err.hidden = false; err.textContent = "Adicione ao menos um horário."; return false; }
        Object.assign(data, { title: title.input.value.trim(), howTo: howTo.input.value.trim(), times: s.times, weekdays: s.weekdays });
        if (isNew) state.tasks.push(data);
        save(); render(); toast("✓ Salvo"); return true;
      },
      onDelete: isNew ? null : () => { state.tasks = state.tasks.filter((t) => t.id !== data.id); save(); render(); },
      deleteText: "Excluir de vez",
    });
  }

  // ============================================================
  //  EMERGÊNCIA (cartão + contatos)
  // ============================================================
  function renderEmergency() {
    main.appendChild(el("div", { class: "section-head" },
      el("h2", {}, "Cartão de emergência"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Adicionar outro item ao cartão", onclick: () => editCardEntry() }, "＋")));
    main.appendChild(el("p", { class: "reviewed" },
      el("span", {}, state.card.reviewedAt ? `Revisado ${relTime(state.card.reviewedAt)}${state.card.reviewedBy ? " por " + state.card.reviewedBy : ""}` : "Ainda não revisado"),
      el("button", { class: "btn btn--ghost", style: "min-height:2.4rem;padding:0.3rem 0.7rem", onclick: markReviewed }, "Marcar como revisado")));
    CARD_FIELDS.forEach((f) => {
      const val = state.card.fields[f.key];
      main.appendChild(el("div", { class: "item" + (f.emphasis ? " allergy-box" : ""), role: "button", tabindex: "0", style: "cursor:pointer",
        "aria-label": `${f.label}: ${val || "não registrado"}. Toque para editar.`, onclick: () => editCardField(f),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); editCardField(f); } } },
        el("div", { class: "row" },
          el("div", { class: "row__main" },
            f.emphasis ? el("span", { class: "badge-critical" }, f.label) : el("p", { class: "item__meta", style: "margin:0 0 0.2rem" }, f.label),
            val ? el("p", { class: "item__body" }, val) : el("p", { class: "item__body muted-none" }, f.empty)),
          el("span", { class: "row__controls", "aria-hidden": "true" }, el("span", { class: "icon-btn icon-btn--bordered" }, "✎")))));
    });
    const entries = sortedEntries();
    if (entries.length) {
      main.appendChild(el("p", { class: "reviewed", style: "margin-top:1rem" }, el("span", {}, "Outros itens")));
      entries.forEach((entry, idx) => main.appendChild(el("div", { class: "item " + (entry.critical ? "item--critical" : "") },
        el("div", { class: "row" },
          el("div", { class: "row__main" },
            entry.critical ? el("span", { class: "badge-critical" }, "Crítico") : null,
            el("p", { class: "item__label" }, entry.label || "(sem título)"),
            entry.body ? el("p", { class: "item__body" }, entry.body) : el("p", { class: "item__body muted-none" }, "Sem detalhes")),
          el("div", { class: "row__controls" }, moveBtn("up", idx, entries, moveEntry), moveBtn("down", idx, entries, moveEntry),
            el("button", { class: "icon-btn icon-btn--bordered", "aria-label": `Editar ${entry.label || "item"}`, onclick: () => editCardEntry(entry) }, "✎"))))));
    }
    main.appendChild(el("button", { class: "btn btn--ghost btn--block", style: "margin-top:0.6rem", onclick: () => editCardEntry() }, "＋ Adicionar outro item"));

    // Medicamentos em uso — referência para uma emergência (só leitura; cadastro é na Rotina).
    main.appendChild(el("div", { class: "section-head", style: "margin-top:2rem" }, el("h2", {}, "Medicamentos em uso")));
    const meds = activeMeds();
    if (!meds.length) {
      main.appendChild(el("div", { class: "empty" }, el("strong", {}, "Nenhum medicamento cadastrado"), el("span", {}, "Adicione na aba Rotina — eles aparecem aqui automaticamente.")));
    } else {
      meds.forEach((m) => main.appendChild(el("div", { class: "item" },
        el("p", { class: "item__label" }, `${m.name}${m.dose ? " " + m.dose : ""}`),
        el("p", { class: "item__meta" }, scheduleSummary(m)),
        m.howTo ? el("p", { class: "item__meta" }, m.howTo) : null)));
    }

    main.appendChild(el("div", { class: "section-head", style: "margin-top:2rem" },
      el("h2", {}, "Contatos de emergência"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Adicionar contato", onclick: () => editContact() }, "＋")));
    if (!state.contacts.length) {
      main.appendChild(el("div", { class: "empty" }, el("strong", {}, "Nenhum contato ainda"), el("span", {}, "Adicione quem ligar primeiro. Você escolhe a ordem — o app nunca reordena.")));
    } else {
      state.contacts.forEach((c, idx) => {
        const actions = el("div", { style: "display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.6rem" },
          c.phone ? el("a", { class: "btn btn--call", href: `tel:${telHref(c.phone)}`, "aria-label": `Ligar para ${c.name}` }, "☎ Ligar") : null,
          c.phone && c.whatsapp ? el("a", { class: "btn btn--wa", href: `https://wa.me/${waNumber(c.phone)}`, target: "_blank", rel: "noopener", "aria-label": `WhatsApp de ${c.name}` }, "WhatsApp") : null);
        main.appendChild(el("div", { class: "item" },
          el("div", { class: "row" },
            el("div", { class: "row__main" }, el("p", { class: "item__label" }, c.name || "(sem nome)"),
              el("p", { class: "item__body" }, c.role || el("span", { class: "muted-none" }, "Sem função")),
              el("p", { class: "item__meta" }, c.phone || "Sem número")),
            el("div", { class: "row__controls" }, moveBtn("up", idx, state.contacts, moveContact), moveBtn("down", idx, state.contacts, moveContact),
              el("button", { class: "icon-btn icon-btn--bordered", "aria-label": `Editar ${c.name}`, onclick: () => editContact(c) }, "✎"))),
          actions));
      });
    }
  }
  function markReviewed() { ensureName().then((ok) => { if (!ok) return; state.card.reviewedAt = new Date().toISOString(); state.card.reviewedBy = state.me.name; save(); render(); toast("✓ Marcado como revisado hoje"); }); }
  function touchReview() { state.card.reviewedAt = new Date().toISOString(); state.card.reviewedBy = state.me.name; }
  async function editCardField(f) {
    if (!(await ensureName())) return;
    const input = field(f.label, "textarea", state.card.fields[f.key], f.hint);
    openModal(f.label, [input.wrap], { submitText: "Salvar", onSubmit: () => { state.card.fields[f.key] = input.input.value.trim(); touchReview(); save(); render(); toast("✓ Salvo"); return true; } });
  }
  const sortedEntries = () => state.card.entries.map((e, i) => ({ e, i })).sort((a, b) => (b.e.critical - a.e.critical) || ((a.e.order ?? 0) - (b.e.order ?? 0)) || (a.i - b.i)).map((x) => x.e);
  function moveEntry(entry, dir) {
    const group = sortedEntries().filter((e) => !!e.critical === !!entry.critical);
    const pos = group.indexOf(entry), swap = group[pos + (dir === "up" ? -1 : 1)];
    if (!swap) return; group.forEach((e, i) => (e.order = i)); const a = entry.order, b = swap.order; entry.order = b; swap.order = a; save(); render();
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
      onSubmit: () => { if (!label.input.value.trim() && !body.input.value.trim()) { err.hidden = false; err.textContent = "Escreva um título ou algum detalhe."; return false; }
        data.label = label.input.value.trim(); data.body = body.input.value.trim(); data.critical = crit.input.checked;
        if (isNew) state.card.entries.push(data); touchReview(); save(); render(); toast("✓ Salvo"); return true; },
      onDelete: isNew ? null : () => { state.card.entries = state.card.entries.filter((e) => e.id !== data.id); touchReview(); save(); render(); },
    });
  }
  function moveContact(c, dir) { const i = state.contacts.indexOf(c), j = i + (dir === "up" ? -1 : 1); if (j < 0 || j >= state.contacts.length) return; [state.contacts[i], state.contacts[j]] = [state.contacts[j], state.contacts[i]]; save(); render(); }
  async function editContact(c) {
    if (!(await ensureName())) return;
    const isNew = !c; const data = c || { id: uid(), name: "", role: "", phone: "", whatsapp: false };
    const name = field("Nome", "text", data.name, "");
    const role = field("Função ou relação", "text", data.role, "ex.: Hospice, Filha, Clínico");
    const phone = field("Telefone", "tel", data.phone, "Com DDD. Para WhatsApp, inclua o país (ex.: +55). Confira o número após preencher.");
    // autocomplete="tel" faz o iOS usar o Preenchimento estruturado (que insere o
    // número inteiro) em vez do heurístico, que come o primeiro dígito.
    phone.input.setAttribute("autocomplete", "tel");
    phone.input.setAttribute("name", "tel");
    const wa = checkField("Também tem WhatsApp neste número", data.whatsapp);
    const err = el("p", { class: "field-error", hidden: true });
    openModal(isNew ? "Adicionar contato" : "Editar contato", [name.wrap, role.wrap, phone.wrap, wa.wrap, err], {
      submitText: isNew ? "Adicionar" : "Salvar",
      onSubmit: () => { if (!name.input.value.trim()) { err.hidden = false; err.textContent = "O nome é obrigatório."; return false; }
        Object.assign(data, { name: name.input.value.trim(), role: role.input.value.trim(), phone: phone.input.value.trim(), whatsapp: wa.input.checked });
        if (isNew) state.contacts.push(data); save(); render(); toast("✓ Salvo"); return true; },
      onDelete: isNew ? null : () => { state.contacts = state.contacts.filter((x) => x.id !== data.id); save(); render(); },
    });
  }
  const telHref = (p) => p.replace(/[^\d+]/g, "");
  const waNumber = (p) => p.replace(/[^\d]/g, "");

  // ============================================================
  //  PERFIL
  // ============================================================
  function renderProfile() {
    main.appendChild(el("div", { class: "section-head" }, el("h2", {}, "Perfil"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Editar perfil", onclick: () => editProfile() }, "✎")));
    const p = state.profile;
    f2("Nome", p.name); f2("Data de nascimento", p.dob ? fmtDate(p.dob) : ""); f2("Condições", p.conditions); f2("Notas de cuidado", p.careNotes);
    main.appendChild(el("p", { class: "reviewed", style: "margin-top:0.8rem" }, el("span", {}, "As alergias ficam no Cartão de emergência, não aqui.")));
    if (p.updatedAt) main.appendChild(el("p", { class: "reviewed" }, el("span", {}, `Última edição ${stamp(p.updatedAt)}${p.updatedBy ? " por " + p.updatedBy : ""}`)));
    function f2(labelText, value) { main.appendChild(el("div", { class: "item" }, el("p", { class: "item__meta", style: "margin:0 0 0.2rem" }, labelText),
      value ? el("p", { class: "item__body" }, value) : el("p", { class: "item__body muted-none" }, "Não registrado"))); }
  }
  async function editProfile() {
    if (!(await ensureName())) return;
    const p = state.profile;
    const name = field("Nome", "text", p.name, ""); const dob = field("Data de nascimento", "date", p.dob, "");
    const conditions = field("Condições", "textarea", p.conditions, ""); const notes = field("Notas de cuidado", "textarea", p.careNotes, "");
    openModal("Editar perfil", [name.wrap, dob.wrap, conditions.wrap, notes.wrap], { submitText: "Salvar",
      onSubmit: () => { Object.assign(p, { name: name.input.value.trim(), dob: dob.input.value, conditions: conditions.input.value.trim(),
        careNotes: notes.input.value.trim(), updatedAt: new Date().toISOString(), updatedBy: state.me.name }); save(); render(); toast("✓ Salvo"); return true; } });
  }

  // ============================================================
  //  Peças reutilizáveis
  // ============================================================
  function moveBtn(dir, idx, arr, fn) {
    const disabled = dir === "up" ? idx === 0 : idx === arr.length - 1; const item = arr[idx];
    return el("button", { class: "icon-btn icon-btn--bordered", "aria-label": dir === "up" ? "Mover para cima" : "Mover para baixo", disabled: disabled || undefined, onclick: () => fn(item, dir) }, dir === "up" ? "↑" : "↓");
  }
  function field(labelText, type, value, hint) {
    const id = uid();
    const input = type === "textarea" ? el("textarea", { id, rows: 3 }) : el("input", { id, type });
    input.value = value || "";
    return { wrap: el("div", { class: "field" }, el("label", { for: id }, labelText), input, hint ? el("p", { class: "hint" }, hint) : null), input };
  }
  function checkField(labelText, checked) {
    const id = uid(); const input = el("input", { type: "checkbox", id }); input.checked = !!checked;
    return { wrap: el("div", { class: "field field--check" }, input, el("label", { for: id }, labelText)), input };
  }
  function segmented(opts, initial) {
    let value = initial || null; let onChangeCb = null;
    const wrap = el("div", { class: "seg" });
    const btns = opts.map(([val, label]) => {
      const b = el("button", { type: "button", class: "seg__btn", "aria-pressed": value === val ? "true" : "false",
        onclick: () => { value = val; btns.forEach((x) => x.setAttribute("aria-pressed", "false")); b.setAttribute("aria-pressed", "true"); if (onChangeCb) onChangeCb(val); } }, label);
      return b;
    });
    btns.forEach((b) => wrap.appendChild(b));
    return { wrap, get: () => value, onChange: (cb) => (onChangeCb = cb) };
  }

  // ---------- Modal ----------
  let lastFocus = null;
  function openModal(titleText, bodyNodes, { submitText = "Salvar", onSubmit, onDelete, deleteText = "Excluir", hideActions = false } = {}) {
    lastFocus = document.activeElement; modalRoot.innerHTML = "";
    const dialog = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": titleText });
    dialog.appendChild(el("h2", {}, titleText));
    bodyNodes.forEach((n) => n && dialog.appendChild(n));
    if (!hideActions) {
      dialog.appendChild(el("div", { class: "modal__actions" },
        el("button", { class: "btn btn--ghost", type: "button", onclick: closeModal }, "Cancelar"),
        el("button", { class: "btn btn--primary", type: "button", onclick: () => { if (onSubmit() !== false) closeModal(); } }, submitText)));
      if (onDelete) dialog.appendChild(el("button", { class: "btn btn--danger btn--block", type: "button", style: "margin-top:0.6rem",
        onclick: () => { if (confirm("Tem certeza? Não dá para desfazer.")) { onDelete(); closeModal(); } } }, deleteText));
    } else {
      dialog.appendChild(el("button", { class: "btn btn--ghost btn--block", type: "button", style: "margin-top:0.4rem", onclick: closeModal }, "Fechar"));
    }
    modalRoot.appendChild(dialog); modalRoot.hidden = false;
    modalRoot.addEventListener("mousedown", backdropClose); document.addEventListener("keydown", escClose);
    const first = dialog.querySelector("input,textarea,select,button"); if (first) first.focus();
  }
  function closeModal() { modalRoot.hidden = true; modalRoot.innerHTML = ""; modalRoot.removeEventListener("mousedown", backdropClose); document.removeEventListener("keydown", escClose); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  const backdropClose = (e) => { if (e.target === modalRoot) closeModal(); };
  const escClose = (e) => { if (e.key === "Escape") closeModal(); };

  function nameDialog() {
    return new Promise((resolve) => {
      const f = field("Seu nome", "text", state.me.name, "É assim que suas anotações são assinadas, para os outros saberem quem registrou.");
      let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
      lastFocus = document.activeElement; modalRoot.innerHTML = "";
      const dialog = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Seu nome" });
      dialog.appendChild(el("h2", {}, "Qual é o seu nome?")); dialog.appendChild(f.wrap);
      const err = el("p", { class: "field-error", hidden: true }, "Digite um nome."); dialog.appendChild(err);
      dialog.appendChild(el("div", { class: "modal__actions" }, el("button", { class: "btn btn--primary btn--block", type: "button", onclick: () => {
        if (!f.input.value.trim()) { err.hidden = false; return; }
        modalRoot.hidden = true; modalRoot.innerHTML = ""; if (lastFocus && lastFocus.focus) lastFocus.focus(); finish(f.input.value.trim());
      } }, "Continuar")));
      modalRoot.appendChild(dialog); modalRoot.hidden = false; f.input.focus();
    });
  }

  function openMenu() {
    const nameField = field("Seu nome", "text", state.me.name, "Mudar aqui não renomeia registros antigos — eles mantêm o nome de quando foram feitos.");
    openModal("Configurações", [nameField.wrap, el("hr", { class: "rule" }),
      el("p", { class: "hint" }, "Esta versão guarda tudo só neste aparelho. Nada é enviado a lugar nenhum."),
      el("button", { class: "btn btn--danger btn--block", type: "button", style: "margin-top:0.5rem",
        onclick: () => { if (confirm("Sair e apagar TODOS os dados do Care Hub DESTE aparelho? Não dá para desfazer.")) { localStorage.removeItem(STORAGE_KEY); state = blank(); closeModal(); renderHeader(); setView("routine"); } } },
        "Sair e apagar deste aparelho")],
      { submitText: "Salvar nome", onSubmit: () => { if (nameField.input.value.trim()) { state.me.name = nameField.input.value.trim(); save(); renderHeader(); } return true; } });
  }

  function renderHeader() { $("#header-sub").textContent = state.me.name ? `Você: ${state.me.name}` : "Rotina, emergência e cuidados"; }
  function updateNet() { const b = $("#net-banner"); if (!navigator.onLine) { b.hidden = false; b.textContent = "Sem internet — mostrando sua cópia salva neste aparelho."; } else b.hidden = true; }

  // ============================================================
  //  Início
  // ============================================================
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
  $("#menu-btn").addEventListener("click", openMenu);
  window.addEventListener("online", updateNet); window.addEventListener("offline", updateNet);
  renderHeader(); updateNet(); setView("routine");
  if (!state.seenWelcome) { state.seenWelcome = true; save(); ensureName(); }
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
