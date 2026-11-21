// Data layer. Two backends with the same interface:
//   LocalStore    - demo mode, everything kept in this browser (localStorage + IndexedDB)
//   SupabaseStore - shared database + file storage for the whole team
//
// Job:   {id, address, buyer, seller, status, notes, created_at, items:[Item]}
// Item:  {id, job_id, position, code, area, addendum_text, inspection_text, flag,
//         materials_cost, labor_hours, supply_list, notes, done, media:[Media]}
// Media: {id, item_id, kind:'inspection'|'field', mime, url, path}
// status: 'setup' | 'ready' | 'done'

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const ITEM_FIELDS = ["position","code","area","addendum_text","inspection_text","flag","materials_cost","labor_hours","supply_list","notes","done"];

export function blankItem(job_id, position) {
  return { id: uid(), job_id, position, code: "", area: "", addendum_text: "", inspection_text: "", flag: "",
           materials_cost: null, labor_hours: null, supply_list: "", notes: "", done: false, media: [] };
}

// ---------- shared image shrinking ----------
export async function prepareFile(file, cfg) {
  if (file.type.startsWith("video/")) {
    if (file.size > cfg.MAX_VIDEO_MB * 1024 * 1024)
      throw new Error(`That video is over ${cfg.MAX_VIDEO_MB} MB. Please record a shorter clip (under a minute).`);
    return file;
  }
  if (!file.type.startsWith("image/")) throw new Error("Only photos and videos can be added.");
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, cfg.PHOTO_MAX_PX / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.82));
    return new File([blob], (file.name || "photo").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch { return file; }
}

