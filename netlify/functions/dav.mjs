// Server CalDAV minimale su Netlify Functions + Netlify Blobs.
// Endpoint: /dav/  (principal + calendar-home)   /dav/<cal>/  (calendario)   /dav/<cal>/<uid>.ics (evento)
// Auth: Basic con DAV_USER / DAV_PASS (env). Un solo utente, prototipo: niente ACL, niente expand, niente sync-token.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const USER = process.env.DAV_USER || "demo";
const PASS = process.env.DAV_PASS || "demo";
const BASE = "/dav";
const ALLOW = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOW,
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Depth, If-Match, If-None-Match, Prefer",
  "Access-Control-Expose-Headers": "ETag, DAV, Allow",
  "Access-Control-Max-Age": "86400",
};
const store = () => getStore("caldav");
const hash = (s) => '"' + createHash("sha1").update(s).digest("hex").slice(0, 20) + '"';
const X = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const res = (status, body = null, headers = {}) => new Response(body, { status, headers: { ...CORS, ...headers } });
const xml = (status, body) => res(status, body, { "Content-Type": "application/xml; charset=utf-8" });
const ms = (inner) => `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">${inner}</d:multistatus>`;
const rsp = (href, props, status = "HTTP/1.1 200 OK") =>
  `<d:response><d:href>${X(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>${status}</d:status></d:propstat></d:response>`;

function authOk(req) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, ...p] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
  return u === USER && p.join(":") === PASS;
}

/* ---- storage helpers ---- */
async function listCalendars() {
  const { blobs } = await store().list();
  const cals = [...new Set(blobs.filter((b) => b.key.endsWith("/_meta.json")).map((b) => b.key.split("/")[0]))];
  if (!cals.length) { await store().setJSON("personale/_meta.json", { name: "Personale", color: "#2f6df6" }); cals.push("personale"); }
  return cals;
}
const meta = async (cal) => (await store().get(`${cal}/_meta.json`, { type: "json" })) || null;
async function listObjects(cal) {
  const { blobs } = await store().list({ prefix: `${cal}/` });
  const keys = blobs.map((b) => b.key).filter((k) => k.endsWith(".ics"));
  return Promise.all(keys.map(async (k) => { const text = await store().get(k); return { name: k.slice(cal.length + 1), text, etag: hash(text) }; }));
}

/* ---- prop fragments ---- */
const rootProps = () =>
  `<d:resourcetype><d:collection/><d:principal/></d:resourcetype><d:displayname>${X(USER)}</d:displayname>` +
  `<d:current-user-principal><d:href>${BASE}/</d:href></d:current-user-principal>` +
  `<c:calendar-home-set><d:href>${BASE}/</d:href></c:calendar-home-set>` +
  `<d:owner><d:href>${BASE}/</d:href></d:owner>`;
async function calProps(cal, m) {
  const objs = await listObjects(cal);
  const ctag = hash(objs.map((o) => o.etag).sort().join());
  return `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${X(m.name || cal)}</d:displayname>` +
    `<ic:calendar-color>${X(m.color || "#2f6df6")}</ic:calendar-color><cs:getctag>${X(ctag)}</cs:getctag>` +
    `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>` +
    `<d:current-user-privilege-set><d:privilege><d:all/></d:privilege></d:current-user-privilege-set><d:owner><d:href>${BASE}/</d:href></d:owner>`;
}
const objProps = (o, withData) =>
  `<d:resourcetype/><d:getetag>${X(o.etag)}</d:getetag><d:getcontenttype>text/calendar; charset=utf-8</d:getcontenttype>` +
  (withData ? `<c:calendar-data>${X(o.text)}</c:calendar-data>` : "");

/* ---- ICS: intervallo evento per il filtro time-range ---- */
function icsRange(text) {
  const t = text.replace(/\r?\n[ \t]/g, "");
  const get = (n) => { const m = t.match(new RegExp(`^${n}[;:][^\\n]*`, "m")); return m ? m[0].split(":").slice(1).join(":").trim() : null; };
  const toDate = (v) => {
    if (!v) return null;
    const m = v.match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/);
    if (!m) return null;
    return m[7] || !m[4] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)))
                         : new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  };
  const start = toDate(get("DTSTART"));
  let end = toDate(get("DTEND"));
  if (start && !end) {
    const d = get("DURATION"), m = d && d.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
    end = new Date(+start + (m ? (+m[1] || 0) * 864e5 + (+m[2] || 0) * 36e5 + (+m[3] || 0) * 6e4 : 864e5));
  }
  return { start, end, recurring: /^RRULE[;:]/m.test(t) };
}
const utc = (s) => { const m = s.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null; };

