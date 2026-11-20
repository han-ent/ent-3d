# 자료 스키마

뷰어는 코드를 다시 빌드하지 않고 `public/temporal-bone/` 의 JSON을 읽습니다. 검토자는 여기만 고칩니다. 좌표는 모두 표본 밀리미터이고, 메시 배율은 없습니다.

공통 상태 값은 정확히 둘입니다.

- `미검증` — 기본값. 아직 확인하지 않음.
- `YS 검수 완료` — 검토를 마침.

기하가 바뀌면 `model_version`을 올리고, 그 전 문안은 다시 `미검증`으로 되돌립니다.

## manifest.json

| 필드 | 의미 |
| --- | --- |
| `specimen` | 표본 이름, 라이선스, 논문·데이터 주소, `model_version` |
| `model_version` | `specimen.model_version`과 같아야 함. 댓글 핀이 이 값에 묶입니다. |
| `viewer_offset_mm` | 화면에서만 쓰는 평행이동. 꼭짓점은 바꾸지 않습니다. |
| `coordinate_system.units` | `mm`만 허용 |
| `layers[]` | 묶음 id, 이름, 초기 불투명도 0–1 |
| `structures[]` | id, `file`(.glb), 이름, `#rrggbb`, layer, status, `content` 경로 |

`structures[]`에 `scale`을 넣으면 스키마 검사가 실패합니다.

## content/*.json

구조마다 해부, 기능, 수술 포인트, 출처를 한 파일에 둡니다. 문안 초안은 이 모양 그대로 넣습니다. 문장을 코드에서 고치지 않습니다.

```json
{
  "id": "chorda-tympani",
  "model_version": "openear-zeta-ras-1",
  "anatomy": { "ko": "해부 문장", "en": "" },
  "function": { "ko": "기능 문장", "en": "" },
  "surgical_points": [
    { "id": "chorda-tympani-p1", "text": { "ko": "수술 문장", "en": "" } }
  ],
  "sources": [
    { "citation": "책, 장", "page": "123", "verified": true }
  ],
  "review": "미검증",
  "related": ["facial-nerve"]
}
```

- `anatomy`와 `function`은 한국어·영어 문장입니다. `[샘플]`이 들어 있으면 화면은 이름과 "설명 준비 중"만 보여 줍니다.
- `sources[].verified`가 false이면 그 출처와, 본문에 "확인하지 못해"가 있는 문장에 "출처 확인 필요"를 붙입니다. 문장은 그대로입니다.
- `review`는 `미검증` 또는 `YS 검수 완료`입니다.
- `related`는 생략할 수 있는 구조 id입니다. 자기 자신이나 없는 id는 거부됩니다.
- `surgical_points[].position_mm`는 있을 때만 둡니다. 좌표가 있으면 `source`와 `review`가 필요합니다. 뷰어 오프셋을 더하지 않습니다.
- 와우 초안은 와우 메시가 없어 `scala-vestibuli.json`과 `scala-tympani.json`에 같은 문장으로 둡니다. S상정맥동 초안은 `sinus-dura.json`에 둡니다.

## presets.json

`sequences[]` 안의 `steps[]`가 절제 순서입니다. 배열 순서가 진행 순서입니다. 드릴은 없고, 설계는 [dissection-lab.md](dissection-lab.md)에 있습니다.

각 단계:

| 필드 | 의미 |
| --- | --- |
| `title`, `instructions` | 한국어·영어. 문안은 검토 전 |
| `identify` | 이 단계에서 찾을 구조 id |
| `danger` | 위험 구조 id. 거리 계산은 아직 없음 |
| `camera` | `position`, `target`, 선택적 `up`, `fov`. 표본 밀리미터 |
| `clipping` | 선택. `dot(normal, p) + constant >= 0` 인 쪽을 남김 |

뷰어가 오프셋만큼 평행이동한 뒤 자르기 평면을 Three.js 월드 좌표로 바꿉니다.

## ct/volume.json

ZETA CT는 RAS, 0.25 mm, `texture_flip_y: false` 입니다. 원점은 복셀 (0,0,0)의 중심입니다.

| 평면 | 고정 축 | 가로 (열) | 세로 (행) | 파일 행 0 |
| --- | --- | --- | --- | --- |
| axial | z (위) | x | y | y 최대 (앞) |
| coronal | y (앞) | x | z | z 최대 (위) |
| sagittal | x (오른쪽) | y | z | z 최대 (위) |

`direction`은 행 우선 3×3이고 열 0/1/2가 i/j/k 방향입니다. 슬라이스 파일은 `{folder}/{index}` 를 `index_digits` 자리와 `file_extension`으로 만듭니다. ZETA는 `161.webp`처럼 세 자리 webp입니다.

`flipY`가 false이면 파일의 첫 행은 텍스처 v=0, 즉 평면의 아래쪽에 붙습니다. `row_0_is_max`가 true이면 그 아래쪽이 행 축의 큰 값이 되도록 평면의 세로 축을 뒤집습니다. 메시와 같은 RAS 밀리미터에 놓입니다.
