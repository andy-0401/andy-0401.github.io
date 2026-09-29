// Claude 커스텀 커넥터(원격 MCP 서버). claude.ai 웹·모바일 앱에서 URL만 주면
// 이 서버가 대신 페이지를 받아 본문 텍스트와 이미지를 Claude에게 돌려준다.
// 외부 패키지 없음 (Node 18+ fetch / TextDecoder 사용 → EUC-KR 사이트도 읽힘).

const UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const BLOCK = new Set("p div br li ul ol tr td table section article blockquote pre h1 h2 h3 h4 h5 h6 dd dt".split(" "));
const SKIP = new Set("nav header footer aside form button select iframe svg".split(" "));
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 3_000_000;

const TOOL = {
  name: "read_url",
  description:
    "웹페이지 URL의 본문 텍스트와 본문 이미지를 가져온다. 네이버 블로그, 유머대학(humoruniv), " +
    "티스토리, 커뮤니티 게시글, 뉴스 등 일반 웹 가져오기로 안 읽히는 페이지도 읽는다. " +
    "사용자가 링크를 주면 캡처·PDF를 요구하지 말고 이 도구를 먼저 호출해라.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "읽을 페이지 주소" },
      include_images: { type: "boolean", description: "본문 이미지를 함께 가져올지 (기본 true, 최대 6장)" },
      full_page: { type: "boolean", description: "본문 추출 대신 페이지 전체 텍스트(댓글 포함)를 받을지" },
      max_chars: { type: "integer", description: "텍스트 최대 글자 수 (기본 40000)" },
    },
    required: ["url"],
  },
};

// ---------- 가져오기 ----------

function naverCandidates(url) {
  const u = new URL(url);
  if (!u.hostname.endsWith("blog.naver.com")) return null;
  let id = u.searchParams.get("blogId");
  let no = u.searchParams.get("logNo");
  if (!(id && no)) {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) [id, no] = parts;
  }
  if (!(id && no)) return null;
  const qs = `blogId=${id}&logNo=${no}`;
  return [
    `https://m.blog.naver.com/PostView.naver?${qs}`,
    `https://blog.naver.com/PostView.naver?${qs}&redirect=Dlog&widgetTypeCall=true`,
  ];
}

async function fetchHtml(url) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      Referer: new URL(url).origin + "/",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  let charset = (r.headers.get("content-type") || "").match(/charset=([\w-]+)/i)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    charset = head.match(/charset=["']?([\w-]+)/i)?.[1] || "utf-8";
  }
  let html;
  try { html = new TextDecoder(charset.toLowerCase()).decode(buf); }
  catch { html = new TextDecoder("utf-8").decode(buf); }
  return { html, finalUrl: r.url || url };
}

