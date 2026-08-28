# EML 홈페이지 관리자 운영 가이드

이 문서는 홈페이지 콘텐츠 담당자가 Supabase나 별도 데이터베이스 없이 홈페이지를 안전하게 수정하는 절차를 설명합니다. 콘텐츠의 원본은 GitHub 저장소의 `eml_website/data/site-data.json`이며, 화면용 `site-data.js`와 업로드 이미지는 관리 도구가 함께 관리합니다.

## 운영 방식 요약

관리 화면은 두 가지 방식으로 사용할 수 있습니다.

| 방식 | 접속 위치 | 저장 결과 | 권장 용도 |
| --- | --- | --- | --- |
| 로컬 Git 편집 | `http://127.0.0.1:8767/admin.html` | 현재 작업 브랜치의 파일 변경 | 검토·PR이 필요한 일반 운영 |
| 배포 관리자 | `https://홈페이지주소/admin.html` | GitHub `develop`에 원자적 commit | 권한 있는 관리자의 긴급·간단 수정 |

두 방식 모두 같은 데이터 형식과 검증 규칙을 사용합니다. Supabase 프로젝트, SQL 실행, Supabase URL 또는 key는 필요하지 않습니다.

## 관리되는 파일

- `eml_website/data/site-data.json`: 사람이 검토하는 콘텐츠 원본
- `eml_website/data/site-data.js`: 홈페이지가 읽는 결정적 생성 파일
- `eml_website/assets/uploads/YYYY-MM-DD/`: 관리 화면에서 추가한 이미지
- `eml_website/admin.html`, `admin.js`, `admin.css`, `local-content-store.js`: 관리자 화면 코드
- `eml_website/worker.js`, `functions/`: 배포 관리자용 GitHub 인증·게시 Worker API

관리자 코드와 콘텐츠 파일은 다른 담당자에게 인계되어야 하므로 Git에서 제외하면 안 됩니다. 비밀번호, GitHub token, `SESSION_SECRET`, `.dev.vars`는 반대로 절대 commit하지 않습니다.

## 1. 로컬 관리자 사용

### 준비물

- Git
- Node.js 20 이상(Node.js 22 권장)
- `Energy-Materials/EML-website` 저장소 읽기·쓰기 권한
- 최신 웹 브라우저

### 작업 브랜치 만들기

저장소 루트에서 다음 순서로 시작합니다.

```powershell
cd C:\jun
git switch develop
git pull --ff-only origin develop
git switch -c content/2026-08-27-update
cd eml_website
```

브랜치 이름의 날짜와 설명은 실제 작업에 맞게 바꿉니다. 여러 담당자가 동시에 `develop`을 직접 수정하지 않도록 로컬 작업은 항상 별도 브랜치에서 진행합니다.

### 관리자 화면 실행

Windows에서는 다음 파일을 실행하는 것이 가장 간단합니다.

```powershell
.\admin-local.cmd
```

또는 직접 서버를 실행할 수 있습니다.

```powershell
npm run admin
```

직접 실행한 경우 브라우저에서 `http://127.0.0.1:8767/admin.html`을 엽니다. 서버는 loopback 주소에만 열리므로 같은 컴퓨터 밖에서는 접근할 수 없습니다. `admin.html`을 `file://`로 직접 열면 저장 기능이 동작하지 않습니다.

### 콘텐츠 수정과 저장

1. 왼쪽 메뉴에서 수정할 영역을 선택합니다.
2. 텍스트, 구성원, 연구 주제, 논문, 특허 또는 갤러리를 수정합니다.
3. 갤러리 제목과 Summary/Detail Body에 사진의 행사·인물·상황이 이해되도록 설명을 작성합니다.
4. `Save Changes`를 누릅니다.
5. 상단 상태가 저장 완료로 바뀌었는지 확인합니다.
6. `Preview Site`에서 실제 홈페이지 표현을 확인합니다.

로컬에서 선택한 새 이미지는 `Save Changes`를 누를 때 `assets/uploads/YYYY-MM-DD/`에 파일로 생성되고 JSON과 JS 경로도 함께 갱신됩니다. 저장 전 브라우저 초안은 실제 파일이 아니므로 창을 닫기 전에 반드시 저장 상태를 확인합니다.

### 저장 규칙

- 갤러리 항목에는 이미지가 최소 1장 있어야 합니다.
- 갤러리 대표 이미지 `image`는 `images`의 첫 번째 이미지와 항상 같아야 하며 관리 화면이 자동으로 맞춥니다.
- 논문 번호는 1 이상의 정수이며 서로 중복될 수 없습니다.
- 논문의 연도, 제목, 저자, 저널은 비워둘 수 없습니다.
- 갤러리 날짜와 제목은 필수입니다.
- 이미지 경로는 프로젝트의 `assets/` 아래 안전한 상대 경로만 허용됩니다.
- 브라우저는 일반 JPG/PNG/WebP를 약 700KB 목표로 자동 최적화합니다. 원격 게시의 hard limit은 이미지 1장당 2MB, 한 번의 저장에 신규 이미지 합계 8MB, 최대 10장, 전체 요청 12MB입니다. GIF는 애니메이션 보존을 위해 자동 압축하지 않으므로 처음부터 2MB 이하여야 하며, 여러 장이면 나누어 게시합니다.

