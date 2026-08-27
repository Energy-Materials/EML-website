# EML 홈페이지 Cloudflare Pages 배포 가이드

이 프로젝트는 별도 클라우드 데이터베이스 없이 배포할 수 있습니다. 정적 홈페이지와 관리자 화면은 Cloudflare Pages가 제공하고, 관리자 저장은 Pages Functions가 GitHub `develop` 브랜치에 commit합니다. 공개 홈페이지는 빌드된 `data/site-data.js`만 읽으므로 GitHub 로그인이나 API가 없어도 표시됩니다.

## 전체 구성

| 구분 | 서비스 | 역할 |
| --- | --- | --- |
| 소스·콘텐츠 원본 | public GitHub 저장소 `Energy-Materials/EML-website` | 코드, `site-data.json`, 이미지, 변경 이력 |
| 배포 | Cloudflare Pages | `develop` push 후 `dist/` 자동 배포 |
| 관리자 API | Cloudflare Pages Functions | GitHub App 로그인, 검증, Git commit |
| 공식 주소 | 기존 기관 도메인의 subdomain 또는 `*.pages.dev` | 방문자가 접속할 HTTPS 주소 |

Cloudflare의 Git 연동용 GitHub App과 이 프로젝트의 **EML 관리자 GitHub App은 서로 다른 앱**입니다. 첫 번째는 Cloudflare가 배포 소스를 읽기 위한 앱이고, 두 번째는 승인된 관리자가 콘텐츠를 게시하기 위한 최소 권한 앱입니다.

## 1. 배포 전 로컬 확인

Node.js 22를 권장합니다.

```powershell
cd C:\jun\eml_website
npm run check
npm run admin -- --check
npm run build
```

빌드 후 `dist/index.html`, `dist/admin.html`, `dist/data/site-data.js`, `dist/_headers`, `dist/_routes.json`이 있어야 합니다. `functions/`는 `dist/`에 복사하지 않습니다. Cloudflare가 프로젝트 root의 `functions/`를 별도 Worker로 번들링합니다. `_routes.json`은 `/api/*`만 Functions에 포함하므로 일반 홈페이지·이미지 요청은 무료 정적 요청으로 처리됩니다.

## 2. Cloudflare Pages 프로젝트 생성

Cloudflare Dashboard에서 `Workers & Pages` → `Create application` → `Pages` → `Connect to Git` 순서로 이동합니다. UI 개편으로 명칭이 조금 다르면 `Workers & Pages`에서 Git 저장소 연결 방식의 Pages 프로젝트 생성을 선택합니다.

### 조직 저장소 승인

1. GitHub 연결에서 `Configure Cloudflare Pages`를 선택합니다.
2. GitHub 저장소 소유 계정 `Energy-Materials`를 선택합니다.
3. Repository access를 `Only select repositories`로 제한하고 `EML-website`만 선택합니다.
4. 조직 정책상 설치 승인이 뜨면 조직 Owner 또는 GitHub Apps Manager가 승인해야 합니다.
5. Cloudflare로 돌아와 저장소를 선택합니다.

저장소를 찾을 수 없으면 개인 GitHub 계정의 OAuth 권한을 넓히기보다, 조직 설정의 Installed GitHub Apps에서 Cloudflare Pages 앱이 `EML-website`에 설치·승인되었는지 먼저 확인합니다.

현재 저장소는 public이지만 Cloudflare Pages Git 연동은 향후 private으로 바뀌어도 사용할 수 있습니다. private 전환 시에는 Cloudflare GitHub App의 선택 저장소 권한이 그대로 승인되어 있는지 다시 확인합니다.

### Build 설정

다음 값을 그대로 사용합니다.

| 항목 | 값 |
| --- | --- |
| Production branch | `develop` |
| Framework preset | `None` 또는 없음 |
| Root directory | `eml_website` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Build system | v3(Node.js 22 기본) |

Project name은 먼저 `energy-materials-lab`을 시도합니다. 이미 사용 중이면 `knu-energy-materials`, 그다음 `energy-materials-eml`을 사용합니다. 결과 기본 주소는 각각 `energy-materials-lab.pages.dev` 같은 형식입니다. fallback 이름을 선택했다면 `eml_website/wrangler.toml`의 `name`도 **선택한 Cloudflare Project name과 정확히 같게** 바꾸고 `develop`에 반영한 뒤 배포를 재시도합니다.

`Build and deployment` 메뉴가 보이지 않는 경우는 대개 아직 프로젝트가 생성되지 않았거나 Pages 프로젝트가 아닌 Worker 화면에 있기 때문입니다. Git 연결과 첫 설정을 완료한 뒤 해당 Pages 프로젝트를 다시 열고 `Settings`의 `Builds & deployments` 또는 `Build` 항목을 확인합니다. 배포 이력과 log는 프로젝트의 `Deployments`에서 확인합니다.

