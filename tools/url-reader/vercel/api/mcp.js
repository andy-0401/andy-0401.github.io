// Claude 커스텀 커넥터(원격 MCP 서버). claude.ai 웹·모바일 앱에서 URL만 주면
// 이 서버가 대신 페이지를 받아 본문 텍스트와 이미지를 Claude에게 돌려준다.
// 외부 패키지 없음 (Node 18+ fetch / TextDecoder 사용 → EUC-KR 사이트도 읽힘).

const UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const BLOCK = new Set("p div br li ul ol tr td table section article blockquote pre h1 h2 h3 h4 h5 h6 dd dt".split(" "));
const SKIP = new Set("nav header footer aside form button select iframe svg".split(" "));

const TOOL = {
  name: "read_url",
  description:
    "웹페이지 URL의 본문 텍스트와 본문 이미지(실제 이미지로 첨부 — 이미지 속 글자·표·그래프를 직접 읽을 것)를 가져온다. 네이버 블로그, 유머대학(humoruniv), " +
    "티스토리, 커뮤니티 게시글, 뉴스 등 일반 웹 가져오기로 안 읽히는 페이지도 읽는다. " +
    "사용자가 링크를 주면 캡처·PDF를 요구하지 말고 이 도구를 먼저 호출해라.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "읽을 페이지 주소" },
      include_images: { type: "boolean", description: "본문 이미지를 함께 가져와 직접 볼지 (기본 true). 이미지 속 글자·표·차트도 읽을 수 있다" },
      image_start: { type: "integer", description: "이미지가 많아 잘렸을 때 이어서 볼 이미지 번호(0부터)" },
      full_page: { type: "boolean", description: "본문 추출 대신 페이지 전체 텍스트를 받을지 (댓글 전체가 필요할 때)" },
      raw: { type: "boolean", description: "디버그용: script/style 뺀 원본 HTML (image_start 를 글자 오프셋으로 사용)" },
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
  // 커뮤니티/게시판에서 흔한 본문 컨테이너 id·class
  (n) => /^(wrap_copy|body_editor|read_body|view_content|board_content|post_content|post-content|article_body|article-body|entry-content|post-body|content_body|xe_content|view_body|rd_body|bbs_content|writing_content)$/i
    .test(n.attrs?.id || "") || (n.attrs?.class || "").split(/\s+/).some((c) => /^(body_editor|read_body|view_content|board_content|post_content|post-content|article_body|article-body|entry-content|post-body|xe_content|rd_body|writing_content)$/i.test(c)),
  (n) => n.tag === "article",
];

function imgSrc(n) {
  const a = n.attrs;
  return a["data-lazy-src"] || a["data-original"] || a["data-src"] || a.src || "";
}

// 아이콘·프로필·로딩 이미지 같은 UI 잡동사니 거르기
const JUNK_IMG = /(^|[\/_.-])(ic|icon|icons|btn|button|bg|logo|emoti\w*|sticker|loading\w*|spinner|avatar|profile|sprite|blank|spacer|arrow|thumb)([\/_.-]|$)|icon-|ic_|cmt_|sendmemo|thumb\.php|\.svg(\?|$)/i;
function isContentImg(n, body) {
  const src = imgSrc(n);
  if (!src || src.startsWith("data:") || JUNK_IMG.test(src)) return false;
  const w = parseInt(n.attrs.width, 10), h = parseInt(n.attrs.height, 10);
  if ((w && w < 80) || (h && h < 80)) return false;
  return !inCommentArea(n, body);
}

// 댓글 영역 안인가? (본문으로 고른 블록 안쪽의 "comment_*" 이름은 무시 — 웃대 등은 본문 이미지도 comment_img_div)
function inCommentArea(n, body) {
  for (let p = n.parent; p && p !== body; p = p.parent) if (isComment(p)) return true;
  return false;
}