### 검증 및 PR 생성

관리 서버를 `Ctrl+C`로 종료한 뒤 다음을 실행합니다.

```powershell
npm run check
npm run admin -- --check
npm test
npm run build
git status --short
git diff --check
```

`npm run check`는 JSON 스키마, 이미지 경로, JSON/JS 동기화를 검사합니다. `npm run build`는 Cloudflare가 게시할 `dist/`를 새로 만들지만 `dist/` 자체는 commit하지 않습니다.

변경 파일을 검토한 뒤 저장소 루트에서 commit합니다.

```powershell
cd C:\jun
git add eml_website/data
git add eml_website/assets
git commit -m "content: update lab website"
git push --set-upstream origin content/2026-08-27-update
```

관리 화면 코드도 수정한 작업이라면 해당 파일을 별도로 `git add`합니다. GitHub에서 base 브랜치를 `develop`으로 하는 Pull Request를 만들고, 검증 workflow가 통과한 뒤 검토·병합합니다. `develop` 병합 후 Cloudflare Workers Builds가 자동으로 새 버전을 배포합니다.

## 2. 배포된 관리자 페이지 사용

### 로그인

1. `https://홈페이지주소/admin.html`을 엽니다.
2. `GitHub로 관리자 로그인`을 누릅니다.
3. GitHub에서 EML 관리자 GitHub App 사용을 승인합니다.
4. 로그인한 GitHub 계정에 `Energy-Materials/EML-website` push 권한이 있어야 합니다.

GitHub App은 해당 저장소 하나에만 설치되고 `Contents: Read & write`, `Metadata: Read` 권한만 가져야 합니다. 브라우저에는 평문 GitHub token이 저장되지 않습니다. token은 최대 8시간짜리 암호화된 `HttpOnly`, `Secure`, `SameSite=Lax` 쿠키 안에서만 사용됩니다.

### 원격 게시

배포 관리자에서 `Save Changes`를 누르면 다음 작업이 서버에서 수행됩니다.

1. 로그인 세션과 GitHub push 권한을 다시 확인합니다.
2. 동일 출처와 관리자 요청 헤더를 검증합니다.
3. 현재 `develop`의 콘텐츠 Git blob SHA와 편집 시작 시 revision을 비교합니다.
4. 새 JPG, PNG, WebP, GIF의 실제 파일 signature와 크기를 검사합니다.
5. JSON, 결정적 `site-data.js`, 새 이미지 blob을 하나의 Git tree로 만듭니다.
6. 한 개의 Git commit을 생성하고 `develop` ref를 `force: false`로 갱신합니다.

다른 관리자가 먼저 저장했거나 게시 중 브랜치가 바뀌면 `409` 충돌로 중단됩니다. 현재 초안을 JSON으로 내려받고 최신 내용을 다시 불러온 뒤 병합합니다.

원격 저장은 `develop`에 직접 commit하므로 GitHub ruleset에서 이를 허용해야 합니다. 조직 정책상 모든 변경에 PR이 필수라면 원격 저장을 사용하지 말고 앞의 로컬 브랜치·PR 방식을 사용합니다.

작업을 마치면 반드시 `Logout`을 누릅니다. 로그아웃하지 않아도 세션은 최대 8시간 후 만료되며, GitHub에서 App 승인을 취소하면 API 요청이 즉시 거부됩니다.

공용 PC에서는 시크릿/프라이빗 브라우저 창을 사용하고 비밀번호 저장을 허용하지 않습니다. 작업 뒤 홈페이지 `Logout`과 GitHub 로그아웃을 모두 수행하고 시크릿 창을 닫습니다. 실수로 세션을 남겼다면 본인 GitHub `Settings` → `Applications` → `Authorized GitHub Apps`에서 EML 관리자 App 승인을 취소한 뒤, 안전한 기기에서 필요할 때 다시 승인합니다.

## 3. 관리자 기능 직접 테스트

### 로컬 비파괴 점검

다음 명령은 파일을 수정하지 않고 데이터와 관리자 서버 계약을 검사합니다.

```powershell
cd C:\jun\eml_website
npm run check
npm run admin -- --check
npm test
npm run build
```

이후 `dist/index.html`, `dist/admin.html`, `dist/_headers`가 존재하고 `dist/tools`, `dist/tests`, `dist/functions`, `dist/supabase-config.js`가 없는지 확인합니다. `worker.js`가 `functions/`의 API 모듈을 번들링하고, `wrangler.toml`의 `assets.run_worker_first`가 `/api/*` 요청만 Worker 코드로 보냅니다. 일반 홈페이지와 이미지는 정적 자산으로 직접 제공됩니다.

