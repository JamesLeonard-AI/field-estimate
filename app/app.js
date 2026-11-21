import { makeStore, blankItem, prepareFile } from "./store.js";
import { SAMPLE_JOB } from "./sample.js";

const cfg = window.FE_CONFIG;
const store = makeStore(cfg);
const $ = s => document.querySelector(s);
const main = () => $("#main");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => parseFloat(v) || 0;
const money = v => "$" + num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hrs = v => (Math.round(num(v) * 100) / 100).toLocaleString();
const STATUS = { setup: "Being set up", ready: "Ready for field", done: "Estimate done" };
const go = h => { location.hash = h; };
let draft = null; // job read from PDFs, not saved yet

function toast(msg, bad) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = "toast"), 3500);
}
function header(title, sub, back, right = "") {
  $("#hdr").innerHTML = `${back ? `<a class="back" href="${back}">‹</a>` : ""}<div class="ht"><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div><div class="hr">${right}</div>`;
}
const debounce = (fn, ms = 500) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
async function guard(fn) { try { await fn(); } catch (e) { console.error(e); toast(e.message || "Something went wrong", true); } }

// ---------------- router ----------------
async function route() {
  window.scrollTo(0, 0);
  $("#tabs").innerHTML = ""; $("#tabs").hidden = true;
  if (store.mode === "live" && !(await store.session())) return login();
  const [, view, id, sub] = (location.hash || "#/").slice(1).split("/");
  await guard(async () => {
    if (!view) return jobs();
    if (view === "new") return newJob();
    if (view === "setup") return setup(id);
    if (view === "field") return field(id, sub);
    if (view === "estimate") return estimate(id);
    jobs();
  });
}
window.addEventListener("hashchange", route);

// ---------------- login (live mode) ----------------
function login() {
  header(cfg.COMPANY_NAME, "Sign in");
  main().innerHTML = `<form class="card narrow" id="lf"><label class="f">Email</label><input type="email" id="em" required autocomplete="username">
  <label class="f">Password</label><input type="password" id="pw" required autocomplete="current-password">
  <button class="btn p wide" style="margin-top:18px">Sign in</button></form>`;
  $("#lf").onsubmit = e => { e.preventDefault(); guard(async () => { await store.signIn($("#em").value, $("#pw").value); route(); }); };
}

// ---------------- job list ----------------
async function jobs() {
  const right = store.mode === "live" ? `<button class="btn ghost sm" id="so">Sign out</button>` : `<span class="pill warn">Demo mode</span>`;
  header(cfg.COMPANY_NAME, "Jobs", null, right);
  if ($("#so")) $("#so").onclick = () => guard(async () => { await store.signOut(); route(); });
  const list = await store.listJobs();
  main().innerHTML = `
  <div class="bar"><a class="btn p" href="#/new">+ New job</a>${store.mode === "demo" ? `<button class="btn" id="sample">Load sample job</button>` : ""}</div>
  ${list.length ? list.map(j => `
    <div class="card job">
      <div><div class="addr">${esc(j.address || "No address yet")}</div>
      <div class="meta"><span class="pill ${j.status}">${STATUS[j.status] || j.status}</span>${j.archived_at ? ` <span class="pill done">Saved to Dropbox</span>` : j.archive_error ? ` <span class="pill warn" title="${esc(j.archive_error)}">Dropbox retrying</span>` : ""} ${j.item_count} items · ${j.done_count} estimated · ${new Date(j.created_at).toLocaleDateString()}</div></div>
      <div class="acts">
        <a class="btn sm" href="#/setup/${j.id}">Office</a>
        <a class="btn sm p" href="#/field/${j.id}/0">Field</a>
        ${j.status === "done" ? `<a class="btn sm" href="#/estimate/${j.id}">Estimate</a>` : ""}
      </div></div>`).join("") : `<div class="empty">No jobs yet. Tap <b>New job</b> to add one.</div>`}`;
  if ($("#sample")) $("#sample").onclick = () => guard(async () => { const id = await store.createJob(structuredClone(SAMPLE_JOB)); go(`#/setup/${id}`); });
}

