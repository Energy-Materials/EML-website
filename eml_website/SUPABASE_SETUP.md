# EML 홈페이지 클라우드 관리자 설정

현재 홈페이지는 정적 서버에 그대로 올릴 수 있으며, 콘텐츠·로그인·이미지만 Supabase에 저장합니다.

```text
index.html  ── 공개 읽기 ──> Supabase Database / Storage
admin.html  ── 관리자 로그인 후 쓰기 ──> Supabase
```

## 1. Supabase 프로젝트 만들기

1. [Supabase Dashboard](https://supabase.com/dashboard)에서 새 프로젝트를 만듭니다.
2. 프로젝트의 **SQL Editor**를 엽니다.
3. 이 프로젝트의 `supabase/setup.sql` 내용을 전부 붙여 넣고 실행합니다.

이 SQL은 다음을 만듭니다.

- 공개 홈페이지 데이터 한 행(`site_content`)
- 관리자 허용 목록(`admin_users`)
- 공개 이미지 버킷(`site-media`)
- 방문자는 읽기만, 등록된 관리자는 수정만 할 수 있는 RLS 정책
- 여러 관리자 화면이 서로의 최신 내용을 덮어쓰지 못하도록 하는 버전 번호

## 2. 관리자 계정 등록하기

1. Dashboard의 **Authentication > Users > Add user > Create new user**에서 내부 이메일을 `eml-admin@example.com`으로 입력하고, 사용할 관리자 비밀번호를 직접 지정한 뒤 **Auto Confirm User**를 켭니다. 현재 관리자 화면에는 초대 링크에서 비밀번호를 만드는 기능이 없으므로 **Send invitation은 사용하지 마세요.**
2. Authentication 설정에서 일반 사용자의 신규 가입을 허용하지 않도록 **Allow new users to sign up**을 끕니다.
3. SQL Editor에서 아래 SQL을 그대로 실행해 내부 계정을 관리자 허용 목록에 넣습니다.

```sql
insert into public.admin_users (user_id)
select id
from auth.users
where lower(email) = lower('eml-admin@example.com')
on conflict (user_id) do nothing;
```

현재 로그인 화면은 `adminLoginId` 하나를 내부 Supabase 계정 하나에 연결하는 단일 관리자 방식입니다.

관리자 화면에는 이메일 대신 `supabase-config.js`의 `adminLoginId` 값(현재 `eml2022##`)을 입력합니다. 내부 이메일은 Supabase Auth 연결에만 사용됩니다. **비밀번호는 홈페이지 HTML/JavaScript에 적지 말고 Dashboard 계정에만 설정하세요.** 아이디와 같은 비밀번호는 추측하기 매우 쉬우므로 외부 공개 전에는 서로 다른 긴 비밀번호를 권장합니다.

## 3. 홈페이지 연결값 넣기

Dashboard 상단의 **Connect** 창 또는 **Settings > API Keys**에서 다음 두 값을 확인합니다.

- Project URL
- Publishable key (`sb_publishable_...`)

`supabase-config.js`를 열어 아래 두 자리만 교체합니다.

```js
supabaseUrl: 'https://프로젝트주소.supabase.co',
supabasePublishableKey: 'sb_publishable_...',
```

Publishable key는 정적 홈페이지에 넣도록 만들어진 공개 키이며, 실제 쓰기 보안은 `setup.sql`의 RLS 정책이 담당합니다. **Secret key 또는 `service_role` key는 HTML이나 JavaScript에 절대 넣지 마세요.**

## 4. 처음 게시하기

1. 홈페이지 파일을 로컬 웹서버나 운영 서버에서 엽니다. `file://`로 직접 열지 말고 HTTP(S) 주소를 사용하세요.
2. `admin.html`로 이동해 위에서 만든 관리자 계정으로 로그인합니다.
3. 처음에는 현재 `data/site-data.js`의 기본 내용이 편집기에 표시됩니다.
4. 내용을 확인하고 아무 섹션에서나 **Save Changes**를 누릅니다.
5. `index.html`을 새로고침해 같은 내용이 보이는지 확인합니다.

이후에는 코드 파일을 다시 올리지 않아도 관리자 저장 즉시 DB에 반영됩니다. 이미 열려 있는 공개 페이지도 사용자가 입력이나 갤러리 팝업을 조작 중인 경우를 제외하면 실시간으로 새 내용을 받습니다.

## 5. 기존 브라우저 수정 내용 가져오기

예전 관리자 페이지로 수정한 `localStorage` 데이터가 같은 브라우저에 남아 있으면 관리자 상단에 **기존 브라우저 초안 가져오기** 버튼이 나타납니다.

1. 버튼을 눌러 초안을 불러옵니다.
2. 내용을 확인합니다.
3. **Save Changes**를 눌러 클라우드에 게시합니다.

기존 Base64 사진은 처음 저장할 때 자동으로 Storage에 업로드하고 URL로 교체합니다. 원본 JSON은 상단 **Export JSON**으로 별도 백업할 수 있습니다.

## 운영 시 꼭 지킬 사항

- 관리자 페이지와 공개 사이트 모두 HTTPS로 서비스합니다.
- 관리자 계정을 다른 사람과 공유하지 않습니다.
- Supabase의 일반 사용자 공개 가입을 끕니다.
- `supabase/setup.sql`의 RLS 정책을 제거하거나 `anon` 쓰기 권한을 추가하지 않습니다.
- 정기적으로 관리자 화면의 **Export JSON**으로 콘텐츠를 백업합니다.
- 업로드 가능한 이미지는 JPG, PNG, WebP, GIF이며 파일당 최대 10MB입니다. SVG는 스크립트 삽입 위험 때문에 관리자 업로드에서 제외했습니다.
- 교체하거나 게시글에서 제거한 이미지는 즉시 영구 삭제하지 않아 실수로 지운 사진을 복구할 수 있습니다. 필요할 때 Dashboard의 Storage에서 사용하지 않는 파일을 확인한 뒤 수동 정리하세요.

## 문제 해결

- **클라우드 설정이 필요합니다**: `supabase-config.js`의 URL과 Publishable key를 확인합니다.
- **관리자 권한이 없습니다**: 내부 계정 `eml-admin@example.com`이 `admin_users`에 등록됐는지 확인합니다.
- **site_content의 main 행이 없습니다**: `supabase/setup.sql` 전체를 다시 실행합니다.
- **이미지 업로드 403 오류**: 로그인한 사용자가 `admin_users`에 있고 Storage 정책이 생성됐는지 확인합니다.
- **다른 관리자 화면에서 먼저 저장했습니다**: JSON을 Export해 현재 작업을 백업한 뒤 **최신 내용 다시 불러오기**를 누르고 다시 반영합니다.

공식 참고 문서:

- [Supabase JavaScript CDN 설치](https://supabase.com/docs/reference/javascript/installing)
- [API 키 구분](https://supabase.com/docs/guides/getting-started/api-keys)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Storage 접근 제어](https://supabase.com/docs/guides/storage/security/access-control)
