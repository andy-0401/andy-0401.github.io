---
name: read-url
description: 사용자가 웹페이지 URL(특히 네이버 블로그 m.blog.naver.com / blog.naver.com, 티스토리, 브런치, 뉴스 기사)을 주고 읽기·요약·분석을 요청할 때 사용. WebFetch가 막히거나 본문이 비어 있을 때 로컬 스크립트로 본문을 가져온다. 캡처나 PDF를 요구하지 말 것.
---

# URL 본문 읽기

1. 이 스킬 폴더 기준 스크립트 위치를 찾는다:
   - 프로젝트 안: `tools/url-reader/read_url.py`
   - 개인 설치: `~/.claude/tools/url-reader/read_url.py`
2. 실행한다 (표준 라이브러리만 쓰므로 설치 불필요):

   ```bash
   python3 <경로>/read_url.py "<URL>"
   ```

   너무 길면 `--max-chars 30000` 을 붙인다.
3. 출력된 마크다운(제목·출처·본문·이미지 링크)을 근거로 사용자의 요청에 답한다.
   이미지 속 글자(차트, 표 캡처)가 중요하면 이미지 URL을 알려주고, 필요하면 그 이미지만 받아서 확인한다.
4. 실패 시:
   - `403` / `Tunnel connection failed` → 실행 환경의 네트워크가 해당 도메인을 막은 것. 클라우드 세션이면 환경 설정의 Network access에 `blog.naver.com`, `m.blog.naver.com`, `postfiles.pstatic.net` 을 허용하도록 안내한다.
   - 비공개/서로이웃 공개 글, 네이버 카페 글은 로그인이 필요해 읽을 수 없다 → 북마클릿(`tools/url-reader/bookmarklet.js`)으로 복사해 붙여넣도록 안내한다.