저장소에는 같은 값의 `eml_website/wrangler.toml`이 포함되어 있습니다. 이 파일은 Pages Functions 설정의 source of truth이므로 Dashboard 값과 다르게 만들지 않습니다.

첫 배포 후 프로젝트 `Settings` → `Runtime`의 Functions 한도 동작은 `Fail closed`로 설정합니다. 인증·게시 API가 한도 초과 시 정적 파일로 우회되지 않고 오류로 중단되게 하기 위한 설정입니다. `_routes.json`이 `/api/*`만 Functions에 포함하므로 이 경우에도 공개 정적 홈페이지 요청은 Functions와 무관하게 계속 제공됩니다.

## 3. EML 관리자 GitHub App 만들기

Pages의 최종 `pages.dev` 주소가 정해진 **뒤에** 이 단계를 진행합니다. 조직 Owner가 GitHub 조직 Settings의 `Developer settings` → `GitHub Apps` → `New GitHub App`에서 생성하는 것을 권장합니다.

### 기본 설정

- GitHub App name: 조직에서 구분되는 이름, 예: `EML Website Content Admin`
- Homepage URL: 최종 홈페이지 origin, 예: `https://energy-materials-lab.pages.dev`
- Callback URL: 최종 origin 뒤에 `/api/auth/callback`
- Callback URL wildcard matching: 비활성화하고 위 URL과 정확히 일치시킴
- Request user authorization (OAuth) during installation: 비활성화
- Device Flow: 비활성화
- Webhook: 비활성화
- 설치 대상: `Only on this account` 또는 조직 정책에 맞는 제한된 설정

로컬 OAuth까지 직접 시험할 담당자만 추가 callback URL로 `http://localhost:8788/api/auth/callback`을 등록합니다. 운영에 필요하지 않으면 등록하지 않습니다.

### 최소 권한

Repository permissions에서 다음만 설정합니다.

- `Contents`: Read and write
- `Metadata`: Read-only
- 그 밖의 Repository, Organization, Account 권한: No access

App을 만든 뒤 `Optional Features`에서 `User-to-server token expiration`이 활성화되어 있는지 확인합니다(새 App은 기본 활성화). `Install App`에서 `Energy-Materials`를 선택하고 **Only select repositories → EML-website 하나만** 설치합니다. 별도 승인이 필요한 경우 저장소 소유자가 설치를 승인합니다. 관리자 본인에게도 저장소 `push` 권한이 있어야 로그인 후 편집할 수 있습니다. 이 구성은 private key나 installation token을 사용하지 않으므로 private key를 생성할 필요가 없습니다.

이 방식은 classic OAuth App이나 Personal Access Token 방식이 아닙니다. `repo` scope를 요청하지 않으며 GitHub App user access token은 기본 만료 시간을 사용합니다.

## 4. Production 변수와 secret 설정

GitHub App 화면에서 Client ID를 복사하고 Client secret을 새로 생성합니다. `wrangler.toml`이 설정의 source of truth이므로 저장소·브랜치 관련 일반 변수는 파일에서 관리하고 Dashboard에 중복 생성하지 않습니다.

Cloudflare Pages 프로젝트의 `Settings` → `Variables and Secrets`에서 **Production 환경에만** 다음 값을 추가하고 `Encrypt`를 선택합니다. Client ID와 `PUBLIC_ORIGIN`은 그 자체로 비밀은 아니지만 Wrangler 일반 변수와 섞이지 않도록 여기서는 암호화 binding으로 관리합니다.

| 이름 | 값 | 취급 |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | GitHub App Client ID | Encrypt |
| `GITHUB_CLIENT_SECRET` | 생성한 Client secret | Encrypt |
| `SESSION_SECRET` | 암호학적으로 임의인 32바이트 이상의 값 | Encrypt |

다음 비밀이 아닌 값은 이미 `wrangler.toml`의 `[vars]`에 고정되어 있습니다.

| 이름 | 값 |
| --- | --- |
| `GITHUB_OWNER` | `Energy-Materials` |
| `GITHUB_REPO` | `EML-website` |
| `GITHUB_BRANCH` | `develop` |
| `GITHUB_CONTENT_PATH` | `eml_website/data/site-data.json` |
| `GITHUB_REPOSITORY_ID` | `1348328666` |

`SESSION_SECRET`은 로컬에서 다음처럼 만들 수 있습니다. 출력값은 비밀번호 관리자에 보관하고 Git, 문서, 메신저에 남기지 않습니다.

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`PUBLIC_ORIGIN`은 `wrangler.toml` 기본값에 의도적으로 넣지 않았습니다. 처음에는 요청 origin을 자동 사용합니다. 최종 공식 주소를 확정한 뒤 하나의 canonical 주소만 사용하려면 Production의 암호화 binding으로 다음처럼 선택 설정합니다.

