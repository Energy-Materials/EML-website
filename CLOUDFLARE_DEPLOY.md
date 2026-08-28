# EML 홈페이지 Cloudflare Worker 배포 가이드

현재 홈페이지는 Cloudflare Worker `eml-website`에 Git 연동으로 배포됩니다. 공개 주소는 `https://eml-website.em1939653.workers.dev`이며, GitHub `Energy-Materials/EML-website`의 `develop` 변경이 자동 배포됩니다. 별도 데이터베이스나 Supabase는 사용하지 않습니다.

## 현재 구성

| 항목 | 값 |
| --- | --- |
| Cloudflare 계정 | `em1939653@gmail.com` |
| Worker 이름 | `eml-website` |
| 공개 주소 | `https://eml-website.em1939653.workers.dev` |
| GitHub 저장소 | `Energy-Materials/EML-website` |
| 운영 브랜치 | `develop` |
| 프로젝트 Root directory | `eml_website` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |

`dist/`의 홈페이지 파일은 Workers Static Assets가 제공합니다. `worker.js`는 `/api/*` 요청만 먼저 받아 `functions/`의 GitHub 로그인·게시 코드를 실행합니다. 따라서 정적 홈페이지 요청은 관리자 API와 무관하게 계속 제공됩니다.

## 1. Workers Builds 설정 확인

이미 만들어진 Worker를 삭제하거나 새 Pages 프로젝트를 만들 필요가 없습니다.

1. Cloudflare Dashboard에서 `Workers & Pages`를 엽니다.
2. `eml-website`를 선택합니다.
3. `Settings` → `Builds`를 엽니다.
4. 아래 값과 같은지 확인합니다.

```text
Repository: Energy-Materials/EML-website
Branch: develop
Root directory: eml_website
Build command: npm run build
Deploy command: npx wrangler deploy
```

Worker 이름과 `eml_website/wrangler.toml`의 `name = "eml-website"`는 반드시 같아야 합니다. Build variables는 빌드 중에만 사용되므로 관리자 비밀값을 그곳에 넣지 않습니다.

## 2. 관리자 로그인용 GitHub App 만들기

최초 한 번만 GitHub의 저장소 소유 계정에서 설정합니다.

1. GitHub → 프로필 사진 → `Settings` → `Developer settings`를 엽니다.
2. `GitHub Apps` → `New GitHub App`을 누릅니다.
3. 다음 값을 입력합니다.

```text
GitHub App name: Energy Materials Lab Website Admin
Homepage URL: https://eml-website.em1939653.workers.dev
Callback URL: https://eml-website.em1939653.workers.dev/api/auth/callback
```

4. Callback URL wildcard matching, Device Flow, Webhook은 끕니다.
5. `Request user authorization (OAuth) during installation`은 끕니다.
6. Repository permissions는 다음 두 개만 설정합니다.

```text
Contents: Read and write
Metadata: Read-only
```

7. 나머지 권한은 `No access`, 설치 범위는 `Only on this account`로 둡니다.
8. App을 만든 뒤 Client ID를 확인하고 `Generate a new client secret`으로 Client secret을 하나 만듭니다.
9. Private key는 만들 필요가 없습니다.
10. `Install App`에서 `Energy-Materials`를 선택하고 `Only select repositories` → `EML-website` 하나만 설치합니다.

관리자로 로그인할 GitHub 사용자 자신에게도 이 저장소의 push 권한이 있어야 합니다.

## 3. Worker에 비밀값 넣기

Client secret이나 Session secret은 Git, 문서, 메신저에 올리지 않습니다.

1. Cloudflare → `Workers & Pages` → `eml-website`를 엽니다.
2. `Settings` → `Variables and Secrets`를 엽니다.
3. `Add`를 눌러 다음 세 값을 모두 `Secret` 형식으로 추가합니다.

| 이름 | 값 |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub App의 Client ID |
| `GITHUB_CLIENT_SECRET` | 생성한 Client secret |
| `SESSION_SECRET` | 32자 이상의 무작위 값 |

`SESSION_SECRET`은 로컬 PowerShell에서 다음 명령으로 만들 수 있습니다.

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

출력값을 Cloudflare에 직접 붙여 넣고 따로 공유하지 않습니다. 값을 모두 입력한 뒤 `Deploy`를 눌러 새 Worker 버전에 적용합니다. `PUBLIC_ORIGIN`과 저장소 정보는 `wrangler.toml`에 일반 변수로 이미 고정되어 있습니다.

## 4. 정상 동작 확인

배포 직후 다음 순서로 확인합니다.

1. `https://eml-website.em1939653.workers.dev/`가 열립니다.
2. `https://eml-website.em1939653.workers.dev/admin.html`이 열립니다.
3. 로그아웃 상태의 `/api/auth/session`은 빈 `404`가 아니라 JSON `401 auth_required`를 반환합니다.
4. 관리자 화면에서 `GitHub로 관리자 로그인`을 누릅니다.
5. GitHub 승인 후 관리자 이름과 `develop` 브랜치가 표시됩니다.
6. 먼저 Export JSON으로 백업한 뒤 설명 문구 하나를 저장해 GitHub에 commit이 생기는지 확인합니다.
7. Workers Builds가 해당 `develop` commit을 자동 배포하는지 확인합니다.
8. 원래 문구로 되돌려 다시 저장하고 `Logout`합니다.

갤러리 이미지 게시를 시험할 때는 실제 사용할 사진을 권장합니다. 저장한 이미지는 게시글에서 제거해도 Git 이력에는 남습니다.

## 5. 오류 해결

| 증상 | 확인할 항목 |
| --- | --- |
| `/api/auth/session`이 빈 `404` | `worker.js`, `wrangler.toml`이 포함된 최신 `develop` 배포인지 확인 |
| `server_not_configured` | 세 Secret의 이름과 저장 여부 확인 후 다시 Deploy |
| GitHub callback 오류 | GitHub App Callback URL이 공개 주소와 글자 하나까지 같은지 확인 |
| `403 push_permission_required` | 로그인 사용자에게 저장소 Write 이상 권한 부여 |
| `403 branch_update_rejected` | GitHub App Contents 쓰기 권한과 `develop` ruleset 확인 |
| `409 revision_conflict` | 다른 변경이 먼저 반영됨; 초안을 Export하고 새로고침 후 병합 |
| Cloudflare `1102` | 한 번에 게시하는 이미지 수·용량을 줄이거나 로컬 PR 방식 사용 |

## 6. 배포 전 로컬 검증

```powershell
cd C:\jun\eml_website
npm run check
npm run admin -- --check
npm test
npm run build
npx wrangler deploy --dry-run
git diff --check
```

`dist/`와 테스트 산출물은 commit하지 않습니다. 실제 비밀값도 `.dev.vars`나 `.env`에만 두고 Git에 올리지 않습니다.

## 공식 문서

- [Workers Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Workers Static Assets binding and API routing](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub App callback URLs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)