// ---------- 아주 작은 HTML 파서 → 트리 ----------

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(s) {
  const a = {};
  for (const m of s.matchAll(/([^\s=\/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    a[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return a;
}

function parse(html) {
  html = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "");
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  const meta = {};
  let cur = root;
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
  for (const m of html.matchAll(re)) {
    if (m[4] !== undefined || (!m[2] && m[0] === "<")) {
      const text = decode(m[4] ?? "<");
      cur.children.push({ text, parent: cur });
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      // 닫는 태그: 가장 가까운 같은 태그까지 올라감 (없으면 무시)
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    const attrs = parseAttrs(m[3]);
    if (tag === "meta") {
      const k = attrs.property || attrs.name;
      if (k && attrs.content) meta[k] = attrs.content;
    }
    // <p> 안에 블록이 오면 p를 닫는 정도의 최소 보정
    if ((tag === "p" || tag === "li") && cur.tag === tag) cur = cur.parent;
    const node = { tag, attrs, children: [], parent: cur };
    cur.children.push(node);
    if (!VOID.has(tag) && !m[3].trim().endsWith("/")) cur = node;
  }
  return { root, meta };
}

function* walk(n) {
  yield n;
  for (const c of n.children || []) yield* walk(c);
}
const hasClass = (n, c) => (n.attrs?.class || "").split(/\s+/).includes(c);
const textOf = (n) => (n.text !== undefined ? n.text : (n.children || []).map(textOf).join(""));

// ---------- 본문 고르기 ----------

const MATCHERS = [
  (n) => hasClass(n, "se-main-container"),   // 네이버 SmartEditor ONE
  (n) => n.attrs?.id === "postViewArea",     // 네이버 구 에디터
  (n) => hasClass(n, "se_component_wrap"),   // 네이버 SmartEditor 3
  (n) => hasClass(n, "tt_article_useless_p_margin") || hasClass(n, "article_view"), // 티스토리
  (n) => n.tag === "article",
];

function imgSrc(n) {
  const a = n.attrs;
  return a["data-lazy-src"] || a["data-original"] || a["data-src"] || a.src || "";
}

// 텍스트/이미지가 가장 많이 몰린 블록을 본문으로 본다 (링크 텍스트는 제외)
function bestBlock(root) {
  const score = new Map();
  const add = (n, v) => {
    for (let p = n.parent, k = 1; p && k <= 3; p = p.parent) {
      if (BLOCK.has(p.tag) || p.tag === "body") {
        score.set(p, (score.get(p) || 0) + v / k);
        k++;
      }
    }
  };
  for (const n of walk(root)) {
    if (n.text !== undefined) {
      let inLink = false, skipped = false;
      for (let p = n.parent; p; p = p.parent) {
        if (p.tag === "a") inLink = true;
        if (SKIP.has(p.tag)) skipped = true;
      }
      if (!inLink && !skipped) add(n, n.text.trim().length);
    } else if (n.tag === "img" && /^(https?:|\/)/.test(imgSrc(n))) {
      add(n, 80);
    }
  }
  let best = null, bestScore = 0;
  for (const [n, s] of score) if (s > bestScore) [best, bestScore] = [n, s];
  return best || root;
}

function pickContent(root, fullPage) {
  if (fullPage) return [...walk(root)].find((n) => n.tag === "body") || root;
  for (const m of MATCHERS) {
    const n = [...walk(root)].find((x) => x.tag && m(x));
    if (n && textOf(n).trim().length + n.children.length >= 30) return n;
  }
  return bestBlock(root);
}

// ---------- 마크다운으로 ----------

function toMarkdown(node, base) {
  const out = [];
  const images = [];
  const rec = (n) => {
    if (n.text !== undefined) return out.push(n.text);
    if (SKIP.has(n.tag)) return;
    const t = n.tag;
    if (BLOCK.has(t)) out.push("\n");
    if (/^h[1-4]$/.test(t)) out.push("#".repeat(+t[1]) + " ");
    if (t === "li") out.push("- ");
    if (t === "img" || t === "video") {
      let src = t === "video" ? n.attrs.poster || n.attrs.src : imgSrc(n);
      if (src && !src.startsWith("data:")) {
        src = new URL(src.replace("type=w80_blur", "type=w966"), base).href;
        images.push(src);
        out.push(`\n[이미지 ${images.length}](${src})\n`);
      }
    }
    const href = t === "a" && n.attrs.href && !n.attrs.href.startsWith("javascript") ? n.attrs.href : null;
    const start = out.length;
    for (const c of n.children) rec(c);
    if (href) {
      const inner = out.splice(start).join("").trim();
      if (inner) out.push(inner.includes("[이미지") ? inner : `[${inner}](${new URL(href, base).href})`);
    }
    if (BLOCK.has(t)) out.push("\n");
  };
  rec(node);
  const text = out.join("")
    .replace(/[​﻿]/g, "").replace(/ /g, " ")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  return { text, images };
}

async function fetchImage(src, referer) {
  try {
    const r = await fetch(src, {
      headers: { "User-Agent": UA, Referer: referer, Accept: "image/*" },
      signal: AbortSignal.timeout(8000),
    });
    const type = (r.headers.get("content-type") || "").split(";")[0];
    if (!r.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return { type: "image", data: buf.toString("base64"), mimeType: type };
  } catch {
    return null;
  }
}

async function readUrl({ url, include_images = true, full_page = false, max_chars = 40000 }) {
  if (!/^https?:\/\//i.test(url)) throw new Error("http(s) 주소만 읽을 수 있습니다");
  const errors = [];
  for (const cand of naverCandidates(url) || [url]) {
    let page;
    try { page = await fetchHtml(cand); } catch (e) { errors.push(`${cand}: ${e.message}`); continue; }
    const { root, meta } = parse(page.html);
    const titleNode = [...walk(root)].find((n) => n.tag === "title");
    const title = (meta["og:title"] || (titleNode ? textOf(titleNode) : "")).trim();
    let { text, images } = toMarkdown(pickContent(root, full_page), page.finalUrl);
    if (!text && !images.length) { errors.push(`${cand}: 본문을 찾지 못함`); continue; }
    if (text.length > max_chars) text = text.slice(0, max_chars) + `\n\n…(이하 생략, 총 ${text.length}자)`;
    const content = [{ type: "text", text: `# ${title}\n출처: ${url}\n\n${text}` }];
    if (include_images && images.length) {
      const got = (await Promise.all(images.slice(0, MAX_IMAGES).map((s) => fetchImage(s, page.finalUrl)))).filter(Boolean);
      let total = 0;
      for (const img of got) {
        total += img.data.length;
        if (total > 3_500_000) break;   // Vercel 응답 한도(4.5MB) 안쪽
        content.push(img);
      }
      if (images.length > MAX_IMAGES) content.push({ type: "text", text: `(이미지 ${images.length}장 중 ${MAX_IMAGES}장만 첨부)` });
    }
    return content;
  }
  throw new Error("읽기 실패\n" + errors.join("\n"));
}

// ---------- MCP (Streamable HTTP, JSON 응답) ----------

async function handleRpc(msg) {
  const { method, params = {} } = msg;
  if (method === "initialize") {
    return {
      protocolVersion: params.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "url-reader", version: "1.0.0" },
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: [TOOL] };
  if (method === "tools/call") {
    try {
      return { content: await readUrl(params.arguments || {}) };
    } catch (e) {
      return { content: [{ type: "text", text: String(e.message || e) }], isError: true };
    }
  }
  const err = new Error(`Method not found: ${method}`);
  err.code = -32601;
  throw err;
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handler(req, res) {
  const key = process.env.ACCESS_KEY;
  const reqKey = new URL(req.url, "http://x").searchParams.get("key");
  if (key && reqKey !== key) return res.status(401).json({ error: "bad key" });
  if (req.method === "GET") {
    return res.status(200).send("url-reader MCP 서버 동작 중. Claude 커넥터 URL로 이 주소를 넣으세요.");
  }
  if (req.method !== "POST") return res.status(405).end();

  let body;
  try { body = await readBody(req); } catch { return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const msgs = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of msgs) {
    if (msg.id === undefined) continue;          // notification
    try {
      replies.push({ jsonrpc: "2.0", id: msg.id, result: await handleRpc(msg) });
    } catch (e) {
      replies.push({ jsonrpc: "2.0", id: msg.id, error: { code: e.code || -32603, message: e.message } });
    }
  }
  if (!replies.length) return res.status(202).end();
  res.setHeader("Content-Type", "application/json");
  return res.status(200).send(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
}

module.exports = handler;
module.exports.readUrl = readUrl;
module.exports.parse = parse;
module.exports.pickContent = pickContent;
module.exports.toMarkdown = toMarkdown;