// ---------- demo backend ----------
class LocalStore {
  constructor() { this.mode = "demo"; this.urls = new Map(); }
  _load() { try { return JSON.parse(localStorage.getItem("fe-jobs") || "[]"); } catch { return []; } }
  _save(jobs) { try { localStorage.setItem("fe-jobs", JSON.stringify(jobs)); } catch (e) { console.warn(e); } }
  _db() {
    return this._dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open("fe-media", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("blobs");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async _blob(op, key, val) {
    const db = await this._db();
    return new Promise((res, rej) => {
      const tx = db.transaction("blobs", op === "get" ? "readonly" : "readwrite");
      const s = tx.objectStore("blobs");
      const q = op === "get" ? s.get(key) : op === "put" ? s.put(val, key) : s.delete(key);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  }
  async _hydrate(m) {
    if (!this.urls.has(m.id)) {
      const b = await this._blob("get", m.id).catch(() => null);
      this.urls.set(m.id, b ? URL.createObjectURL(b) : "");
    }
    return { ...m, url: this.urls.get(m.id) };
  }
  async session() { return { email: "demo" }; }
  async listJobs() {
    return this._load().map(j => ({ ...j, item_count: j.items.length, done_count: j.items.filter(i => i.done).length }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async getJob(id) {
    const j = this._load().find(x => x.id === id); if (!j) return null;
    for (const it of j.items) it.media = await Promise.all((it.media || []).map(m => this._hydrate(m)));
    j.items.sort((a, b) => a.position - b.position);
    return j;
  }
  async createJob(data) {
    const jobs = this._load();
    const job = { id: uid(), address: "", buyer: "", seller: "", status: "setup", notes: "", created_at: new Date().toISOString(), ...data, items: [] };
    job.items = (data.items || []).map((it, i) => ({ ...blankItem(job.id, i), ...it, id: uid(), job_id: job.id, position: i, media: [] }));
    jobs.push(job); this._save(jobs); return job.id;
  }
  async updateJob(id, patch) {
    const jobs = this._load(); const j = jobs.find(x => x.id === id);
    Object.assign(j, patch); this._save(jobs);
  }
  async deleteJob(id) {
    const jobs = this._load(); const j = jobs.find(x => x.id === id);
    for (const it of j?.items || []) for (const m of it.media || []) await this._blob("del", m.id).catch(() => {});
    this._save(jobs.filter(x => x.id !== id));
  }
  async saveItem(item) {
    const jobs = this._load(); const j = jobs.find(x => x.id === item.job_id);
    const strip = { ...item, media: (item.media || []).map(({ url, ...m }) => m) };
    const i = j.items.findIndex(x => x.id === item.id);
    if (i < 0) j.items.push(strip); else j.items[i] = { ...j.items[i], ...strip };
    this._save(jobs);
  }
  async deleteItem(item) {
    const jobs = this._load(); const j = jobs.find(x => x.id === item.job_id);
    for (const m of item.media || []) await this._blob("del", m.id).catch(() => {});
    j.items = j.items.filter(x => x.id !== item.id); this._save(jobs);
  }
  async addMedia(item, file, kind) {
    const m = { id: uid(), item_id: item.id, kind, mime: file.type };
    await this._blob("put", m.id, file);
    this.urls.set(m.id, URL.createObjectURL(file));
    item.media = [...(item.media || []), { ...m, url: this.urls.get(m.id) }];
    await this.saveItem(item); return item;
  }
  async removeMedia(item, m) {
    await this._blob("del", m.id).catch(() => {});
    item.media = item.media.filter(x => x.id !== m.id);
    await this.saveItem(item); return item;
  }
  async archive() {}
  async extract() {
    throw new Error("Reading PDFs needs the real database and AI step set up (README, steps 2–4). In demo mode, type the items in or load the sample job.");
  }
}

// ---------- shared backend ----------
class SupabaseStore {
  constructor(cfg) {
    this.mode = "live"; this.cfg = cfg;
    this.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }
  async session() { const { data } = await this.sb.auth.getSession(); return data.session?.user || null; }
  async signIn(email, password) {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }
  async signOut() { await this.sb.auth.signOut(); }
  _ok({ data, error }) { if (error) throw error; return data; }
  async listJobs() {
    const rows = this._ok(await this.sb.from("jobs").select("*, items(id, done)").order("created_at", { ascending: false }));
    return rows.map(j => ({ ...j, item_count: j.items.length, done_count: j.items.filter(i => i.done).length }));
  }
  async getJob(id) {
    const j = this._ok(await this.sb.from("jobs").select("*, items(*, media(*))").eq("id", id).single());
    j.items.sort((a, b) => a.position - b.position);
    const paths = j.items.flatMap(i => i.media.map(m => m.path));
    if (paths.length) {
      const signed = this._ok(await this.sb.storage.from("media").createSignedUrls(paths, 60 * 60 * 8));
      const byPath = Object.fromEntries(signed.map(s => [s.path, s.signedUrl]));
      j.items.forEach(i => i.media.forEach(m => (m.url = byPath[m.path])));
    }
    return j;
  }
  async createJob(data) {
    const { items = [], ...job } = data;
    const row = this._ok(await this.sb.from("jobs").insert({ status: "setup", ...job }).select().single());
    if (items.length) this._ok(await this.sb.from("items").insert(items.map((it, i) => {
      const r = { job_id: row.id, position: i };
      for (const k of ITEM_FIELDS) if (it[k] !== undefined) r[k] = it[k];
      r.position = i; return r;
    })));
    return row.id;
  }
  async updateJob(id, patch) { this._ok(await this.sb.from("jobs").update(patch).eq("id", id)); }
  async deleteJob(id) {
    const j = await this.getJob(id);
    const paths = j.items.flatMap(i => i.media.map(m => m.path));
    if (paths.length) await this.sb.storage.from("media").remove(paths);
    this._ok(await this.sb.from("jobs").delete().eq("id", id));
  }
  async saveItem(item) {
    const r = { id: item.id, job_id: item.job_id };
    for (const k of ITEM_FIELDS) r[k] = item[k] === "" && (k === "materials_cost" || k === "labor_hours") ? null : item[k];
    this._ok(await this.sb.from("items").upsert(r));
  }
  async deleteItem(item) {
    const paths = (item.media || []).map(m => m.path);
    if (paths.length) await this.sb.storage.from("media").remove(paths);
    this._ok(await this.sb.from("items").delete().eq("id", item.id));
  }
  async addMedia(item, file, kind) {
    await this.saveItem(item); // make sure the item row exists first
    const ext = (file.name.split(".").pop() || "bin").toLowerCase();
    const path = `${item.job_id}/${item.id}/${uid()}.${ext}`;
    this._ok(await this.sb.storage.from("media").upload(path, file, { contentType: file.type }));
    const m = this._ok(await this.sb.from("media").insert({ item_id: item.id, kind, mime: file.type, path }).select().single());
    const s = this._ok(await this.sb.storage.from("media").createSignedUrl(path, 60 * 60 * 8));
    item.media = [...(item.media || []), { ...m, url: s.signedUrl }];
    return item;
  }
  async removeMedia(item, m) {
    await this.sb.storage.from("media").remove([m.path]);
    this._ok(await this.sb.from("media").delete().eq("id", m.id));
    item.media = item.media.filter(x => x.id !== m.id); return item;
  }
  // Copies a finished job's photos/videos to Dropbox (runs in the background; the scheduler retries failures).
  async archive(jobId) { this.sb.functions.invoke("archive-to-dropbox", { body: { job_id: jobId } }).catch(() => {}); }
  // Sends the addendum + inspection PDFs to the AI step; returns {address, buyer, seller, items:[...]}
  async extract(addendumFile, reportFile) {
    const toB64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });
    const body = { addendum_pdf: await toB64(addendumFile), report_pdf: await toB64(reportFile), save: false };
    const { data, error } = await this.sb.functions.invoke(this.cfg.EXTRACT_FUNCTION, { body });
    if (error) throw new Error("The AI couldn't read those files: " + error.message);
    return data;
  }
}

export function makeStore(cfg) {
  return cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase ? new SupabaseStore(cfg) : new LocalStore();
}