```text
PUBLIC_ORIGIN=https://확정된-홈페이지-호스트
```

경로는 넣지 않습니다. 이 값을 설정하면 GitHub App Callback URL도 정확히 `PUBLIC_ORIGIN/api/auth/callback`이어야 합니다. `pages.dev`와 custom domain 양쪽에서 직접 로그인할 필요가 있다면 GitHub App에 두 callback URL을 등록하고 `PUBLIC_ORIGIN`을 비워 두거나, 권장 방식대로 custom domain 하나를 canonical 주소로 고정합니다.

Preview deployment에는 `GITHUB_CLIENT_SECRET`과 `SESSION_SECRET`을 넣지 않는 것을 권장합니다. Preview 관리 페이지가 실수로 운영 `develop`에 게시할 수 없게 하기 위해서입니다.

변수를 저장한 뒤 `Deployments`에서 최신 production deployment를 Retry하거나 `develop`에 새 commit을 push해 다시 배포합니다. Secret을 바꾸면 반드시 재배포합니다.

## 5. 기존 공식 도메인 연결

호스팅의 무료 여부와 도메인 소유 비용은 별개입니다. Cloudflare Pages 무료 플랜에서도 custom domain과 HTTPS를 연결할 수 있지만, 새 도메인을 구입한다면 등록 비용이 듭니다. 학교나 연구실이 이미 소유한 공식 도메인의 subdomain을 배정받으면 보통 새 도메인을 구입할 필요가 없습니다.

예를 들어 기관 DNS 담당자가 `lab.example.ac.kr`을 제공하는 경우:

1. 현재 DNS record와 TTL을 먼저 기록합니다.
2. Cloudflare Pages 프로젝트의 `Custom domains`에서 `lab.example.ac.kr`을 **먼저** 추가합니다.
3. 기관 DNS에서 `lab.example.ac.kr` CNAME을 실제 프로젝트의 `<project>.pages.dev`로 지정합니다.
4. Cloudflare에서 domain 상태가 Active이고 TLS 인증서가 발급될 때까지 기다립니다.
5. HTTPS 접속, 기존 메일·다른 subdomain, 모바일 접속을 확인합니다.

Subdomain은 기관 DNS를 그대로 둔 채 CNAME으로 연결할 수 있습니다. `example.ac.kr` 같은 apex/root domain을 직접 연결하려면 일반적으로 해당 zone의 nameserver를 Cloudflare로 이전해야 하므로 학교 전체 DNS에 영향이 큽니다. 연구실 단독 작업으로 진행하지 말고 기관 DNS 관리자와 협의합니다.

CAA record로 인증서 발급 기관을 제한한 도메인은 Cloudflare 인증서 발급이 막힐 수 있습니다. 상태가 Pending이면 기존 CAA 정책을 임의로 삭제하지 말고 기관 DNS 담당자와 Cloudflare 안내를 확인합니다. HTTPS 인증서는 Pages가 관리하므로 별도 인증서를 파일로 commit하지 않습니다.

custom domain이 활성화되면 다음을 함께 바꿉니다.

1. GitHub App Homepage URL과 Callback URL
2. 선택적 Cloudflare `PUBLIC_ORIGIN`
3. 홈페이지에 표시된 공식 URL과 공유 문서
4. 변경 후 Production 재배포 및 관리자 재로그인

## 6. 첫 배포 검증

### 공개 홈페이지

- `/`가 HTTPS로 열리고 메뉴·버튼·갤러리 닫기가 정상 동작하는지 확인
- 모바일과 데스크톱에서 텍스트·버튼이 겹치지 않는지 확인
- 브라우저 개발자 도구 Console에 CSP 또는 자산 404 오류가 없는지 확인
- 응답에 CSP, `nosniff`, Referrer-Policy, Permissions-Policy가 포함되는지 확인

### 관리자

1. `/admin.html`을 열고 GitHub 로그인 버튼만 표시되는지 확인합니다.
2. 허가된 계정으로 로그인합니다.
3. `/api/auth/session`이 인증된 사용자 정보를 반환하는지 확인합니다.
4. 먼저 Export JSON으로 백업합니다.
5. 테스트 문구 하나를 저장하고 GitHub `develop`에 한 commit으로 JSON과 JS가 함께 반영됐는지 확인합니다.
6. 해당 commit으로 Cloudflare production deployment가 시작되는지 확인합니다.
7. 원래 문구로 다시 저장하고 Logout합니다.

