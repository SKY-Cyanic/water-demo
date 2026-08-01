# Implementation Plan

## 0. 성공 정의

한 장짜리 기술 데모가 아니라 카메라를 자유롭게 움직이고 프리셋을 바꿔도 고급스러운 인상을 유지하는 실시간 바다를 만든다. 최종 산출물은 외부 상용 자산 없이 실행되는 단일 `index.html`이다.

## 1. 아키텍처

```text
App
├─ Capability / Loading / Error UI
├─ Renderer
│  ├─ WebGPU primary
│  └─ WebGL2-compatible fallback
├─ Environment
│  ├─ Sun and sky
│  ├─ Atmosphere and fog
│  └─ Preset interpolation
├─ Ocean
│  ├─ Camera-centered geometry / LOD
│  ├─ Gerstner simulation
│  ├─ Optional IFFT compute path
│  ├─ Water material
│  └─ Foam history
├─ Underwater
│  ├─ Medium detection
│  ├─ Absorption / fog
│  ├─ Caustics
│  └─ Particles
├─ Interaction
│  ├─ Camera controls
│  ├─ Settings panel
│  └─ Keyboard shortcuts
└─ Diagnostics
   ├─ FPS / frame time
   ├─ Backend / quality
   └─ Error capture
```

## 2. 단계

### Phase 0 — 조사와 기준 고정

목표:

- 현재 Three.js 안정 버전과 import 경로 확인
- 공식 WebGPU/TSL 예제 실행 확인
- 목표 브라우저와 테스트 해상도 기록
- 참고할 오픈소스의 라이선스 확인

완료 조건:

- `research.md`에 확인 날짜, 버전, URL, 라이선스 기록
- 빈 장면이 브라우저에서 오류 없이 렌더링

### Phase 1 — 수직 슬라이스

구현:

- 전체 화면 canvas
- WebGPU 우선 초기화
- 로딩/오류 오버레이
- 카메라, orbit/fly 입력
- 절차적 하늘과 안개
- 움직이는 기본 수면
- 리사이즈와 DPR 제한

완료 조건:

- 빈 화면, NaN, 셰이더 컴파일 오류 없음
- 1920×1080에서 60초 안정 실행
- UI가 canvas 입력을 방해하지 않음

### Phase 2 — 파동 형태

구현:

- seed 기반 12~20개 Gerstner wave
- 장파/중파/단파 그룹
- 분석적 법선 또는 검증된 안정 법선
- 카메라 중심 수면 영역
- 원거리 디테일 감쇠

튜닝 목표:

- 파도가 한 방향의 젤리처럼 움직이지 않음
- 반복 패턴이 가까운 거리에서 쉽게 드러나지 않음
- 급경사를 올려도 메시가 심하게 뒤집히지 않음

### Phase 3 — 고급 수면 광학

구현:

- Fresnel
- 하늘 반사
- 깊이 흡수와 산란색
- 태양 반짝임과 파도 정상 투과광
- 수평선 헤이즈
- 톤 매핑과 노출

완료 조건:

- 정면과 사선 시점의 물이 확실히 다르게 보임
- 물이 금속판이나 불투명 파란 플라스틱처럼 보이지 않음
- 태양 위치와 하이라이트 방향이 일치

### Phase 4 — 포말

1차:

- 경사·곡률·압축 기반 crest mask
- 다중 스케일 절차적 noise
- 거리별 포말 가독성 조절

2차:

- 저해상도 history buffer
- decay
- 간이 advection
- 프리셋별 threshold와 lifetime

완료 조건:

- 낮은 파도 전체가 흰색으로 덮이지 않음
- 포말이 정상 부근에서 생기고 바로 깜빡이지 않음
- 폭풍 프리셋과 잔잔한 프리셋의 차이가 명확

### Phase 5 — 하늘, 날씨, 프리셋

구현:

- 하나의 sun direction을 모든 시스템에 공유
- 하늘 색, 태양 원반, 안개, 노출
- 얇은 절차적 구름
- 최소 5개 프리셋
- 1~2초 부드러운 상태 보간
- Storm에서 빗줄기/스프레이는 성능 여유가 있을 때 추가

