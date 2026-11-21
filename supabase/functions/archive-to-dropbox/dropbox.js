// Dropbox helpers (plain JS so it can be tested with Node).

export async function dropboxToken({ appKey, appSecret, refreshToken, fetchImpl = fetch }) {
  const res = await fetchImpl("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: appKey, client_secret: appSecret }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error("Dropbox sign-in failed: " + (j.error_description || res.status));
  return j.access_token;
}

// Safe folder/file names (also safe for Dropbox's Windows/Mac sync).
export const clean = s => String(s || "").replace(/[\\/:*?"<>|#%]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 80);

export function jobFolder(root, job) {
  const date = (job.completed_at || job.created_at || new Date().toISOString()).slice(0, 10);
  const addr = clean((job.address || "No address").split(",").slice(0, 2).join(" "));
  return `${root.replace(/\/+$/, "")}/${date} - ${addr}`;
}

export function itemFolder(item, index) {
  const n = String(index + 1).padStart(2, "0");
  return clean(`${n} ${item.code || ""} ${(item.area || "").replace(/·/g, " ")}`) || n;
}

export function mediaName(m, k) {
  const ext = (m.path.split(".").pop() || "bin").toLowerCase();
  return `${m.kind === "inspection" ? "inspection" : "field"}-${k + 1}-${m.id.slice(0, 8)}.${ext}`;
}

export function summaryText(job, items) {
  const money = v => (v == null ? "-" : "$" + Number(v).toFixed(2));
  const tc = items.reduce((s, i) => s + Number(i.materials_cost || 0), 0);
  const th = items.reduce((s, i) => s + Number(i.labor_hours || 0), 0);
  const lines = [
    `Property: ${job.address}`, `Seller: ${job.seller}`, `Buyer: ${job.buyer}`,
    `Finished: ${(job.completed_at || "").slice(0, 10)}`, "",
    ...items.flatMap((it, i) => [
      `${i + 1}. ${it.code} — ${it.area}`, `   Repair: ${it.addendum_text}`,
      `   Materials: ${money(it.materials_cost)}   Labor: ${it.labor_hours ?? "-"} hrs`,
      ...(it.supply_list ? [`   Supplies: ${it.supply_list}`] : []),
      ...(it.notes ? [`   Notes: ${it.notes}`] : []), "",
    ]),
    `TOTAL MATERIALS: ${money(tc)}`, `TOTAL LABOR: ${th} hrs`,
    ...(job.notes ? ["", `Job notes: ${job.notes}`] : []),
  ];
  return lines.join("\n");
}

export async function upload({ token, path, bytes, fetchImpl = fetch, pathRoot }) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/octet-stream",
    // Non-ASCII characters must be escaped in this header.
    "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", mute: true }).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")),
  };
  if (pathRoot) headers["Dropbox-API-Path-Root"] = JSON.stringify({ ".tag": "root", root: pathRoot });
  const res = await fetchImpl("https://content.dropboxapi.com/2/files/upload", { method: "POST", headers, body: bytes });
  if (!res.ok) throw new Error(`Dropbox upload failed for ${path} (${res.status}): ${await res.text().catch(() => "")}`);
}
