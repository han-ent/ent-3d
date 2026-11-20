# 3D 핀 댓글 백엔드 (설계만)

이 문서는 나중 작업을 위한 설계입니다. Supabase 프로젝트, 로그인, 테이블, 키는 아직 없습니다. 유료 서비스는 쓰지 않고, 쓴다면 Supabase 무료 한도 안을 전제로 합니다.

## 역할

| 역할 | 할 수 있는 일 |
| --- | --- |
| owner | 검수 상태 변경, `model_version` 게시, 아무 댓글이나 해결 |
| reviewer | 댓글 작성, 내용 JSON 수정 제안. 검토자는 커밍스 / YS |
| viewer | 열람 |

## 로그인

Google 로그인은 Supabase Auth로 붙입니다. 역할은 사용자 테이블에 두고, 기본값은 viewer입니다.

## 핀

좌표는 표본 밀리미터입니다. `viewer_offset_mm`를 더하지 않습니다. 메시가 바뀌면 예전 핀이 따라가지 않도록 `model_version`을 반드시 저장합니다. 값은 `manifest.json`의 `model_version`과 같습니다.

```json
{
  "page": "temporal-bone",
  "structure_id": "chorda_tympani",
  "x_mm": -2.2,
  "y_mm": 2.6,
  "z_mm": -2.6,
  "model_version": "openear-zeta-sample-0",
  "author": "auth-user-id",
  "resolved": false
}
```

| 필드 | 설명 |
| --- | --- |
| `page` | `temporal-bone` 또는 `vor` |
| `structure_id` | manifest의 구조 id. 빈 공간 핀이면 null |
| `x_mm`, `y_mm`, `z_mm` | 표본 밀리미터 |
| `model_version` | 핀을 단 기하 버전 |
| `author` | 작성자 |
| `resolved` | 해결 여부 |

본문과 작성 시각은 같은 레코드에 둡니다. 행 수준 보안은 viewer는 읽기, reviewer는 자기 글 작성과 미해결 글 수정, owner는 전체 수정으로 나눕니다.

검수 배지(`미검증`, `YS 검수 완료`)는 댓글과 별개로 content JSON에 남습니다. 댓글이 해결되어도 문안 상태가 자동으로 바뀌지는 않습니다.
