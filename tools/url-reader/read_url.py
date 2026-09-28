#!/usr/bin/env python3
"""URL 본문을 마크다운 텍스트로 뽑아주는 리더 (표준 라이브러리만 사용).

네이버 블로그(m.blog / blog.naver.com / PostView)는 iframe 구조라 일반 크롤러가
본문을 못 읽는데, 여기서는 PostView 주소로 바꿔서 SmartEditor 본문만 추출한다.
그 외 사이트는 <article> → <main> → <body> 순으로 본문을 찾는다.

사용법:
    python3 read_url.py <URL> [--max-chars N]
"""
import argparse
import gzip
import re
import sys
import urllib.request
from html import unescape
from html.parser import HTMLParser
from urllib.parse import parse_qs, urljoin, urlparse

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr"}
BLOCK = {"p", "div", "br", "li", "ul", "ol", "tr", "table", "section",
         "article", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6"}
SKIP = {"script", "style", "noscript", "template", "svg", "button",
        "nav", "header", "footer", "aside", "form", "iframe"}


def naver_post_urls(url):
    """네이버 블로그 주소면 본문이 바로 들어있는 PostView 주소 후보를 돌려준다."""
    u = urlparse(url)
    if not u.netloc.endswith("blog.naver.com"):
        return None
    q = parse_qs(u.query)
    blog_id = (q.get("blogId") or [None])[0]
    log_no = (q.get("logNo") or [None])[0]
    if not (blog_id and log_no):
        parts = [p for p in u.path.split("/") if p]
        if len(parts) >= 2 and parts[1].isdigit():
            blog_id, log_no = parts[0], parts[1]
    if not (blog_id and log_no):
        return None
    qs = f"blogId={blog_id}&logNo={log_no}"
    return [f"https://blog.naver.com/PostView.naver?{qs}&redirect=Dlog&widgetTypeCall=true",
            f"https://m.blog.naver.com/PostView.naver?{qs}"]


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip",
        "Referer": "https://blog.naver.com/" if "naver.com" in url else url,
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        charset = r.headers.get_content_charset()
        final_url = r.geturl()
    if not charset:
        m = re.search(rb'charset=["\']?([\w-]+)', raw[:4096])
        charset = m.group(1).decode() if m else "utf-8"
    try:
        return raw.decode(charset, errors="replace"), final_url
    except LookupError:
        return raw.decode("utf-8", errors="replace"), final_url


class Extractor(HTMLParser):
    """match(tag, attrs)가 참인 첫 요소 안의 텍스트/이미지/링크를 마크다운으로 모은다."""

    def __init__(self, match, base_url):
        super().__init__(convert_charrefs=True)
        self.match = match
        self.base = base_url
        self.depth = 0       # 캡처 중인 요소 안에서의 깊이 (0이면 캡처 안 함)
        self.skip = 0        # script/style 등 무시 구간 깊이
        self.found = False
        self.out = []
        self.meta = {}
        self.title = ""
        self._in_title = False
        self._href = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            key = a.get("property") or a.get("name")
            if key and a.get("content"):
                self.meta[key] = a["content"]
        if tag == "title":
            self._in_title = True
        if not self.depth:
            if self.found or tag in VOID or not self.match(tag, a):
                return
            self.found = True
            self.depth = 1
            return
        if tag not in VOID:
            self.depth += 1
            if self.skip or tag in SKIP:
                self.skip += 1
        if self.skip:
            return
        if tag in BLOCK:
            self.out.append("\n")
        if tag in ("h1", "h2", "h3", "h4"):
            self.out.append("#" * int(tag[1]) + " ")
        elif tag == "li":
            self.out.append("- ")
        elif tag == "img":
            src = a.get("data-lazy-src") or a.get("data-src") or a.get("src") or ""
            src = src.replace("type=w80_blur", "type=w966")  # 네이버 블러 썸네일 → 원본
            if src and not src.startswith("data:"):
                self.out.append(f"\n![{a.get('alt', '')}]({urljoin(self.base, src)})\n")
        elif tag == "a" and a.get("href", "").startswith(("http", "/")):
            self._href = urljoin(self.base, a["href"])
            self.out.append("[")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if not self.depth or tag in VOID:
            return
        if self.skip:
            self.skip -= 1
        elif tag == "a" and self._href:
            self.out.append(f"]({self._href})")
            self._href = None
        elif tag in BLOCK:
            self.out.append("\n")
        self.depth -= 1

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self.depth and not self.skip:
            self.out.append(data)

    def text(self):
        s = "".join(self.out).replace("​", "").replace("\xa0", " ")
        s = re.sub(r"(?<!!)\[\s*\]\([^)]*\)", "", s)     # 텍스트 없는 링크 제거
        lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in s.split("\n")]
        s = "\n".join(lines)
        return re.sub(r"\n{3,}", "\n\n", s).strip()


def _has_class(name):
    return lambda tag, a: name in (a.get("class") or "").split()


MATCHERS = [
    _has_class("se-main-container"),                       # 네이버 SmartEditor ONE
    lambda tag, a: a.get("id") == "postViewArea",           # 네이버 구 에디터
    _has_class("se_component_wrap"),                       # 네이버 SmartEditor 3
    lambda tag, a: tag == "article",
    lambda tag, a: tag == "main",
    lambda tag, a: tag == "body",
]


def extract(html, base_url):
    for match in MATCHERS:
        p = Extractor(match, base_url)
        p.feed(html)
        body = p.text()
        if len(body) >= 50 or (p.found and match is MATCHERS[-1]):
            title = unescape(p.meta.get("og:title") or p.title).strip()
            return title, body
    return unescape(p.meta.get("og:title") or p.title).strip(), p.text()


def read_url(url, max_chars=None):
    """URL을 읽어 '# 제목\\n출처\\n\\n본문' 형태의 마크다운 문자열을 돌려준다."""
    candidates = naver_post_urls(url) or [url]
    errors = []
    for cand in candidates:
        try:
            html, final = fetch(cand)
        except Exception as e:  # noqa: BLE001 - 다음 후보로 넘어감
            errors.append(f"{cand}: {e}")
            continue
        title, body = extract(html, final)
        if body:
            if max_chars and len(body) > max_chars:
                body = body[:max_chars] + f"\n\n…(이하 생략, 총 {len(body)}자)"
            return f"# {title}\n출처: {url}\n\n{body}\n"
        errors.append(f"{cand}: 본문을 찾지 못함")
    raise RuntimeError("읽기 실패\n" + "\n".join(errors))


def main():
    ap = argparse.ArgumentParser(description="URL 본문을 마크다운으로 출력")
    ap.add_argument("url")
    ap.add_argument("--max-chars", type=int, default=None)
    args = ap.parse_args()
    try:
        sys.stdout.write(read_url(args.url, args.max_chars))
    except RuntimeError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
