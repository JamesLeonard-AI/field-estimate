// Shared logic for reading a repair addendum + inspection report with Claude.
// Plain JavaScript so it runs in the Supabase Edge Function (Deno) and in local tests (Node).

export const SYSTEM_PROMPT = `You prepare repair checklists for the company, a home repair company that does the repairs a seller agrees to after a home inspection.

You get two PDFs for one property:
1. The REPAIR ADDENDUM: the signed agreement listing the repairs the seller will make. This is the master list.
2. The INSPECTION REPORT or REPAIR REQUEST LIST: the inspector's findings, often with the buyer's comments.

The documents are labeled, but if the labels look swapped, go by what each document actually is.

Build one checklist item for EACH repair on the addendum, in the addendum's order.

Rules:
- Item codes vary between inspectors: roman numerals (IV.9), numbers (3.1.5), letters (B-2), mixed, or none. Copy the code exactly as the addendum shows it. If the addendum has no code, use the matching code from the report; if neither has one, leave it empty.
- If one addendum line covers several report items (e.g. "V.0 ... V4 ..."), make ONE item, join the codes with " / ", and set flag to say the items were combined.
- If one addendum line lists several unrelated repairs with separate codes (e.g. "VII.6 Install GFCI ... IX.8 Install covers ..."), split them into separate items.
- addendum_text: the addendum's wording for that repair, lightly cleaned up (fix obvious typos, drop the code). Do not add or remove requirements.
- inspection_text: the inspector's comment for the matching report item, copied closely (you may drop boilerplate like "Representative photos"). If the request list also has a buyer comment that adds detail, add it on a new line starting "Buyer: ".
- Match addendum lines to report items by code first, then by meaning. Never guess: if no report item matches, leave inspection_text empty and set flag "Not found in the inspection report — check by hand."
- area: a short location and trade, like "Crawlspace · Plumbing", "Attic · Ventilation", "Exterior · Rear deck", "Interior · Kitchen".
- flag: also set it when the addendum asks for an evaluation or a contractor's opinion instead of a specific repair ("Evaluate on site — scope depends on what you find."). Otherwise leave it empty.
- warnings: list anything the office should double-check, such as repairs requested in the request list that are NOT on the signed addendum, unreadable pages, or a property address that differs between the two documents.
- address: the full property address. buyer / seller: names as written on the addendum ("Purchaser" is the buyer).

Call the save_checklist tool with the result.`;

export const TOOL = {
  name: "save_checklist",
  description: "Save the combined repair checklist for this property.",
  input_schema: {
    type: "object",
    properties: {
      address: { type: "string" },
      buyer: { type: "string" },
      seller: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string" },
            area: { type: "string" },
            addendum_text: { type: "string" },
            inspection_text: { type: "string" },
            flag: { type: "string" }
          },
          required: ["code", "area", "addendum_text", "inspection_text", "flag"]
        }
      },
      warnings: { type: "array", items: { type: "string" } }
    },
    required: ["address", "buyer", "seller", "items", "warnings"]
  }
};

export function buildRequest({ addendumB64, reportB64, model }) {
  return {
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Document 1 — REPAIR ADDENDUM:" },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: addendumB64 } },
        { type: "text", text: "Document 2 — INSPECTION REPORT / REPAIR REQUEST LIST:" },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: reportB64 } },
        { type: "text", text: "Build the checklist now." }
      ]
    }]
  };
}

const s = v => (typeof v === "string" ? v.trim() : "");

// Turns Claude's API response into {address, buyer, seller, items, warnings}. Throws if unusable.
export function parseResponse(resp) {
  const block = (resp?.content || []).find(b => b.type === "tool_use" && b.name === TOOL.name);
  if (!block) throw new Error("The AI did not return a checklist.");
  const r = block.input || {};
  const items = (Array.isArray(r.items) ? r.items : [])
    .map(it => ({ code: s(it.code), area: s(it.area), addendum_text: s(it.addendum_text), inspection_text: s(it.inspection_text), flag: s(it.flag) }))
    .filter(it => it.addendum_text || it.inspection_text);
  if (!items.length) throw new Error("No repair items were found in those documents.");
  const warnings = (Array.isArray(r.warnings) ? r.warnings : []).map(s).filter(Boolean);
  if (resp.stop_reason === "max_tokens") warnings.push("The document was very long and the list may be cut off. Check the last items.");
  return { address: s(r.address), buyer: s(r.buyer), seller: s(r.seller), items, warnings };
}

export async function extract({ addendumB64, reportB64, apiKey, model = "claude-sonnet-5-5", fetchImpl = fetch }) {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(buildRequest({ addendumB64, reportB64, model }))
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AI request failed (${res.status}): ${body?.error?.message || "unknown error"}`);
  return parseResponse(body);
}