// ---------------- new job ----------------
function newJob() {
  header("New job", "Add the repair paperwork", "#/");
  main().innerHTML = `
  <div class="card"><h3>Read the PDFs for me</h3>
    <p class="mute">Upload the repair addendum and the inspection report or request list. The AI pulls out every repair item and lines them up. You check it before saving.</p>
    <label class="f">Repair addendum (PDF)</label><input type="file" id="pa" accept="application/pdf">
    <label class="f">Inspection report / request list (PDF)</label><input type="file" id="pr" accept="application/pdf">
    <button class="btn p" id="ai" style="margin-top:16px">Read PDFs</button> <span id="aist" class="mute"></span></div>
  <div class="card"><h3>Or type it in</h3><p class="mute">Start an empty job and enter the items by hand.</p>
    <button class="btn" id="manual">Start empty job</button></div>`;
  $("#manual").onclick = () => guard(async () => { const id = await store.createJob({}); go(`#/setup/${id}`); });
  $("#ai").onclick = () => guard(async () => {
    const a = $("#pa").files[0], r = $("#pr").files[0];
    if (!a || !r) return toast("Choose both PDFs first.", true);
    $("#ai").disabled = true; $("#aist").textContent = "Reading… this takes about 30 seconds.";
    try {
      const out = await store.extract(a, r);
      const warn = out.warnings || [];
      const id = await store.createJob({ address: out.address, buyer: out.buyer, seller: out.seller, items: out.items || [],
        notes: warn.length ? "CHECK: " + warn.join(" | ") : "" });
      toast(`Found ${(out.items || []).length} items. Please check them${warn.length ? " and the notes at the top" : ""}.`);
      go(`#/setup/${id}`);
    } finally { $("#ai").disabled = false; $("#aist").textContent = ""; }
  });
}

// ---------------- office setup / review ----------------
async function setup(id) {
  const job = await store.getJob(id); if (!job) return go("#/");
  header(job.address || "New job", "Office setup", "#/", `<a class="btn sm p" href="#/field/${id}/0">Open in field</a>`);
  const saveJob = debounce(patch => guard(() => store.updateJob(id, patch)));
  const render = () => {
    main().innerHTML = `
    <div class="card"><div class="row3">
      <div><label class="f">Property address</label><input id="j_address" value="${esc(job.address)}"></div>
      <div><label class="f">Buyer</label><input id="j_buyer" value="${esc(job.buyer)}"></div>
      <div><label class="f">Seller</label><input id="j_seller" value="${esc(job.seller)}"></div></div>
      <label class="f">Status</label><select id="j_status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${job.status === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <label class="f">Job notes</label><textarea id="j_notes" placeholder="Notes for the estimator">${esc(job.notes)}</textarea>
      ${/^CHECK:/.test(job.notes || "") ? `<div class="flag">⚠ The AI flagged things to double-check — see the notes above.</div>` : ""}
    </div>
    <h3 class="sec">Repair items (${job.items.length})</h3>
    ${job.items.map((it, i) => `
    <div class="card item" data-i="${i}">
      <div class="ih"><span class="num">${i + 1}</span>
        <input class="code" data-k="code" placeholder="Item # (e.g. 3.1.5)" value="${esc(it.code)}">
        <input data-k="area" placeholder="Area (e.g. Crawlspace · Electrical)" value="${esc(it.area)}">
        <span class="ibtns"><button class="btn sm" data-a="up" ${i === 0 ? "disabled" : ""}>↑</button><button class="btn sm" data-a="down" ${i === job.items.length - 1 ? "disabled" : ""}>↓</button><button class="btn sm danger" data-a="del">Delete</button></span></div>
      <label class="f">What the repair addendum says</label><textarea data-k="addendum_text">${esc(it.addendum_text)}</textarea>
      <label class="f">From the inspection report</label><textarea data-k="inspection_text">${esc(it.inspection_text)}</textarea>
      <label class="f">Screenshot of the inspection section (optional)</label>
      <div class="media">${it.media.filter(m => m.kind === "inspection").map(m => thumb(m)).join("")}${addBtn("Add screenshot", "image/*")}</div>
      <label class="f">Flag for the estimator (optional)</label><input data-k="flag" placeholder="e.g. Evaluate on site" value="${esc(it.flag)}">
    </div>`).join("")}
    <div class="bar"><button class="btn" id="add">+ Add item</button><span class="grow"></span><button class="btn danger" id="deljob">Delete job</button><button class="btn p" id="ready">Send to field ›</button></div>`;

    ["address", "buyer", "seller", "notes"].forEach(k => ($(`#j_${k}`).oninput = e => { job[k] = e.target.value; saveJob({ [k]: job[k] }); if (k === "address") header(job.address || "New job", "Office setup", "#/", `<a class="btn sm p" href="#/field/${id}/0">Open in field</a>`); }));
    $("#j_status").onchange = e => guard(() => store.updateJob(id, { status: (job.status = e.target.value) }));
    document.querySelectorAll(".item").forEach(el => {
      const it = job.items[+el.dataset.i];
      const save = debounce(() => guard(() => store.saveItem(it)));
      el.querySelectorAll("[data-k]").forEach(inp => (inp.oninput = () => { it[inp.dataset.k] = inp.value; save(); }));
      el.querySelectorAll("[data-a]").forEach(b => (b.onclick = () => guard(async () => {
        const i = +el.dataset.i, a = b.dataset.a;
        if (a === "del") { if (!(await confirmBox(`Delete item ${i + 1}${it.code ? ` (${it.code})` : ""}?`))) return; await store.deleteItem(it); job.items.splice(i, 1); }
        else { const j = a === "up" ? i - 1 : i + 1; [job.items[i], job.items[j]] = [job.items[j], job.items[i]]; }
        job.items.forEach((x, k) => (x.position = k));
        await Promise.all(job.items.map(x => store.saveItem(x))); render();
      })));
      wireMedia(el, it, "inspection", render);
    });
    $("#add").onclick = () => guard(async () => { const it = blankItem(id, job.items.length); await store.saveItem(it); job.items.push(it); render(); window.scrollTo(0, document.body.scrollHeight); });
    $("#ready").onclick = () => guard(async () => {
      if (!job.items.length) return toast("Add at least one repair item first.", true);
      await store.updateJob(id, { status: "ready" }); toast("Sent to the field."); go("#/");
    });
    $("#deljob").onclick = () => guard(async () => { if (await confirmBox("Delete this whole job, including its photos and videos? This can't be undone.")) { await store.deleteJob(id); go("#/"); } });
  };
  render();
}

