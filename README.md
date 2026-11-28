# ENT 3D

귀 해부를 휴대폰에서 보는 학습 뷰어입니다. 측두골 페이지와 전정안반사 모식 페이지가 있습니다.

공개 주소는 [https://han-ent.github.io/ent-3d/](https://han-ent.github.io/ent-3d/) 입니다. `main`에 푸시되면 `.github/workflows/pages.yml` 이 `npm ci && npm run build` 결과를 GitHub Pages에 올립니다. 베이스는 `/ent-3d/` 이라 측두골은 `/ent-3d/temporal-bone/`, VOR은 `/ent-3d/vor/` 입니다.

## 페이지

| 경로 | 내용 |
| --- | --- |
| `/ent-3d/` | 처음 화면 |
| `/ent-3d/temporal-bone/` | 측두골 뷰어 |
| `/ent-3d/vor/` | 전정안반사. 모식 시뮬레이터 |
| `/ent-3d/about/` | 출처와 라이선스 |

공통 코드는 `src/shared/` 에 있습니다.

- 뷰어: 회전·확대·터치, 레이어 표시와 불투명도, 눌러 고르기, 정보 패널
- 배지: `미검증`, `YS 검수 완료`
- 퀴즈: 이름 맞히기, 구조 찾기
- 문자열: `src/shared/i18n/ko.json` 이 기본. `en.json` 은 같은 키를 가진 영어 초안
- 서비스 워커: `public/sw.js`. json은 네트워크를 먼저 보고, glb·webp는 빌드 해시가 붙은 주소로 캐시합니다. 캐시 이름은 빌드 해시이고, 이전 캐시는 activate에서 지웁니다.

## 실행

```bash
npm install
npm test
npm run dev
```

개발 주소는 `http://localhost:5173/ent-3d/temporal-bone/` 입니다.

```bash
npm run build
npm run preview
```

`npm run build` 는 타입 검사 후 `dist/` 를 만듭니다. 파일을 그냥 열면 베이스 경로 때문에 동작하지 않으니 preview를 씁니다.

## 좌표계

단위는 밀리미터입니다. 메시를 줄이거나 키우지 않습니다. 원점이 화면 밖으로 멀리 있으면 `manifest.json`의 `viewer_offset_mm`만 바꿉니다. 이 값은 뷰어 묶음의 평행이동이고, 거리 계산은 바뀌지 않습니다.

지금 측두골은 오른쪽 귀입니다. 메시 축은 RAS가 아닙니다. +X 앞, +Y 아래, +Z 안쪽입니다. 메시 파일은 원본 밀리미터 그대로이고, 화면 중심만 `viewer_offset_mm`로 옮깁니다.

화면의 축척 막대는 카메라가 보는 깊이에서 몇 밀리미터인지 보여 줍니다. 두 점 측정은 표면을 두 번 눌러 유클리드 거리를 밀리미터로 냅니다.

## 에셋 넣기

1. 모델링 도구에서 단위를 밀리미터로 두고 glb를 보냅니다. 노드 배율은 1이어야 합니다.
2. `public/temporal-bone/models/` 에 둡니다.
3. `public/temporal-bone/manifest.json`의 `structures`에 id, 파일, 한국어·영어 이름, 색, 레이어, `status`, content 경로를 추가합니다.
4. `public/temporal-bone/content/<id>.json` 을 만듭니다. 형식은 [docs/schemas.md](docs/schemas.md) 입니다.
5. 새 묶음이면 `layers`에 추가합니다.
6. CT를 바꿀 때는 `ct/volume.json`의 간격·원점·방향·크기와 슬라이스 PNG를 맞춥니다.
7. 절제 순서는 `presets.json`의 `sequences[].steps[]` 입니다. 단계마다 제목, 안내, 확인할 구조, 위험 구조, 카메라, 선택적 자르기가 있고, 배열 순서가 진행 순서입니다. 뼈를 갈아내는 기능은 없습니다. 설계는 [docs/dissection-lab.md](docs/dissection-lab.md) 입니다.

지금 `public/temporal-bone` 은 OpenEar ZETA입니다. glb는 Draco 압축이고, CT는 `ct/{axial,coronal,sagittal}/*.webp` (0.25 mm)입니다. Draco 디코더는 `public/draco/` 에 있고 three 패키지에서 복사한 것이며 외부 CDN을 쓰지 않습니다.

뼈와 S상정맥동·경막만 삼각형 수를 줄였습니다. 뼈는 기본이 불투명이고, S상정맥동·경막은 한 메시에 섞였을 수 있어 `미검증`입니다. 반고리관과 경정맥구(jugular bulb)는 없습니다. 목정맥공(jugular foramen)은 다른 구조입니다.

`npm run generate:placeholders` 는 이 실측 파일을 덮어쓰지 않도록 막아 두었습니다.

## 내용 고치기

검토자(커밍스 / YS)는 코드 대신 JSON만 고칩니다.

- 해부: `anatomy`, 기능: `function`. 둘 다 `{ ko, en }`
- 출처: `sources[]`의 `citation`, `page`, `verified`
- 상태: 파일의 `review` (`미검증` 또는 `YS 검수 완료`)
- 연결된 구조: `related`. 예: 고삭신경 → `facial-nerve`
- 수술 포인트: `surgical_points[].text`. 좌표 `position_mm`는 출처와 `review`가 있을 때만

새 문안의 기본 상태는 `미검증` 입니다. 확인이 끝나면 그 항목만 `YS 검수 완료`로 바꿉니다. 구조 목록의 배지는 manifest의 `structures[].status` 입니다. 기하를 바꾸면 `model_version`을 올리고 관련 문안을 다시 `미검증`으로 되돌립니다.

## 검수 배지

| 표시 | 뜻 |
| --- | --- |
| 미검증 | 아직 확인하지 않음 |
| YS 검수 완료 | 검토를 마침 |

## 출처와 라이선스

목표 표본은 OpenEar 라이브러리의 ZETA입니다.

- 논문: Sieber et al., Scientific Data 2018, <https://www.nature.com/articles/sdata2018297>
- 데이터: <https://zenodo.org/records/1473724>
- 라이선스: CC BY 4.0

실제 파일을 넣는 순간 다음을 바닥글과 출처 페이지에 유지해야 합니다.

- 저작자 표시 (Sieber et al., OpenEar)
- 바꾼 점이 있으면 그 사실
- CC BY 4.0 이름과 링크

현재 빌드는 그 기하를 포함하지 않습니다.

`/vor/` 는 절차적으로 만든 모식입니다. Z-Anatomy 메시는 쓰지 않습니다. 반고리관 법선은 Della Santina 등, JARO 2005 Table 1B이고, 그 밖 수치는 `public/vor/` JSON에 있습니다. `reviewStatus`가 `verified`가 아니면 화면은 `미검증 / Unverified`입니다.

## 나중 작업

3D 핀 댓글, Google 로그인, 역할(owner / reviewer / viewer)은 구현하지 않았습니다. 레코드 모양은 [docs/comments-backend.md](docs/comments-backend.md) 에 있습니다. 핀은 `{page, structure_id, mm xyz, model_version, author, resolved}` 입니다.