원격 저장이 `403 branch_update_rejected`이면 GitHub App의 Contents 권한과 설치 저장소를 확인합니다. 둘 다 맞다면 `develop` branch ruleset이 App의 direct ref update를 차단한 것입니다. 조직 정책에 따라 이 App을 제한적으로 bypass 대상으로 허용하거나, 원격 게시를 사용하지 않고 `ADMIN_GUIDE.md`의 로컬 브랜치·PR 절차를 사용합니다.

### 기존 GitHub Pages 정리

Cloudflare production과 custom domain을 충분히 검증한 **뒤에만** GitHub 저장소 `Settings` → `Pages`에서 기존 GitHub Pages 배포를 `Unpublish site`하거나 Source를 `None`으로 바꿔 비활성화합니다. 새 GitHub Actions workflow는 Pages에 배포하지 않으므로 과거 deployment가 자동으로 사라지지는 않습니다.

이후 홈페이지와 관리자 주소는 확정한 Cloudflare/custom domain만 안내합니다. 과거 GitHub Pages 주소에는 Pages Functions가 없어 원격 관리자 API가 동작하지 않으므로 `/admin.html` 주소로 사용하면 안 됩니다.

## 7. 자동 배포와 되돌리기

- `develop` push/merge: Cloudflare Pages가 production 자동 배포
- Pull Request와 다른 브랜치: Cloudflare preview 배포 가능, 단 관리자 secret은 제공하지 않음
- GitHub Actions: `.github/workflows/deploy-pages.yml`은 배포하지 않고 `check`와 `build`만 검증
- 긴급 화면 복구: Cloudflare `Deployments`에서 이전 성공 deployment로 rollback
- 영구 복구: GitHub에서 잘못된 commit을 `git revert`한 새 commit/PR로 `develop`에 반영

Cloudflare rollback만 하면 다음 `develop` 배포가 다시 덮어쓰므로 Git 이력도 반드시 복구합니다.

## 8. 비용과 운영상 주의

- Cloudflare Pages는 private GitHub 저장소 연동, `pages.dev`, custom domain, 관리형 HTTPS를 무료 플랜에서 사용할 수 있습니다. 무료 한도는 계정의 현재 Pages/Workers 정책을 따릅니다.
- GitHub App 생성 자체에 별도 데이터베이스 비용은 없습니다.
- 새 도메인 등록, 기관 DNS 운영, 무료 한도를 넘는 Cloudflare 사용량은 별도 비용이 생길 수 있습니다.
- 이미지 1장 2MB, 한 게시의 신규 이미지 합계 8MB, 최대 10장, 전체 요청 12MB는 서버가 강제하는 애플리케이션 hard limit입니다.
- 관리자에서 참조를 제거한 업로드 파일은 자동 삭제하지 않습니다. 미사용 파일은 별도 브랜치에서 참조 여부를 확인한 뒤 PR로 정리합니다.

Workers Free의 Functions CPU 한도는 요청당 10ms이며 Cloudflare도 인증이나 큰 payload 처리는 보통 10–20ms가 걸릴 수 있다고 안내합니다. 런타임은 드물게 한도를 넘는 요청에 일부 여유를 주지만 큰 이미지 원격 게시의 성공을 보장하는 것은 아닙니다. 먼저 무료로 운영하되 다음을 적용합니다.

1. 관리자 화면은 일반 이미지를 약 700KB 목표로 자동 최적화합니다. GIF는 2MB 이하로 미리 줄이고 여러 이미지는 작게 나누어 저장합니다.
2. Pages 프로젝트 `Metrics` → `Errors` → `Invocation Statuses`와 CPU time에서 `1102` 또는 `exceededCpu`를 확인합니다.
3. 오류가 반복되면 정적 홈페이지는 무료 Cloudflare에 그대로 두고, 콘텐츠 게시만 `ADMIN_GUIDE.md`의 로컬 관리자·Git branch·PR 방식으로 진행합니다. 이 방식은 Functions CPU를 사용하지 않습니다.
4. 큰 이미지를 배포 관리자에서 반드시 직접 게시해야 할 때만 선택적으로 Workers Paid를 검토합니다. 2026년 8월 공식 최저 요금은 월 USD 5이므로 계정 결제 화면에서 최신 가격을 다시 확인합니다.

## 공식 문서

- [Cloudflare Pages Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/)
- [Cloudflare GitHub integration과 조직 저장소 권한](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/)
- [Cloudflare Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)
- [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/)
- [Cloudflare Pages Functions invocation routing](https://developers.cloudflare.com/pages/functions/routing/)
- [Cloudflare Pages Wrangler 설정(source of truth)](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Cloudflare Workers Free CPU limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers/Pages Functions pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [GitHub App user access token과 PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub App callback URL과 wildcard 설정](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)
- [GitHub App 설치](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)
- [GitHub Git Data API](https://docs.github.com/en/rest/git/trees)