// ---------------- media helpers ----------------
const thumb = m => `<div class="m">${m.mime?.startsWith("video") ? `<video src="${esc(m.url)}" controls playsinline preload="metadata"></video>` : `<a href="${esc(m.url)}" target="_blank" rel="noopener"><img src="${esc(m.url)}" alt=""></a>`}<button class="x" data-mid="${m.id}" title="Remove">×</button></div>`;
const addBtn = (label, accept) => `<label class="add">＋<span>${label}</span><input type="file" accept="${accept}" multiple></label>`;
function wireMedia(el, it, kind, rerender) {
  const inp = el.querySelector(".add input");
  if (inp) inp.onchange = () => guard(async () => {
    const lbl = inp.parentElement; lbl.classList.add("busy"); lbl.querySelector("span").textContent = "Uploading…";
    try { for (const f of inp.files) await store.addMedia(it, await prepareFile(f, cfg), kind); } finally { rerender(); }
  });
  el.querySelectorAll(".x[data-mid]").forEach(b => (b.onclick = () => guard(async () => {
    if (!(await confirmBox("Remove this photo/video?"))) return;
    await store.removeMedia(it, it.media.find(m => m.id === b.dataset.mid)); rerender();
  })));
}
function confirmBox(msg) {
  return new Promise(res => {
    const d = $("#dlg"); d.querySelector("p").textContent = msg; d.showModal();
    d.querySelector("#dy").onclick = () => { d.close(); res(true); };
    d.querySelector("#dn").onclick = () => { d.close(); res(false); };
  });
}

