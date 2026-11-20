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

구조마다 해부, 기능, 수술 포인트를 한 파일에 둡니다. 섹션은 저마다 `source`와 `status`를 가집니다.

```json
{
  "id": "chorda_tympani",
  "model_version": "openear-zeta-sample-0",
  "info": {
    "summary": { "ko": "[샘플] 해부 설명", "en": "[Sample] anatomy" },
    "source": "어디에 근거했는지",
    "status": "미검증"
  },
  "function": {
    "physiology": { "text": { "ko": "", "en": "" }, "source": "", "status": "미검증" },
    "injury": { "text": { "ko": "", "en": "" }, "source": "", "status": "미검증" },
    "tests": { "text": { "ko": "", "en": "" }, "source": "", "status": "미검증" }
  },
  "related": ["facial_nerve"],
  "surgical_points": [
    {
      "id": "chorda-origin",
      "title": { "ko": "", "en": "" },
      "body": { "ko": "", "en": "" },
      "position_mm": [0, 0, 0],
      "source": "",
      "status": "미검증"
    }
  ]
}
```

- `info`는 해부입니다.
- `function.physiology`는 생리적 역할, `injury`는 손상·기능 이상의 임상 결과, `tests`는 관련 검사입니다.
- `related`는 생략할 수 있는 구조 id 목록입니다. 정보 패널에서 이름을 누르면 그 메시가 강조됩니다. 자기 자신이나 목록에 없는 id는 거부됩니다. 예: 고실끈신경 → `facial_nerve`.
- `surgical_points[].position_mm`는 표본 밀리미터입니다. 뷰어 오프셋을 더하지 않습니다.

지금 들어 있는 문장은 모두 `[샘플]`이고 상태는 `미검증`입니다. 검토자가 채우기 전의 자리입니다.

## presets.json

`presets[]`는 `camera.position`, `camera.target`, 선택적 `up`과 `fov`, 선택적 `clipping`입니다. 자르기 평면은 표본 공간에서 `dot(normal, p) + constant >= 0`인 쪽을 남깁니다. 뷰어가 오프셋만큼 평행이동한 뒤 Three.js 월드 평면으로 바꿉니다.

## ct/volume.json

| 필드 | 의미 |
| --- | --- |
| `spacing_mm` | 복셀 간격 |
| `origin_mm` | 복셀 (0,0,0)의 **중심** |
| `direction` | 행 우선 3×3. 열 0/1/2가 i/j/k가 증가하는 방향 |
| `dims` | i, j, k 개수 |
| `planes.axial.axis` | 1 (위아래, j). 앞쪽이 화면 위 |
| `planes.coronal.axis` | 2 (앞뒤, k). 위쪽이 화면 위 |
| `planes.sagittal.axis` | 0 (좌우, i). 위쪽이 화면 위 |

슬라이스 파일은 `{folder}/00.png`처럼 인덱스를 두 자리로 적습니다. 평면의 가로·세로는 `dims * spacing` 밀리미터이고, 메시와 같은 공간에 놓입니다.
