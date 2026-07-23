/* Care Hub — R1 emergency surface.
 *
 * SCOPE: Release 1, build-order stage 1 (emergency). Implements R1-02 identity,
 * R1-03 emergency card, R1-04 contacts, R1-05 checklists, R1-06 offline,
 * R1-07 profile, plus R1-17 install/accessibility and the NFR-05 medical boundary.
 *
 * STORAGE: this build keeps everything ON THIS DEVICE (localStorage). Nothing is
 * sent anywhere. The synced backend and secret-link access (R1-01/D-2) are the
 * next, separately-confirmed step; this file is the frontend that will talk to it.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "carehub.r1.v1";
  const uid = () => "id-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  // ---------- State ----------
  const blank = () => ({
    me: { name: "" },
    profile: { name: "", dob: "", allergies: "", conditions: "", careNotes: "", updatedAt: "", updatedBy: "" },
    card: { entries: [], reviewedAt: "", reviewedBy: "" },
    contacts: [],
    checklists: [],
    seenWelcome: false,
  });

  let state = load();
  let currentView = "card";

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return blank();
      return Object.assign(blank(), JSON.parse(raw));
    } catch {
      return blank();
    }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      alert("Could not save on this device — storage may be full or blocked.");
    }
  }

  // ---------- Small DOM helpers ----------
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
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };
  function relTime(iso) {
    if (!iso) return "never";
    const then = new Date(iso).getTime();
    const days = Math.floor((Date.now() - then) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    if (days < 60) return "over a month ago";
    return `over ${Math.floor(days / 30)} months ago`;
  }
  const stamp = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  // ---------- Identity (R1-02) ----------
  // Recording anything requires a declared name. Returns true if we have one.
  async function ensureName() {
    if (state.me.name) return true;
    const name = await nameDialog();
    if (name) {
      state.me.name = name.trim();
      save();
      renderHeader();
      return true;
    }
    return false;
  }
  const attribution = () => ({ by: state.me.name || "Unknown", at: new Date().toISOString() });

  // ============================================================
  //  VIEWS
  // ============================================================
  const views = { card: renderCard, contacts: renderContacts, checklists: renderChecklists, profile: renderProfile };

  function setView(name) {
    currentView = name;
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t.dataset.view === name;
      t.setAttribute("aria-current", on ? "page" : "false");
    });
    render();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  function render() {
    main.innerHTML = "";
    (views[currentView] || renderCard)();
    main.appendChild(disclaimer());
  }

  function disclaimer() {
    return el("p", { class: "disclaimer" },
      "Care Hub is a tool for organising your family's own information. It is not a medical device and not a substitute for professional medical advice. It shows only what your family has entered.");
  }

  function reviewedLine(reviewedAt, reviewedBy, onReview) {
    return el("p", { class: "reviewed" },
      el("span", {}, reviewedAt
        ? `Last reviewed ${relTime(reviewedAt)}${reviewedBy ? " by " + reviewedBy : ""}`
        : "Not reviewed yet"),
      el("button", { class: "btn btn--ghost", style: "min-height:2.4rem;padding:0.3rem 0.7rem", onclick: onReview }, "Mark reviewed"));
  }

  // ---------- Emergency card (R1-03) ----------
  function renderCard() {
    main.appendChild(el("div", { class: "section-head" },
      el("h2", {}, "Emergency card"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Add an entry to the emergency card", onclick: () => editCardEntry() }, "＋")));

    main.appendChild(reviewedLine(state.card.reviewedAt, state.card.reviewedBy, async () => {
      if (!(await ensureName())) return;
      state.card.reviewedAt = new Date().toISOString();
      state.card.reviewedBy = state.me.name;
      save(); render();
    }));

    const entries = sortedCard();
    if (!entries.length) {
      main.appendChild(el("div", { class: "empty" },
        el("strong", {}, "No emergency information added yet"),
        el("span", {}, "Add the facts someone would need in a crisis — a resuscitation wish, a hospice number, an allergy. You decide what belongs here.")));
      return;
    }

    entries.forEach((entry, idx) => {
      const controls = el("div", { class: "row__controls" },
        moveBtn("up", idx, entries, moveCardEntry),
        moveBtn("down", idx, entries, moveCardEntry),
        el("button", { class: "icon-btn icon-btn--bordered", "aria-label": `Edit ${entry.label || "entry"}`, onclick: () => editCardEntry(entry) }, "✎"));
      const body = el("div", { class: "row__main" },
        entry.critical ? el("span", { class: "badge-critical" }, "Critical") : null,
        el("p", { class: "item__label" }, entry.label || "(no label)"),
        entry.body ? el("p", { class: "item__body" }, entry.body) : el("p", { class: "item__body muted-none" }, "No details"));
      main.appendChild(el("div", { class: "item " + (entry.critical ? "item--critical" : "") },
        el("div", { class: "row" }, body, controls)));
    });
  }
  const sortedCard = () =>
    state.card.entries.map((e, i) => ({ e, i }))
      .sort((a, b) => (b.e.critical - a.e.critical) || (a.e.order - b.e.order) || (a.i - b.i))
      .map((x) => x.e);

  function moveCardEntry(entry, dir) {
    // Reorder only within the same critical/non-critical group (critical always sits on top).
    const group = sortedCard().filter((e) => !!e.critical === !!entry.critical);
    const pos = group.indexOf(entry);
    const swap = group[pos + (dir === "up" ? -1 : 1)];
    if (!swap) return;
    const a = entry.order ?? 0, b = swap.order ?? 0;
    entry.order = b; swap.order = a;
    // normalise if equal
    if (a === b) group.forEach((e, i) => (e.order = i));
    save(); render();
  }

  async function editCardEntry(entry) {
    if (!(await ensureName())) return;
    const isNew = !entry;
    const data = entry || { id: uid(), label: "", body: "", critical: false, order: state.card.entries.length };
    const label = field("Label", "text", data.label, "e.g. Resuscitation wishes, Blood type, Hospice line");
    const body = field("Details", "textarea", data.body, "");
    const crit = checkField("Mark as critical (shown at the top, with a warning badge)", data.critical);
    const errBox = el("p", { class: "field-error", hidden: true });

    openModal(isNew ? "Add emergency entry" : "Edit entry", [label.wrap, body.wrap, crit.wrap, errBox], {
      submitText: isNew ? "Add" : "Save",
      onSubmit: () => {
        if (!label.input.value.trim() && !body.input.value.trim()) {
          errBox.hidden = false; errBox.textContent = "Enter a label or some details."; return false;
        }
        data.label = label.input.value.trim();
        data.body = body.input.value.trim();
        data.critical = crit.input.checked;
        if (isNew) state.card.entries.push(data);
        touchCardReview();
        save(); render(); return true;
      },
      onDelete: isNew ? null : () => {
        state.card.entries = state.card.entries.filter((e) => e.id !== data.id);
        touchCardReview(); save(); render();
      },
    });
  }
  function touchCardReview() {
    state.card.reviewedAt = new Date().toISOString();
    state.card.reviewedBy = state.me.name;
  }

  // ---------- Emergency contacts (R1-04) ----------
  function renderContacts() {
    main.appendChild(el("div", { class: "section-head" },
      el("h2", {}, "Emergency contacts"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Add a contact", onclick: () => editContact() }, "＋")));

    if (!state.contacts.length) {
      main.appendChild(el("div", { class: "empty" },
        el("strong", {}, "No contacts added yet"),
        el("span", {}, "Add the people to reach first. You choose the order — the app never ranks them.")));
      return;
    }

    state.contacts.forEach((c, idx) => {
      const actions = el("div", { style: "display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.6rem" },
        c.phone ? el("a", { class: "btn btn--call", href: `tel:${telHref(c.phone)}`, "aria-label": `Call ${c.name}` }, "☎ Call") : null,
        c.phone && c.whatsapp ? el("a", { class: "btn btn--wa", href: `https://wa.me/${waNumber(c.phone)}`, target: "_blank", rel: "noopener", "aria-label": `WhatsApp ${c.name}` }, "WhatsApp") : null);
      const controls = el("div", { class: "row__controls" },
        moveBtn("up", idx, state.contacts, moveContact),
        moveBtn("down", idx, state.contacts, moveContact),
        el("button", { class: "icon-btn icon-btn--bordered", "aria-label": `Edit ${c.name}`, onclick: () => editContact(c) }, "✎"));
      main.appendChild(el("div", { class: "item" },
        el("div", { class: "row" },
          el("div", { class: "row__main" },
            el("p", { class: "item__label" }, c.name || "(no name)"),
            el("p", { class: "item__body" }, c.role || el("span", { class: "muted-none" }, "No role")),
            el("p", { class: "item__meta" }, c.phone || "No number recorded")),
          controls),
        actions));
    });
  }
  function moveContact(c, dir) {
    const i = state.contacts.indexOf(c);
    const j = i + (dir === "up" ? -1 : 1);
    if (j < 0 || j >= state.contacts.length) return;
    [state.contacts[i], state.contacts[j]] = [state.contacts[j], state.contacts[i]];
    save(); render();
  }
  async function editContact(c) {
    if (!(await ensureName())) return;
    const isNew = !c;
    const data = c || { id: uid(), name: "", role: "", phone: "", whatsapp: false };
    const name = field("Name", "text", data.name, "");
    const role = field("Role or relationship", "text", data.role, "e.g. Hospice line, Daughter, GP");
    const phone = field("Phone number", "tel", data.phone, "");
    const wa = checkField("Also reachable on WhatsApp", data.whatsapp);
    const err = el("p", { class: "field-error", hidden: true });
    openModal(isNew ? "Add contact" : "Edit contact", [name.wrap, role.wrap, phone.wrap, wa.wrap, err], {
      submitText: isNew ? "Add" : "Save",
      onSubmit: () => {
        if (!name.input.value.trim()) { err.hidden = false; err.textContent = "A name is required."; return false; }
        Object.assign(data, {
          name: name.input.value.trim(), role: role.input.value.trim(),
          phone: phone.input.value.trim(), whatsapp: wa.input.checked,
        });
        if (isNew) state.contacts.push(data);
        save(); render(); return true;
      },
      onDelete: isNew ? null : () => { state.contacts = state.contacts.filter((x) => x.id !== data.id); save(); render(); },
    });
  }
  const telHref = (p) => p.replace(/[^\d+]/g, "");
  const waNumber = (p) => p.replace(/[^\d]/g, "");

  // ---------- Emergency checklists (R1-05) ----------
  let openChecklistId = null;
  let checkedSteps = new Set(); // transient — reset every fresh open (R1-05)

  function renderChecklists() {
    if (openChecklistId) return renderChecklistDetail();

    main.appendChild(el("div", { class: "section-head" },
      el("h2", {}, "Emergency checklists"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Add a checklist", onclick: () => editChecklist() }, "＋")));

    if (!state.checklists.length) {
      main.appendChild(el("div", { class: "empty" },
        el("strong", {}, "No checklists yet"),
        el("span", {}, "Write the steps for a situation you want to be ready for — a fall, choking, a bad reaction. The app never writes these for you.")));
      return;
    }
    state.checklists.forEach((cl) => {
      main.appendChild(el("button", { class: "item", style: "display:block;width:100%;text-align:left;cursor:pointer",
        onclick: () => openChecklist(cl.id) },
        el("p", { class: "item__label" }, cl.title || "(untitled)"),
        el("p", { class: "item__meta" }, `${cl.steps.length} step${cl.steps.length === 1 ? "" : "s"} · reviewed ${relTime(cl.reviewedAt)}`)));
    });
  }
  function openChecklist(id) {
    openChecklistId = id;
    checkedSteps = new Set(); // fresh open → nothing ticked
    render();
  }
  function renderChecklistDetail() {
    const cl = state.checklists.find((c) => c.id === openChecklistId);
    if (!cl) { openChecklistId = null; return renderChecklists(); }

    main.appendChild(el("div", { class: "section-head" },
      el("button", { class: "btn btn--ghost", style: "min-height:2.6rem", onclick: () => { openChecklistId = null; render(); } }, "← Back"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Edit this checklist", onclick: () => editChecklist(cl) }, "✎")));
    main.appendChild(el("h2", {}, cl.title || "(untitled)"));
    if (cl.source) main.appendChild(el("p", { class: "reviewed" }, el("span", {}, "Source: " + cl.source)));

    cl.steps.forEach((s, i) => {
      const cb = el("input", { type: "checkbox", id: "st-" + s.id, "aria-label": `Step ${i + 1}` });
      cb.checked = checkedSteps.has(s.id);
      cb.addEventListener("change", () => {
        cb.checked ? checkedSteps.add(s.id) : checkedSteps.delete(s.id);
        txt.classList.toggle("checked", cb.checked);
      });
      const contact = s.contactId && state.contacts.find((c) => c.id === s.contactId);
      const txt = el("label", { class: "step__text" + (cb.checked ? " checked" : ""), for: "st-" + s.id }, s.text || "");
      main.appendChild(el("div", { class: "step" },
        cb, el("span", { class: "step__num" }, (i + 1) + "."),
        el("div", { style: "flex:1" }, txt,
          contact && contact.phone ? el("a", { class: "btn btn--call", style: "margin-top:0.5rem", href: `tel:${telHref(contact.phone)}` }, `☎ Call ${contact.name}`) : null)));
    });
    main.appendChild(el("p", { class: "reviewed", style: "margin-top:1rem" }, el("span", {}, "Ticks are a working aid — they clear when you reopen this checklist.")));
  }
  async function editChecklist(cl) {
    if (!(await ensureName())) return;
    const isNew = !cl;
    const data = cl ? JSON.parse(JSON.stringify(cl)) : { id: uid(), title: "", source: "", steps: [], reviewedAt: "", reviewedBy: "" };
    if (!data.steps.length) data.steps.push({ id: uid(), text: "", contactId: "" });

    const title = field("Title", "text", data.title, "e.g. If she falls");
    const source = field("Where these steps came from (optional)", "text", data.source, "e.g. Neurologist, Dr. Alves");
    const stepsWrap = el("div", {});
    const err = el("p", { class: "field-error", hidden: true });

    const contactOptions = () => [el("option", { value: "" }, "— no linked contact —"),
      ...state.contacts.map((c) => el("option", { value: c.id }, c.name))];

    function drawSteps() {
      stepsWrap.innerHTML = "";
      stepsWrap.appendChild(el("label", { style: "font-weight:650;display:block;margin-bottom:0.4rem" }, "Steps, in order"));
      data.steps.forEach((s, i) => {
        const input = el("input", { type: "text", value: s.text, "aria-label": `Step ${i + 1}`, placeholder: `Step ${i + 1}` });
        input.addEventListener("input", () => (s.text = input.value));
        const sel = el("select", { "aria-label": `Contact for step ${i + 1}`, style: "min-height:2.6rem;max-width:9rem" }, ...contactOptions());
        sel.value = s.contactId || "";
        sel.addEventListener("change", () => (s.contactId = sel.value));
        const del = el("button", { class: "icon-btn icon-btn--bordered", "aria-label": `Remove step ${i + 1}`,
          onclick: () => { data.steps.splice(i, 1); if (!data.steps.length) data.steps.push({ id: uid(), text: "", contactId: "" }); drawSteps(); } }, "✕");
        stepsWrap.appendChild(el("div", { class: "step-editor" }, el("span", { class: "step__num" }, (i + 1) + "."), input));
        stepsWrap.appendChild(el("div", { style: "display:flex;gap:0.5rem;margin:-0.2rem 0 0.7rem 1.6rem" },
          state.contacts.length ? sel : null, del));
      });
      stepsWrap.appendChild(el("button", { class: "btn btn--ghost", type: "button",
        onclick: () => { data.steps.push({ id: uid(), text: "", contactId: "" }); drawSteps(); } }, "＋ Add step"));
    }
    drawSteps();

    openModal(isNew ? "New checklist" : "Edit checklist", [title.wrap, source.wrap, stepsWrap, err], {
      submitText: isNew ? "Create" : "Save",
      onSubmit: () => {
        if (!title.input.value.trim()) { err.hidden = false; err.textContent = "A title is required."; return false; }
        data.title = title.input.value.trim();
        data.source = source.input.value.trim();
        data.steps = data.steps.filter((s) => s.text.trim());
        if (!data.steps.length) { err.hidden = false; err.textContent = "Add at least one step."; return false; }
        data.reviewedAt = new Date().toISOString();
        data.reviewedBy = state.me.name;
        const idx = state.checklists.findIndex((c) => c.id === data.id);
        if (idx >= 0) state.checklists[idx] = data; else state.checklists.push(data);
        save(); render(); return true;
      },
      onDelete: isNew ? null : () => {
        state.checklists = state.checklists.filter((c) => c.id !== data.id);
        openChecklistId = null; save(); render();
      },
    });
  }

  // ---------- Profile (R1-07) ----------
  function renderProfile() {
    main.appendChild(el("div", { class: "section-head" },
      el("h2", {}, "Profile"),
      el("button", { class: "icon-btn icon-btn--bordered", "aria-label": "Edit profile", onclick: () => editProfile() }, "✎")));

    const p = state.profile;
    // Allergies first and visually distinct — the field most dangerous to miss.
    main.appendChild(el("div", { class: "allergy-box" },
      el("span", { class: "badge-critical" }, "Allergies"),
      p.allergies ? el("p", { class: "item__body" }, p.allergies)
        : el("p", { class: "item__body muted-none" }, "Not recorded — this does not mean “none”.")));

    field2("Name", p.name);
    field2("Date of birth", p.dob ? fmtDate(p.dob) : "");
    field2("Conditions", p.conditions);
    field2("Care notes", p.careNotes);

    if (p.updatedAt) main.appendChild(el("p", { class: "reviewed", style: "margin-top:0.8rem" },
      el("span", {}, `Last edited ${stamp(p.updatedAt)}${p.updatedBy ? " by " + p.updatedBy : ""}`)));

    function field2(labelText, value) {
      main.appendChild(el("div", { class: "item" },
        el("p", { class: "item__meta", style: "margin:0 0 0.2rem" }, labelText),
        value ? el("p", { class: "item__body" }, value) : el("p", { class: "item__body muted-none" }, "Not recorded")));
    }
  }
  async function editProfile() {
    if (!(await ensureName())) return;
    const p = state.profile;
    const name = field("Name", "text", p.name, "");
    const dob = field("Date of birth", "date", p.dob, "");
    const allergies = field("Allergies", "textarea", p.allergies, "Leave blank only if genuinely unknown — an empty field is shown as “not recorded”, never as “none”.");
    const conditions = field("Conditions", "textarea", p.conditions, "");
    const notes = field("Care notes", "textarea", p.careNotes, "");
    openModal("Edit profile", [name.wrap, dob.wrap, allergies.wrap, conditions.wrap, notes.wrap], {
      submitText: "Save",
      onSubmit: () => {
        Object.assign(p, {
          name: name.input.value.trim(), dob: dob.input.value,
          allergies: allergies.input.value.trim(), conditions: conditions.input.value.trim(),
          careNotes: notes.input.value.trim(), updatedAt: new Date().toISOString(), updatedBy: state.me.name,
        });
        save(); render(); return true;
      },
    });
  }

  // ============================================================
  //  Reusable bits
  // ============================================================
  function moveBtn(dir, idx, arr, fn) {
    const disabled = dir === "up" ? idx === 0 : idx === arr.length - 1;
    const item = arr[idx];
    return el("button", {
      class: "icon-btn icon-btn--bordered", "aria-label": dir === "up" ? "Move up" : "Move down",
      disabled: disabled || undefined, onclick: () => fn(item, dir),
    }, dir === "up" ? "↑" : "↓");
  }

  function field(labelText, type, value, hint) {
    const id = uid();
    const input = type === "textarea"
      ? el("textarea", { id, rows: 3 })
      : el("input", { id, type });
    input.value = value || "";
    const wrap = el("div", { class: "field" },
      el("label", { for: id }, labelText),
      input,
      hint ? el("p", { class: "hint" }, hint) : null);
    return { wrap, input };
  }
  function checkField(labelText, checked) {
    const id = uid();
    const input = el("input", { type: "checkbox", id });
    input.checked = !!checked;
    const wrap = el("div", { class: "field field--check" }, input, el("label", { for: id }, labelText));
    return { wrap, input };
  }

  // ---------- Modal ----------
  let lastFocus = null;
  function openModal(titleText, bodyNodes, { submitText = "Save", onSubmit, onDelete } = {}) {
    lastFocus = document.activeElement;
    modalRoot.innerHTML = "";
    const dialog = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": titleText });
    dialog.appendChild(el("h2", {}, titleText));
    bodyNodes.forEach((n) => n && dialog.appendChild(n));

    const actions = el("div", { class: "modal__actions" },
      el("button", { class: "btn btn--ghost", type: "button", onclick: closeModal }, "Cancel"),
      el("button", { class: "btn btn--primary", type: "button", onclick: () => { if (onSubmit() !== false) closeModal(); } }, submitText));
    dialog.appendChild(actions);
    if (onDelete) {
      dialog.appendChild(el("button", {
        class: "btn btn--danger btn--block", type: "button", style: "margin-top:0.6rem",
        onclick: () => { if (confirm("Delete this? It cannot be undone.")) { onDelete(); closeModal(); } },
      }, "Delete"));
    }
    modalRoot.appendChild(dialog);
    modalRoot.hidden = false;
    modalRoot.addEventListener("mousedown", backdropClose);
    document.addEventListener("keydown", escClose);
    const first = dialog.querySelector("input,textarea,select,button");
    if (first) first.focus();
  }
  function closeModal() {
    modalRoot.hidden = true;
    modalRoot.innerHTML = "";
    modalRoot.removeEventListener("mousedown", backdropClose);
    document.removeEventListener("keydown", escClose);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  const backdropClose = (e) => { if (e.target === modalRoot) closeModal(); };
  const escClose = (e) => { if (e.key === "Escape") closeModal(); };

  // Name dialog returns a Promise<string|null>.
  function nameDialog() {
    return new Promise((resolve) => {
      const f = field("Your name", "text", state.me.name, "This is how your entries are signed, so others know who recorded what.");
      let done = false;
      const finish = (val) => { if (done) return; done = true; resolve(val); };
      lastFocus = document.activeElement;
      modalRoot.innerHTML = "";
      const dialog = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Your name" });
      dialog.appendChild(el("h2", {}, "What's your name?"));
      dialog.appendChild(f.wrap);
      const err = el("p", { class: "field-error", hidden: true }, "Please enter a name.");
      dialog.appendChild(err);
      dialog.appendChild(el("div", { class: "modal__actions" },
        el("button", { class: "btn btn--primary btn--block", type: "button", onclick: () => {
          if (!f.input.value.trim()) { err.hidden = false; return; }
          modalRoot.hidden = true; modalRoot.innerHTML = "";
          if (lastFocus && lastFocus.focus) lastFocus.focus();
          finish(f.input.value.trim());
        } }, "Continue")));
      modalRoot.appendChild(dialog);
      modalRoot.hidden = false;
      f.input.focus();
    });
  }

  // ---------- Settings menu ----------
  function openMenu() {
    const nameField = field("Your name", "text", state.me.name, "Changing this does not rename past entries — they keep the name recorded at the time.");
    openModal("Settings", [
      nameField.wrap,
      el("hr", { style: "border:none;border-top:1px solid var(--border);margin:1rem 0" }),
      el("p", { class: "hint" }, "This build keeps everything on this device only. Nothing is sent anywhere yet."),
      el("button", {
        class: "btn btn--danger btn--block", type: "button", style: "margin-top:0.5rem",
        onclick: () => {
          if (confirm("Leave and erase all Care Hub data from THIS device? This cannot be undone.")) {
            localStorage.removeItem(STORAGE_KEY); state = blank(); closeModal(); renderHeader(); setView("card");
          }
        },
      }, "Leave & erase this device"),
    ], {
      submitText: "Save name",
      onSubmit: () => {
        if (nameField.input.value.trim()) { state.me.name = nameField.input.value.trim(); save(); renderHeader(); }
        return true;
      },
    });
  }

  // ---------- Header / network ----------
  function renderHeader() {
    $("#header-sub").textContent = state.me.name ? `Signed as ${state.me.name}` : "Emergency & care information";
  }
  function updateNet() {
    const banner = $("#net-banner");
    if (!navigator.onLine) {
      banner.hidden = false;
      banner.textContent = "Offline — showing your saved copy on this device.";
    } else {
      banner.hidden = true;
    }
  }

  // ============================================================
  //  Boot
  // ============================================================
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
  $("#menu-btn").addEventListener("click", openMenu);
  window.addEventListener("online", updateNet);
  window.addEventListener("offline", updateNet);

  renderHeader();
  updateNet();
  setView("card");

  // First-run welcome → asks for a name (R1-02) once.
  if (!state.seenWelcome) {
    state.seenWelcome = true; save();
    ensureName();
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