// ---------------- field walkthrough ----------------
async function field(id, sub) {
  const job = await store.getJob(id); if (!job) return go("#/");
  const N = job.items.length;
  if (!N) { header(job.address, "Field estimate", "#/"); main().innerHTML = `<div class="empty">This job has no items yet. The office needs to set it up first.</div>`; return; }
  const cur = sub === "totals" ? N : Math.min(Math.max(+sub || 0, 0), N - 1);
  const doneN = job.items.filter(i => i.done).length;
  header(job.address, "Field estimate", "#/", `<span class="pill">${doneN} of ${N} done</span>`);
  const tabs = $("#tabs"); tabs.hidden = false;
  tabs.innerHTML = job.items.map((it, i) => `<a class="${i === cur ? "on" : ""} ${it.done ? "done" : ""}" href="#/field/${id}/${i}">${i + 1}${it.code ? ". " + esc(it.code) : ""}</a>`).join("") + `<a class="${cur === N ? "on" : ""}" href="#/field/${id}/totals">Totals</a>`;
  tabs.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest" });
  if (cur === N) return totals(job);

  const it = job.items[cur];
  const insp = it.media.filter(m => m.kind === "inspection"), fm = it.media.filter(m => m.kind === "field");
  main().innerHTML = `
  <div class="card"><span class="code-b">${esc(it.code || "Item " + (cur + 1))}</span><span class="mute">${esc(it.area)}</span>
    <p class="lbl">Repair addendum says</p><h2>${esc(it.addendum_text) || "<span class='mute'>(nothing entered)</span>"}</h2>
    ${it.flag ? `<div class="flag">⚠ ${esc(it.flag)}</div>` : ""}</div>
  ${it.inspection_text || insp.length ? `<div class="card"><p class="lbl">From the home inspection</p>
    <div class="excerpt">${esc(it.inspection_text)}${insp.length ? `<div class="media ro">${insp.map(m => `<a href="${esc(m.url)}" target="_blank" rel="noopener"><img src="${esc(m.url)}" alt=""></a>`).join("")}</div>` : ""}</div></div>` : ""}
  <div class="card" id="fc">
    <div class="row2">
      <div><label class="f">Materials cost</label><div class="pre"><span>$</span><input type="number" inputmode="decimal" min="0" step="0.01" data-k="materials_cost" value="${it.materials_cost ?? ""}" placeholder="0.00"></div></div>
      <div><label class="f">Labor hours</label><input type="number" inputmode="decimal" min="0" step="0.25" data-k="labor_hours" value="${it.labor_hours ?? ""}" placeholder="0"></div></div>
    <label class="f">Supply list</label><textarea data-k="supply_list" placeholder="e.g. 3 weatherproof outlet covers">${esc(it.supply_list)}</textarea>
    <label class="f">Notes</label><textarea data-k="notes" placeholder="Anything the office should know">${esc(it.notes)}</textarea>
    <label class="f">Pictures or video</label>
    <div class="media">${fm.map(m => thumb(m)).join("")}${addBtn("Add photo / video", "image/*,video/*")}</div>
    <label class="done-t"><input type="checkbox" id="done" ${it.done ? "checked" : ""}> Item estimated</label>
  </div>
  <nav class="bot"><a class="btn" href="#/field/${id}/${Math.max(cur - 1, 0)}" ${cur === 0 ? "hidden" : ""}>‹ Back</a><span class="mute">Item ${cur + 1} of ${N}</span><a class="btn p" id="next" href="#/field/${id}/${cur === N - 1 ? "totals" : cur + 1}">${cur === N - 1 ? "See totals ›" : "Next ›"}</a></nav>`;

  let pending = Promise.resolve();
  const save = debounce(() => (pending = guard(() => store.saveItem(it))), 400);
  $("#fc").querySelectorAll("[data-k]").forEach(inp => (inp.oninput = () => {
    const k = inp.dataset.k; it[k] = inp.type === "number" ? (inp.value === "" ? null : num(inp.value)) : inp.value; save();
  }));
  $("#done").onchange = e => guard(async () => { it.done = e.target.checked; await store.saveItem(it); route(); });
  $("#next").onclick = e => {
    e.preventDefault(); const href = e.currentTarget.getAttribute("href");
    guard(async () => {
      if (!it.done && (it.materials_cost != null || it.labor_hours != null)) it.done = true;
      await store.saveItem(it); go(href);
    });
  };
  wireMedia($("#fc"), it, "field", () => field(id, String(cur)));
}

