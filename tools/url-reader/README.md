# url-reader: 링크만 주면 Claude가 글을 읽게 하는 도구

네이버 블로그는 본문이 iframe 안에 있고, Claude의 기본 웹 가져오기(WebFetch)는
`blog.naver.com` / `m.blog.naver.com` 를 **아예 읽지 못합니다**. 그래서 그동안 캡처나 PDF를 줘야 했던 것.
이 도구는 **내 컴퓨터에서** 네이버 PostView 주소로 바로 요청해 본문만 마크다운으로 뽑습니다.
(파이썬 3.8+ 표준 라이브러리만 사용, 설치할 패키지 없음)

## 📱 폰 Claude 앱에서 링크만 주면 읽게 하기 (추천)

폰의 Claude 앱은 인터넷에 떠 있는 "커넥터"만 쓸 수 있어서, 무료 서버(Vercel)에 리더를 한 번 올려두고 커넥터로 등록합니다.
**최초 1회 5분**이면 되고, 이후엔 모든 채팅에서 링크만 붙여넣으면 끝. 폰 브라우저만으로 가능합니다.

1. 아래 버튼 누르기 → GitHub 계정으로 Vercel 로그인
   → **Deploy** (다른 입력 없음)

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fandy-0401%2Fandy-0401.github.io%2Ftree%2Fmain%2Ftools%2Furl-reader%2Fvercel&project-name=url-reader&repository-name=url-reader))

2. 배포가 끝나면 나오는 주소(예: `https://url-reader-abc.vercel.app`)를 복사
3. 폰 브라우저에서 **claude.ai → 설정 → 커넥터 → 커스텀 커넥터 추가**
   - 이름: `URL 리더`
   - URL: `https://url-reader-abc.vercel.app/mcp` (2번 주소 + `/mcp`)
   - (선택) 남이 못 쓰게 하려면 Vercel 프로젝트 설정에 환경변수 `ACCESS_KEY` 를 넣고 URL 끝에 `?key=그값` 을 붙이세요
4. **설정 → 프로필 → "Claude가 고려해야 할 개인 선호사항"** 에 아래 문장을 넣고 저장
   (안 넣으면 클로드가 기본 웹 가져오기를 먼저 써서 웃대·네이버에서 막힐 수 있음)

   ```
   내가 링크(URL)를 주면 기본 웹 가져오기 말고 항상 "URL 리더" 커넥터의 read_url 도구로 먼저 읽어. 이미지 속 글자·표·차트도 읽어서 반영해.
   ```

5. 끝. 새 채팅에서 `이거 읽어줘 https://m.humoruniv.com/...` 처럼 링크만 주면 됩니다.
   (처음 한 번 도구 사용 허락을 물으면 "항상 허용". 채팅창 + → 커넥터에서 URL 리더가 켜져 있어야 함)

> 배포된 서버 코드는 `andy-0401/url-reader` 저장소에 있고, 거기 main에 푸시하면 Vercel이 자동 재배포합니다.

본문 텍스트 + 댓글 + 본문 이미지를 Claude가 직접 봅니다. 세로로 긴 캡처는 조각으로 나눠 보내 글자까지 읽히고, 아이콘·프로필 사진은 걸러집니다. EUC-KR 인코딩 사이트(웃대 등)도 읽힙니다.
댓글까지 보고 싶으면 "댓글까지 전체로 읽어줘"라고 하면 `full_page` 로 읽습니다.

## 그 밖의 사용처

| 어디서 쓰나 | 방법 | 설정 |
|---|---|---|
| Claude Code (내 PC 터미널) | 스킬 + 스크립트 | 아래 ① |
| Claude Desktop 앱의 채팅 | MCP 서버 | 아래 ② |
| claude.ai 웹/모바일 채팅 | 북마클릿으로 복사 → 붙여넣기 | 아래 ③ |
| Claude Code 웹(클라우드 세션) | 네트워크 허용 도메인 추가 | 아래 ④ |