/* ---- handler ---- */
export default async (req) => {
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") return res(204, null, { DAV: "1, 3, calendar-access", Allow: ALLOW });
  if (!authOk(req)) return res(401, "Unauthorized", { "WWW-Authenticate": 'Basic realm="caldav"' });

  const path = decodeURIComponent(new URL(req.url).pathname);
  const rel = path.slice(BASE.length).replace(/^\/+/, "");
  const parts = rel.split("/").filter(Boolean);
  const isRoot = parts.length === 0;
  const cal = parts[0];
  const obj = parts.length === 2 && !rel.endsWith("/") ? parts[1] : null;
  if (parts.length > 2 || (parts.length === 2 && !obj) || (obj && !/^[\w.@-]+\.ics$/i.test(obj)) || (cal && !/^[\w-]+$/.test(cal)))
    return res(404, "Not found");
  const depth = req.headers.get("depth") ?? "1";
  const body = ["GET", "HEAD", "DELETE"].includes(method) ? "" : await req.text();

  if (method === "PROPFIND") {
    if (isRoot) {
      let out = rsp(`${BASE}/`, rootProps());
      if (depth !== "0") for (const c of await listCalendars()) out += rsp(`${BASE}/${c}/`, await calProps(c, (await meta(c)) || {}));
      return xml(207, ms(out));
    }
    const m = await meta(cal);
    if (!m) return res(404, "Not found");
    if (obj) {
      const text = await store().get(`${cal}/${obj}`);
      return text ? xml(207, ms(rsp(path, objProps({ text, etag: hash(text) }, false)))) : res(404, "Not found");
    }
    let out = rsp(`${BASE}/${cal}/`, await calProps(cal, m));
    if (depth !== "0") for (const o of await listObjects(cal)) out += rsp(`${BASE}/${cal}/${o.name}`, objProps(o, false));
    return xml(207, ms(out));
  }

  if (method === "REPORT") {
    if (!cal || obj || !(await meta(cal))) return res(404, "Not found");
    const objs = await listObjects(cal);
    let sel = objs;
    if (/calendar-multiget/.test(body)) {
      const hrefs = [...body.matchAll(/<[^>]*\bhref[^>]*>([^<]+)</gi)].map((m) => decodeURIComponent(m[1].trim()));
      sel = objs.filter((o) => hrefs.some((h) => h.endsWith(`/${cal}/${o.name}`)));
    } else {
      const tr = body.match(/<[^>]*time-range[^>]*>/i)?.[0];
      if (tr) {
        const s = utc(tr.match(/start="([^"]+)"/)?.[1] || ""), e = utc(tr.match(/end="([^"]+)"/)?.[1] || "");
        sel = objs.filter((o) => { const r = icsRange(o.text); return r.recurring || !r.start || ((!e || r.start < e) && (!s || r.end > s)); });
      }
    }
    return xml(207, ms(sel.map((o) => rsp(`${BASE}/${cal}/${o.name}`, objProps(o, true))).join("")));
  }

  if (method === "MKCALENDAR") {
    if (!cal || obj) return res(403, "Forbidden");
    if (await meta(cal)) return res(405, "Already exists");
    const name = body.match(/displayname[^>]*>([^<]*)</i)?.[1] || cal;
    const color = body.match(/calendar-color[^>]*>([^<]*)</i)?.[1] || "#2f6df6";
    await store().setJSON(`${cal}/_meta.json`, { name, color });
    return res(201, null);
  }

  if (method === "PROPPATCH") {
    if (!cal || obj) return res(403, "Forbidden");
    const m = await meta(cal);
    if (!m) return res(404, "Not found");
    const name = body.match(/displayname[^>]*>([^<]*)</i)?.[1], color = body.match(/calendar-color[^>]*>([^<]*)</i)?.[1];
    await store().setJSON(`${cal}/_meta.json`, { name: name ?? m.name, color: color ?? m.color });
    return xml(207, ms(rsp(`${BASE}/${cal}/`, `<d:displayname/><ic:calendar-color/>`)));
  }

  if (method === "GET" || method === "HEAD") {
    if (!obj) return res(isRoot || cal ? 200 : 404, isRoot ? `CalDAV prototipo. Principal: ${BASE}/` : "", { "Content-Type": "text/plain" });
    const text = await store().get(`${cal}/${obj}`);
    if (text === null) return res(404, "Not found");
    return res(200, method === "GET" ? text : null, { "Content-Type": "text/calendar; charset=utf-8", ETag: hash(text) });
  }

  if (method === "PUT") {
    if (!obj || !(await meta(cal))) return res(404, "Not found");
    if (!/BEGIN:VCALENDAR/.test(body) || !/BEGIN:VEVENT/.test(body)) return res(415, "Serve un VCALENDAR con VEVENT");
    const key = `${cal}/${obj}`, cur = await store().get(key);
    if (req.headers.get("if-none-match") === "*" && cur !== null) return res(412, "Esiste già");
    const im = req.headers.get("if-match");
    if (im && (cur === null || im !== hash(cur))) return res(412, "ETag non corrisponde");
    await store().set(key, body);
    return res(cur === null ? 201 : 204, null, { ETag: hash(body) });
  }

  if (method === "DELETE") {
    if (isRoot) return res(403, "Forbidden");
    if (obj) {
      const key = `${cal}/${obj}`, cur = await store().get(key);
      if (cur === null) return res(404, "Not found");
      const im = req.headers.get("if-match");
      if (im && im !== hash(cur)) return res(412, "ETag non corrisponde");
      await store().delete(key);
      return res(204, null);
    }
    if (!(await meta(cal))) return res(404, "Not found");
    const { blobs } = await store().list({ prefix: `${cal}/` });
    await Promise.all(blobs.map((b) => store().delete(b.key)));
    return res(204, null);
  }

  return res(405, "Method not allowed", { Allow: ALLOW });
};

export const config = { path: ["/dav", "/dav/*"] };