function totals(job) {
  const tc = job.items.reduce((s, x) => s + num(x.materials_cost), 0), th = job.items.reduce((s, x) => s + num(x.labor_hours), 0);
  const missing = job.items.filter(i => !i.done).length;
  main().innerHTML = `
  <div class="big"><div>Total materials<b>${money(tc)}</b></div><div>Total labor<b>${hrs(th)} hrs</b></div></div>
  <div class="card"><table><thead><tr><th>#</th><th>Item</th><th class="n">Materials</th><th class="n">Hours</th></tr></thead><tbody>
  ${job.items.map((it, i) => `<tr data-i="${i}" class="${it.done ? "" : "todo"}"><td>${i + 1}</td><td><b>${esc(it.code)}</b> <span class="mute">${esc(it.area)}</span>${it.media.some(m => m.kind === "field") ? " · 📷" : ""}${it.done ? "" : ` <span class="pill warn">not done</span>`}</td><td class="n">${it.materials_cost != null ? money(it.materials_cost) : "—"}</td><td class="n">${it.labor_hours != null ? hrs(it.labor_hours) : "—"}</td></tr>`).join("")}
  <tr class="tot"><td></td><td>Total</td><td class="n">${money(tc)}</td><td class="n">${hrs(th)}</td></tr></tbody></table></div>
  <label class="f">Job notes</label><textarea id="jn" placeholder="Overall notes for the office">${esc(job.notes)}</textarea>
  <nav class="bot"><a class="btn" href="#/field/${job.id}/${job.items.length - 1}">‹ Back</a><span class="mute">${missing ? `${missing} item${missing > 1 ? "s" : ""} not done` : "All items done"}</span><button class="btn p" id="fin">Finish estimate</button></nav>`;
  main().querySelectorAll("tr[data-i]").forEach(r => (r.onclick = () => go(`#/field/${job.id}/${r.dataset.i}`)));
  $("#jn").oninput = debounce(e => guard(() => store.updateJob(job.id, { notes: e.target.value })));
  $("#fin").onclick = () => guard(async () => {
    if (missing && !(await confirmBox(`${missing} item${missing > 1 ? "s are" : " is"} not marked done. Finish anyway?`))) return;
    await store.updateJob(job.id, { status: "done", notes: $("#jn").value }); store.archive(job.id); go(`#/estimate/${job.id}`);
  });
}

// ---------------- printable estimate ----------------
async function estimate(id) {
  const job = await store.getJob(id); if (!job) return go("#/");
  header("Estimate", job.address, "#/", `<button class="btn sm p" id="pr">Print / Save PDF</button>`);
  const tc = job.items.reduce((s, x) => s + num(x.materials_cost), 0), th = job.items.reduce((s, x) => s + num(x.labor_hours), 0);
  main().innerHTML = `
  <div class="sheet">
    <div class="sh"><div><div class="co">${esc(cfg.COMPANY_NAME)}</div><div class="mute">${esc(cfg.COMPANY_LINE)}</div></div>
      <div class="r"><b>Repair Estimate</b><div class="mute">${new Date().toLocaleDateString()}</div></div></div>
    <div class="meta2"><div><span class="lbl">Property</span>${esc(job.address)}</div><div><span class="lbl">Seller</span>${esc(job.seller)}</div><div><span class="lbl">Buyer</span>${esc(job.buyer)}</div></div>
    ${job.items.map((it, i) => `<div class="ei">
      <div class="eh"><b>${i + 1}. ${esc(it.code)}</b> <span class="mute">${esc(it.area)}</span><span class="grow"></span><span>${it.materials_cost != null ? money(it.materials_cost) : "—"} · ${it.labor_hours != null ? hrs(it.labor_hours) + " hrs" : "—"}</span></div>
      <div>${esc(it.addendum_text)}</div>
      ${it.supply_list ? `<div class="sm"><span class="lbl">Supplies</span> ${esc(it.supply_list)}</div>` : ""}
      ${it.notes ? `<div class="sm"><span class="lbl">Notes</span> ${esc(it.notes)}</div>` : ""}
      ${it.media.some(m => m.kind === "field" && m.mime?.startsWith("image")) ? `<div class="pics">${it.media.filter(m => m.kind === "field" && m.mime?.startsWith("image")).map(m => `<img src="${esc(m.url)}" alt="">`).join("")}</div>` : ""}
    </div>`).join("")}
    <table class="et"><tr><td>Total materials</td><td class="n">${money(tc)}</td></tr><tr><td>Total labor</td><td class="n">${hrs(th)} hrs</td></tr></table>
    ${job.notes ? `<div class="sm"><span class="lbl">Job notes</span> ${esc(job.notes)}</div>` : ""}
  </div>
  <p class="mute noprint" style="text-align:center">Photos and videos are copied to the company Dropbox once a job is finished. Tap <b>Print / Save PDF</b> to keep a copy of this estimate.</p>`;
  $("#pr").onclick = () => window.print();
}

route();