### 로컬 UI 점검표

- 관리자 화면이 가로·세로 스크롤 없이 주요 해상도에서 표시되는가
- 모든 섹션 버튼을 키보드로 이동하고 실행할 수 있는가
- 필수 입력을 비우면 저장 전에 브라우저 검증 메시지가 표시되는가
- 논문 번호에 소수나 중복값을 넣으면 저장이 거절되는가
- 빈 갤러리 항목이 저장되지 않는가
- JPG, PNG, WebP, GIF 외 파일이 거절되는가
- 저장 후 새로고침해도 내용이 유지되는가
- 홈페이지 Preview에서 메뉴, 버튼, 갤러리 상세 보기와 닫기 버튼이 정상인가
- 모바일 폭에서 텍스트와 버튼이 겹치지 않는가

### 배포 관리자 점검표

운영 콘텐츠를 훼손하지 않도록 먼저 Export JSON으로 백업합니다. 테스트가 반드시 필요하면 눈에 띄지 않는 설명 문구 하나를 수정해 저장한 뒤 원래 값으로 다시 저장합니다. 이 과정은 Git commit 두 개를 남깁니다.

- 로그아웃 상태에서 편집기가 아니라 GitHub 로그인 안내만 보이는가
- 허가되지 않은 GitHub 계정은 로그인 후 편집 권한을 받지 못하는가
- 허가된 계정 로그인 후 사용자 ID가 표시되는가
- 저장 시 GitHub `develop`에 단일 commit이 생성되는가
- commit에 JSON, JS, 새 이미지가 함께 들어가는가
- Cloudflare deployment가 해당 commit으로 성공하는가
- 배포 후 홈페이지와 `/admin.html`이 HTTPS에서 열리는가
- Logout 후 `/api/content` 접근이 `401`로 거절되는가

## 4. 오류 해결

| 증상 또는 코드 | 원인 | 조치 |
| --- | --- | --- |
| `401 auth_required` | 세션 만료·GitHub 승인 취소 | 다시 로그인합니다. |
| `403 push_permission_required` | 사용자에게 저장소 push 권한 없음 | 조직 관리자가 Write 이상 권한을 부여합니다. |
| `403 branch_update_rejected` | App 권한 부족 또는 `develop` ruleset이 직접 갱신 차단 | GitHub App의 Contents 쓰기 권한과 ruleset bypass/direct push 정책을 확인하거나 로컬 PR 방식을 사용합니다. |
| `409 revision_conflict` | 다른 관리자 또는 commit이 먼저 변경 | 초안을 Export하고 최신 내용을 다시 불러와 병합합니다. |
| `413 image_too_large` | 이미지가 2MB 초과 | 해상도·품질을 낮추고 다시 업로드합니다. |
| `413 images_too_large` | 한 저장의 신규 이미지 합계가 8MB 초과 | 여러 번에 나누어 게시합니다. |
| `422 invalid_content` | 필수값·배열·논문 번호 등 데이터 오류 | 화면에 표시된 필드를 수정합니다. |
| `422 missing_assets` | JSON이 저장소에 없는 이미지 참조 | 이미지를 다시 선택하거나 올바른 기존 경로를 사용합니다. |
| Cloudflare `1102` / `Worker exceeded resource limits` | 무료 Worker의 요청당 CPU 한도를 초과 | 한 번에 저장하는 이미지를 더 작게·적게 나누거나 로컬 브랜치·PR 방식으로 게시합니다. 반복되면 Cloudflare Worker Metrics를 확인합니다. |
| 로컬 8767 포트 사용 중 | 이전 관리자 서버가 남아 있음 | 기존 터미널에서 `Ctrl+C` 후 다시 실행합니다. |
| Cloudflare build 실패 | 검증·생성 파일 불일치 | build log 확인 후 로컬에서 `npm run check`, `npm run build`를 재현합니다. |

## 5. 되돌리기와 이미지 정리

Git이 콘텐츠 이력의 기준입니다. 잘못 게시한 commit은 새 브랜치에서 `git revert <commit-sha>`하고 PR로 `develop`에 반영하는 방식을 권장합니다. Cloudflare의 deployment rollback은 긴급 복구에 사용할 수 있지만 다음 `develop` 배포가 다시 덮어쓰므로 Git 이력도 반드시 되돌립니다.

관리 화면에서 이미지 참조를 제거해도 기존 `assets/uploads/` 파일은 현재 저장소 tree와 Git 이력에 남습니다. 이는 다른 콘텐츠의 참조를 실수로 삭제하지 않기 위한 정책입니다. 정리가 필요하면 전체 저장소에서 파일 경로를 검색해 미사용임을 확인한 뒤 별도 브랜치와 PR로 삭제합니다.

```powershell
git grep "assets/uploads/정리할-파일명"
```

삭제 전에 홈페이지 데이터와 과거에 되돌릴 commit을 확인하십시오.
