export async function odooAuth(
  url: string,
  db: string,
  user: string,
  key: string
): Promise<number> {
  const xml = `<?xml version="1.0"?>
<methodCall><methodName>authenticate</methodName><params>
  <param><value><string>${db}</string></value></param>
  <param><value><string>${user}</string></value></param>
  <param><value><string>${key}</string></value></param>
  <param><value><struct/></value></param>
</params></methodCall>`;

  const res = await fetch(`${url}/xmlrpc/2/common`, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: xml,
  });
  const text = await res.text();
  const match = text.match(/<int>(\d+)<\/int>/);
  if (!match) throw new Error(`Odoo auth failed: ${text.slice(0, 300)}`);
  return parseInt(match[1]);
}

export async function odooSearchRead(
  url: string,
  db: string,
  uid: number,
  key: string
): Promise<any[]> {
  const xml = `<?xml version="1.0"?>
<methodCall><methodName>execute_kw</methodName><params>
  <param><value><string>${db}</string></value></param>
  <param><value><int>${uid}</int></value></param>
  <param><value><string>${key}</string></value></param>
  <param><value><string>account.analytic.line</string></value></param>
  <param><value><string>search_read</string></value></param>
  <param><value><array><data><value><array><data/></array></value></data></array></value></param>
  <param><value><struct>
    <member><name>fields</name><value><array><data>
      <value><string>employee_id</string></value>
      <value><string>unit_amount</string></value>
      <value><string>name</string></value>
      <value><string>date</string></value>
      <value><string>project_id</string></value>
      <value><string>task_id</string></value>
    </data></array></value></member>
  </struct></value></param>
</params></methodCall>`;

  const res = await fetch(`${url}/xmlrpc/2/object`, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: xml,
  });
  const text = await res.text();
  return parseOdooResponse(text);
}

// ─── Stack-based XML helpers ─────────────────────────────────────────────────

/**
 * Find the index of the closing tag that matches the opening tag
 * starting at `from` (which is the position RIGHT AFTER the opening tag).
 * Uses a depth counter so nested identical tags are handled correctly.
 */
function findClose(xml: string, from: number, open: string, close: string): number {
  let depth = 1;
  let i = from;
  while (i < xml.length) {
    if (xml.startsWith(open, i)) {
      depth++;
      i += open.length;
    } else if (xml.startsWith(close, i)) {
      depth--;
      if (depth === 0) return i;
      i += close.length;
    } else {
      i++;
    }
  }
  return -1;
}

// ─── Value parser ─────────────────────────────────────────────────────────────

function parseValue(v: string): any {
  const t = v.trim();
  if (!t) return null;

  // false / null
  if (t === "false" || t === "<boolean>0</boolean>") return false;
  if (t === "true"  || t === "<boolean>1</boolean>") return true;

  // Integer
  const intM = t.match(/^<int>(-?\d+)<\/int>$/);
  if (intM) return parseInt(intM[1], 10);

  // Double
  const dblM = t.match(/^<double>([\d.eE+\-]+)<\/double>$/);
  if (dblM) return parseFloat(dblM[1]);

  // String
  if (t.startsWith("<string>") && t.endsWith("</string>")) {
    return t.slice(8, -9);
  }
  // Empty string tag
  if (t === "<string/>") return "";

  // Array — use stack-based extraction for each <value> inside <data>
  if (t.startsWith("<array>")) {
    const dataOpen  = t.indexOf("<data>");
    const dataClose = t.lastIndexOf("</data>");
    if (dataOpen === -1 || dataClose === -1) return [];

    const dataContent = t.slice(dataOpen + 6, dataClose);
    const items: any[] = [];
    let pos = 0;

    while (true) {
      const valStart = dataContent.indexOf("<value>", pos);
      if (valStart === -1) break;

      const contentStart = valStart + 7;
      const valEnd = findClose(dataContent, contentStart, "<value>", "</value>");
      if (valEnd === -1) break;

      items.push(parseValue(dataContent.slice(contentStart, valEnd).trim()));
      pos = valEnd + 8; // skip past </value>
    }

    return items;
  }

  // Struct (nested dict — unlikely for our fields but handle gracefully)
  if (t.startsWith("<struct>")) {
    const inner = t.slice(8, t.lastIndexOf("</struct>"));
    return parseMembersToRecord(inner);
  }

  // Bare text fallback (some Odoo versions omit type tags for strings)
  const bare = t.replace(/<\/?[^>]+>/g, "").trim();
  return bare === "" ? null : bare;
}

// ─── Struct / member parsers ──────────────────────────────────────────────────

function parseMembersToRecord(structBody: string): Record<string, any> {
  const record: Record<string, any> = {};
  let pos = 0;

  while (true) {
    const memberStart = structBody.indexOf("<member>", pos);
    if (memberStart === -1) break;

    // <member> does not nest in Odoo XML-RPC so plain indexOf is safe
    const memberEnd = structBody.indexOf("</member>", memberStart + 8);
    if (memberEnd === -1) break;

    const memberContent = structBody.slice(memberStart + 8, memberEnd);

    // Field name
    const nameMatch = memberContent.match(/<name>([^<]*)<\/name>/);
    if (!nameMatch) { pos = memberEnd + 9; continue; }
    const fieldName = nameMatch[1].trim();

    // Outer <value> for this member — use stack-based close-finder
    const nameTagEnd = memberContent.indexOf("</name>") + 7;
    const valOpen    = memberContent.indexOf("<value>", nameTagEnd);
    if (valOpen === -1) { pos = memberEnd + 9; continue; }

    const contentStart = valOpen + 7;
    const valClose     = findClose(memberContent, contentStart, "<value>", "</value>");
    if (valClose === -1) { pos = memberEnd + 9; continue; }

    const valueContent = memberContent.slice(contentStart, valClose).trim();
    record[fieldName]  = parseValue(valueContent);

    pos = memberEnd + 9;
  }

  return record;
}

// ─── Top-level response parser ────────────────────────────────────────────────

function parseOdooResponse(xml: string): any[] {
  const records: any[] = [];
  let pos = 0;

  while (true) {
    const structStart = xml.indexOf("<struct>", pos);
    if (structStart === -1) break;

    const contentStart = structStart + 8;
    const structEnd    = findClose(xml, contentStart, "<struct>", "</struct>");
    if (structEnd === -1) break;

    const record = parseMembersToRecord(xml.slice(contentStart, structEnd));
    if (Object.keys(record).length > 0) records.push(record);

    pos = structEnd + 9; // skip past </struct>
  }

  return records;
}