const COMMENT_RE = /comment|cmt|reply|replies|댓글/i;
const COMMENT_UI_RE = /comment_(img|file|crop|thumb|byte)|cmt_(up|re|move|singo)/i;  // 댓글 이름이지만 본문에도 쓰이는 조각
const isComment = (n) => {
  if (!n.tag) return false;
  const name = `${n.attrs.id || ""} ${n.attrs.class || ""}`;
  return COMMENT_RE.test(name) && !COMMENT_UI_RE.test(name);
};
function inside(n, pred) {
  for (let p = n.parent; p; p = p.parent) if (pred(p)) return true;
  return false;
}

// 텍스트/이미지가 가장 많이 몰린 블록을 본문으로 본다 (링크·댓글 영역 텍스트는 제외)
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
      if (!inside(n, (p) => p.tag === "a" || SKIP.has(p.tag)) && !inCommentArea(n, null)) add(n, n.text.trim().length);
    } else if (n.tag === "img" && isContentImg(n)) {
      add(n, 300);
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

// 댓글 영역: 댓글 class/id를 가진 가장 바깥 요소들
function commentBlocks(root, body) {
  const contains = (a, b) => { for (let p = b; p; p = p.parent) if (p === a) return true; return false; };
  return [...walk(root)].filter((n) => isComment(n) && !inside(n, isComment) && !contains(body, n) && !contains(n, body));
}

// ---------- 마크다운으로 ----------

const UI_LINES = new Set("추천 반대 답글 이동 신고 추천완료 추천되었습니다. ...전체보기 스크랩 - 공유 좋아요 댓글 URL 복사".split(" "));

function toMarkdown(node, base, { withImages = true } = {}) {
  const body = node;
  const out = [];
  const images = [];
  const rec = (n) => {
    if (n.text !== undefined) return out.push(n.text);
    if (SKIP.has(n.tag)) return;
    const t = n.tag;
    if (BLOCK.has(t)) out.push("\n");
    if (/^h[1-4]$/.test(t)) out.push("#".repeat(+t[1]) + " ");
    if (t === "li") out.push("- ");
    if (withImages && (t === "img" || t === "video")) {
      let src = t === "video" ? n.attrs.poster : isContentImg(n, body) ? imgSrc(n) : "";
      if (src && !src.startsWith("data:")) {
        src = new URL(src.replace("type=w80_blur", "type=w966"), base).href;
        if (!images.includes(src)) {
          images.push(src);
          out.push(`\n[이미지 ${images.length}]\n`);
        }
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
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter((l) => !UI_LINES.has(l)).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  return { text, images };
}

// ---------- 이미지: 내려받아 Claude가 글자를 읽을 수 있는 크기로 자르기 ----------

let sharp = null;
try { sharp = require("sharp"); } catch { /* sharp 없으면 원본 그대로 */ }

const TILE_W = 1000;          // 가로 최대 폭
const TILE_H = 1400;          // 세로로 긴 이미지(캡처·짤)는 이 높이씩 잘라서 보냄
const IMAGE_BUDGET = 3_300_000; // base64 합계 (Vercel 응답 한도 4.5MB 안쪽)

async function fetchImageTiles(src, referer) {
  try {
    const r = await fetch(src, {
      headers: { "User-Agent": UA, Referer: referer, Accept: "image/avif,image/webp,image/*,*/*" },
      signal: AbortSignal.timeout(10000),
    });
    const type = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!r.ok || !type.startsWith("image/")) return [];
    const buf = Buffer.from(await r.arrayBuffer());
    if (!sharp) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(type) || buf.length > 3_000_000) return [];
      return [{ data: buf.toString("base64"), mimeType: type }];
    }
    const meta = await sharp(buf, { animated: false }).metadata();
    const w0 = meta.width, h0 = meta.pageHeight || meta.height;
    if (!w0 || !h0 || (w0 < 80 && h0 < 80)) return [];   // 아이콘 크기
    const W = Math.min(TILE_W, w0);
    const H = Math.round(h0 * (W / w0));
    const base = await sharp(buf, { animated: false })
      .flatten({ background: "#ffffff" })
      .resize({ width: W })
      .toBuffer();
    const tiles = [];
    for (let y = 0; y < H; y += TILE_H) {
      const out = await sharp(base)
        .extract({ left: 0, top: y, width: W, height: Math.min(TILE_H, H - y) })
        .jpeg({ quality: 78 })
        .toBuffer();
      tiles.push({ data: out.toString("base64"), mimeType: "image/jpeg" });
    }
    return tiles;
  } catch {
    return [];
  }
}

async function readUrl({ url, include_images = true, full_page = false, max_chars = 40000, image_start = 0, raw = false }) {
  if (!/^https?:\/\//i.test(url)) throw new Error("http(s) 주소만 읽을 수 있습니다");
  const errors = [];
  for (const cand of naverCandidates(url) || [url]) {
    let page;
    try { page = await fetchHtml(cand); } catch (e) { errors.push(`${cand}: ${e.message}`); continue; }
    if (raw) {
      const stripped = page.html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/\n\s*\n+/g, "\n");
      return [{ type: "text", text: stripped.slice(image_start, image_start + max_chars) }];
    }
    const { root, meta } = parse(page.html);
    const titleNode = [...walk(root)].find((n) => n.tag === "title");
    const title = (meta["og:title"] || (titleNode ? textOf(titleNode) : "")).trim();
    const body = pickContent(root, full_page);
    let { text, images } = toMarkdown(body, page.finalUrl);

    // 본문 블록에 이미지가 없으면(이미지 글인데 텍스트 블록만 잡힌 경우) 페이지 전체에서 본문 이미지를 찾음
    if (!images.length) {
      for (const n of walk(root)) {
        if (n.tag === "img" && isContentImg(n, null)) {
          const src = new URL(imgSrc(n).replace("type=w80_blur", "type=w966"), page.finalUrl).href;
          if (!images.includes(src)) images.push(src);
        }
      }
      if (!images.length && meta["og:image"] && !JUNK_IMG.test(meta["og:image"])) images.push(new URL(meta["og:image"], page.finalUrl).href);
      if (images.length) text = images.map((_, i) => `[이미지 ${i + 1}]`).join("\n") + (text ? "\n\n" + text : "");
    }

    // 댓글은 본문과 따로 붙임
    if (!full_page) {
      const cmt = commentBlocks(root, body)
        .map((n) => toMarkdown(n, page.finalUrl, { withImages: false }).text).filter(Boolean).join("\n\n");
      if (cmt) text += `\n\n---\n## 댓글\n${cmt.slice(0, 8000)}${cmt.length > 8000 ? "\n…(댓글 더 있음: full_page=true)" : ""}`;
    }

    if (!text && !images.length) { errors.push(`${cand}: 본문을 찾지 못함`); continue; }
    if (text.length > max_chars) text = text.slice(0, max_chars) + `\n\n…(이하 생략, 총 ${text.length}자)`;
    const content = [{ type: "text", text: `# ${title}\n출처: ${url}\n\n${text}` }];

    if (include_images && images.length) {
      const list = images.slice(image_start);
      const tilesPer = await Promise.all(list.slice(0, 20).map((s) => fetchImageTiles(s, page.finalUrl)));
      let used = 0, shown = 0;
      for (let i = 0; i < tilesPer.length; i++) {
        const tiles = tilesPer[i];
        const size = tiles.reduce((a, t) => a + t.data.length, 0);
        if (shown && used + size > IMAGE_BUDGET) break;
        const no = image_start + i + 1;
        content.push({ type: "text", text: tiles.length ? `[이미지 ${no}]${tiles.length > 1 ? ` (세로로 긴 이미지라 ${tiles.length}조각으로 나눔, 위→아래 순서)` : ""}` : `[이미지 ${no}] 가져오기 실패: ${list[i]}` });
        for (const t of tiles) content.push({ type: "image", data: t.data, mimeType: t.mimeType });
        used += size;
        shown++;
      }
      const next = image_start + shown;
      if (next < images.length) {
        content.push({ type: "text", text: `(이미지 ${images.length}장 중 ${image_start + 1}~${next}번까지 첨부. 나머지는 image_start=${next} 로 다시 호출)` });
      }
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