완료 조건:

- 프리셋이 단순 색 필터가 아니라 파동·광원·안개까지 달라짐
- 전환 도중 깜빡임이나 uniform 불연속 없음

### Phase 6 — 수중

구현:

- 카메라 위치에서 수면 높이 평가
- 위/아래 상태 히스테리시스
- 수중 흡수·안개
- 절차적 카우스틱 인상
- 부유 입자
- 수면 아래쪽 가시성

완료 조건:

- 경계 왕복 시 화면이 빠르게 깜빡이지 않음
- 수중에서 하늘이 그대로 보이는 오류 없음
- 수심 증가에 따라 색과 가시거리가 자연스럽게 변함

### Phase 7 — 선택적 IFFT Ultra 경로

도입 판단:

- Phase 1~6이 이미 통과한 뒤 진행
- 현재 Gerstner 경로를 폴백으로 유지
- 목표 장비에서 compute 경로의 품질 향상이 비용보다 큰 경우만 기본값 후보

구현:

- 2~3 cascade spectrum
- time evolution
- inverse FFT
- displacement, slope/normal
- 품질별 128/256/512 선택

중단 조건:

- 브라우저 호환 문제로 기본 경로까지 깨짐
- 초기 컴파일 또는 메모리 비용이 과도함
- 스크린샷 비교에서 품질 향상이 거의 없음

### Phase 8 — 최적화와 복원력

- 자동 품질 또는 명시적 Low/Medium/High/Ultra
- DPR 1.0/1.25/1.5 제한
- 숨겨진 탭에서 업데이트 축소
- dispose와 이벤트 해제 점검
- resize, context/device loss 처리
- 작은 화면에서 패널 접기
- `prefers-reduced-motion` 고려

### Phase 9 — 단일 HTML 패키징

- CSS, JS, 셰이더, 절차적 데이터 통합
- CDN 버전 고정
- blob worker가 필요하면 HTML 내부 문자열로 생성
- 외부 런타임 자산 요청 목록 검사
- 개발 파일과 최종 HTML 결과 비교

### Phase 10 — 최종 QA

- `acceptance.md` 전체 수행
- 5개 프리셋 각각 스크린샷
- 수면 위/아래 스크린샷
- 프레임 시간 측정
- 콘솔 로그 저장
- 알려진 제한을 `log.md`에 기록

## 3. 성능 예산

목표 장비 기준:

| 항목 | High 목표 | 허용 한계 |
|---|---:|---:|
| 해상도 | 1920×1080 | 브라우저 viewport 기준 |
| 평균 FPS | 60 이상 | 50 이상 |
| 1% low FPS | 45 이상 | 30 이상 |
| 첫 상호작용 가능 | 5초 이내 | 10초 이내 |
| 프리셋 전환 | 끊김 체감 없음 | 250ms 이상 멈춤 없음 |
| 지속 메모리 증가 | 없음 | 5분 동안 일방 증가 없음 |

목표 장비보다 느린 GPU에서는 품질을 낮춰 30 FPS 이상을 우선한다. 측정값을 만들지 말고 실제 결과를 `log.md`에 기록한다.

## 4. 위험과 대응

| 위험 | 조기 신호 | 대응 |
|---|---|---|
| Three.js WebGPU API 변경 | import/노드 컴파일 오류 | 버전 고정, 공식 예제와 최소 재현 |
| FFT가 일정 전체를 막음 | 며칠째 검은 화면/NaN | Gerstner 완성 경로로 복귀 |
| 포말 깜빡임 | 프레임마다 패턴 소실 | history buffer와 temporal smoothing |
| LOD 균열 | 카메라 이동 시 선/구멍 | 스커트, 중첩 링, 안개 |
| 수평선 인공적 경계 | 메시 끝이 보임 | camera-centered geometry와 haze |
| 과도한 GPU 비용 | 프레임 시간 급증 | DPR, cascade, cloud/foam 품질 축소 |
| 단일 HTML 비대화 | 파싱과 유지보수 악화 | 개발은 모듈식, 마지막에 자동 번들 |
| 외부 자산 의존 | 오프라인/링크 실패 | procedural-first, 요청 목록 감사 |