## 바로 써보기

```bash
python3 tools/url-reader/read_url.py "https://m.blog.naver.com/egzion/224424473154"
```

제목, 출처, 본문(링크 포함), 이미지 URL이 마크다운으로 출력됩니다.
`blog.naver.com/아이디/글번호`, `m.blog.naver.com/...`, `PostView.naver?blogId=..&logNo=..` 모두 지원.
네이버가 아닌 사이트(티스토리, 브런치, 뉴스 등)는 `<article>` → `<main>` → `<body>` 순으로 본문을 찾습니다.

## ① Claude Code에서 항상 쓰기 (모든 프로젝트)

```bash
mkdir -p ~/.claude/tools ~/.claude/skills
cp -r tools/url-reader ~/.claude/tools/
cp -r .claude/skills/read-url ~/.claude/skills/
```

이제 어느 폴더에서든 `이 글 요약해줘 https://m.blog.naver.com/...` 라고만 하면
Claude Code가 `read-url` 스킬로 본문을 읽습니다. (이 저장소 안에서는 복사 없이도 동작)

더 확실하게 하려면 MCP 도구로도 등록하세요:

```bash
claude mcp add --scope user url-reader -- python3 ~/.claude/tools/url-reader/mcp_server.py
```

## ② Claude Desktop 앱 채팅에서 쓰기

1. 위 ①의 `cp` 로 `~/.claude/tools/url-reader` 에 복사 (또는 원하는 위치)
2. Claude Desktop → 설정 → 개발자 → **구성 편집** 으로 `claude_desktop_config.json` 을 열고 추가:

```json
{
  "mcpServers": {
    "url-reader": {
      "command": "python3",
      "args": ["/Users/내이름/.claude/tools/url-reader/mcp_server.py"]
    }
  }
}
```

   - 경로는 **절대경로**로. Windows는 `"command": "python"`, 경로는 `"C:\\Users\\내이름\\.claude\\tools\\url-reader\\mcp_server.py"`
3. 앱 재시작 → 채팅에 URL만 붙여넣으면 `read_url` 도구로 읽습니다.

## ③ claude.ai 웹 / 모바일 채팅 (설치 없이)

claude.ai 웹 채팅은 내 PC의 프로그램을 실행할 수 없고 네이버도 못 읽으므로, 브라우저에서 복사해 넣는 게 가장 간단합니다.

1. 브라우저에 새 북마크를 만들고, 이름은 `Claude로 복사`, URL 칸에는 `bookmarklet.js` 의
   `javascript:` 로 시작하는 줄을 통째로 붙여넣기
2. 네이버 블로그 글을 연 상태에서 그 북마크 클릭 → "복사 완료" 알림
3. Claude 채팅창에 붙여넣기 (Ctrl/Cmd+V)

모바일 크롬도 가능합니다: 북마크 저장 후 주소창에 북마크 이름을 입력해서 선택.
비공개·서로이웃 글처럼 로그인이 필요한 글도 이 방법이면 됩니다.

## ④ Claude Code 웹(클라우드 세션)에서 쓰기

클라우드 세션은 네트워크 정책 때문에 기본적으로 네이버 접속이 막혀 있습니다.
세션 제목줄의 환경 메뉴 → **Edit** → *Network access* 에서 접근 수준을 넓히거나
허용 도메인에 아래를 추가하면 이 저장소의 `read-url` 스킬이 그대로 동작합니다.

```
blog.naver.com
m.blog.naver.com
postfiles.pstatic.net
```

## 한계

- 네이버 **카페** 글, 비공개 글은 로그인이 필요해 스크립트로는 못 읽음 → ③ 북마클릿 사용
- 본문 속 **이미지 안의 글자**(차트·표 캡처)는 텍스트로 안 나옴 → 이미지 URL이 함께 출력되니 필요하면 그 이미지만 Claude에게 보여주면 됨
