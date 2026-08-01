# Handoff

에이전트가 작업을 중단하거나 다른 에이전트에게 넘길 때 이 파일을 갱신한다. “거의 완료” 같은 표현 대신 재현 가능한 상태를 남긴다.

## Current State

- Date: 2026-07-31
- Agent: Claude (Opus 5)
- Branch/commit: git 저장소 아님 (버전 관리 미사용)
- Current phase: Phase 1–6, 8 완료 · Phase 7(IFFT) 사용자 지시로 보류 · Phase 10 QA 완료
- Working build: `index.html` + `src/**/*.js` (ES 모듈, 빌드 단계 없음)
- How to run:
  ```bash
  node serve.mjs        # → http://localhost:8173
  ```
- Last successful browser test: 2026-07-31, HeadlessChrome 151.0.0.0 (CDP), macOS 26.5.2, Apple M5

## What Works

- WebGPU 백엔드 확정 동작. `?forcewebgl=1`로 WebGL 2 폴백도 동일 코드베이스로 정상 렌더
- 20성분 3밴드 Gerstner. 해석적 법선·Jacobian. 접힘 조건 `Σk·H = choppy ≤ 1`로 구조적 보장
- 카메라 중심 방사형 단일 메시(High 384링×448섹터, rim 60 km). LOD 균열 불가능
- Schlick Fresnel + Beer–Lambert + Cox–Munk 기반 GGX 글리터 + 역광 정상 투과
- 하늘/반사/대기 3변형이 같은 TSL 함수를 공유 → 수평선이 구조적으로 연속
- 포말: Jacobian crest + 2스케일 침식 + 256² ping-pong 히스토리(감쇠·풍하 이류)
- 수중: 히스테리시스 판정, 채널별 흡수, 스넬 창, 절차적 해저 + 카우스틱, 부유 입자
- 프리셋 5종 1.5 s 보간. 전 파라미터가 uniform이라 재컴파일 0회
- 자체 UI 패널 (슬라이더 26 · 색 5 · 토글 4 · 품질 4 · 프리셋 5), 단축키 H/P/R/F/1-5
- QA 하네스 `tools/qa.mjs` — 실 Chrome을 CDP로 구동해 캡처·성능·스트레스·소크 자동화

## What Does Not Work

- IFFT/FFT Ultra 경로 (미착수, 사용자 지시)
- 폭풍 비/스프레이, 부유 오브젝트, 프리셋 URL 공유 (미착수)
- 물기둥 god ray (해저 카우스틱만 있음)
- 모바일/저사양 GPU 미검증

## Exact Blocker

없음.

## Files Changed

| File | Purpose | Verified |
|---|---|---|
| `index.html` | 진입점, importmap, 오버레이 마크업, 라이선스 고지 | ✅ |
| `serve.mjs` | 정적 서버 + `/__save` 캡처 싱크 | ✅ |
| `tools/qa.mjs` | CDP QA 하네스 (smoke/shots/perf/stress/soak/eval) | ✅ |
| `vendor/three-0.185.1/` | three r185 배포 4파일 (무수정, MIT) | ✅ |
| `src/main.js` | 부트스트랩·루프·품질·오류 처리 | ✅ |
| `src/core/{util,renderer,diagnostics}.js` | RNG/수학, 렌더러 초기화, 계측·QA 훅 | ✅ |
| `src/env/{uniforms,sky,presets}.js` | 상태 단일 소스, 절차적 하늘, 프리셋 5종 | ✅ |
| `src/ocean/{waves,geometry,shading,material,foam}.js` | 파동·메시·셰이딩 헬퍼·물 재질·포말 히스토리 | ✅ |
| `src/underwater/{pipeline,scenery}.js` | 수중 포스트 패스, 해저·입자 | ✅ |
| `src/input/controls.js` | fly 카메라 | ✅ |
| `src/ui/panel.js` | 설정 패널 + HUD | ✅ |
| `src/style.css` | UI 스타일 | ✅ |

## QA Snapshot

- Console errors: **0** (`setConsoleFunction` + `window.onerror` + `unhandledrejection` + CDP `Log`/`Runtime` 전부)
- Backend: WebGPU (폴백 WebGL 2 확인)
- Viewport: 1920×1080 및 1280×720
- Average FPS: 60.0 (16.67 ms) — vsync 상한. 2688×1512 Ultra에서야 19.54 ms로 벗어남
- 1% low: 53.8 (1080p High)
- Screenshots: `qa/qa-*.png` 9종
- Acceptance blockers remaining: 없음

## Next Three Actions

1. (선택) IFFT Ultra 경로를 별도 모드로 추가 — Gerstner 경로를 폴백으로 유지할 것
2. (선택) 부유 오브젝트 추가 — 파도 스케일 감각을 크게 올린다
3. (선택) 프리셋 URL hash 공유

## Do Not Repeat

이 프로젝트에서 실제로 시간을 크게 잡아먹은 함정들. 다시 밟지 말 것.

1. **TSL `Loop()` / `.toVar()`를 `Fn()` 밖에서 호출하지 말 것.**
   빌더의 현재 스택이 없어 루프 본문이 셰이더에 생성되지 않는다. 오류도 경고도 없이
   누산기가 0으로 남아 "수학적으로 완벽하지만 아무것도 변위시키지 않는" 파동이 된다.

2. **`canvas.toDataURL()`로 QA 스크린샷을 찍지 말 것.**
   표시된 표면을 읽으므로 `render()` 직후에는 이전 프레임이 나온다. WebGL 2에서는
   `preserveDrawingBuffer`가 없어 검게 나오기도 한다. 반드시 CDP `Page.captureScreenshot`.

3. **인앱/임베디드 브라우저 팬에서 성능이나 애니메이션을 판정하지 말 것.**
   페이지를 `visibilityState: "hidden"`으로 보고해 `requestAnimationFrame`이 아예 돌지 않는다.
   `window.__advance()` 훅으로 수동 전진은 가능하지만 FPS는 무의미하다.

4. **깊이에서 월드 좌표를 복원할 때 역투영 행렬에 의존하지 말 것.**
   클립 공간 z 범위와 `screenUV`의 상하 방향이 WebGPU/WebGL 백엔드 간에 다르다.
   애초에 그 복원이 정말 필요한지부터 의심할 것 — 이 프로젝트에서는 필요 없었다.

5. **같은 광원을 두 번 그리지 말 것.**
   반사 환경의 태양 글로우와 분석적 스페큘러 로브는 같은 태양이다. 둘 다 켜면
   넓고 흐린 워시가 깔려 물빛과 섞이며 탁해진다.

6. **`PlaneGeometry`는 XY 평면이다.** `.xz`를 쓰면 평면이 선으로 붕괴한다.
   X축 −90° 회전 후 월드 Y 변위는 로컬 Z를 음수로 밀어야 한다.


---

## Phase 14 addendum (2026-07-31)

### State

10 presets, volumetric clouds in a dedicated 0.4x target, screen-space rain, shared
seabed bathymetry/albedo between the water surface and the seabed mesh. 60 fps at
1920x1080 on every preset except the lagoon underwater view (54.9). Console errors 0.
Spectral verification unchanged and passing.

### Do Not Repeat (additions)

7. **Do not use `fract(sin(dot(screenUV, k)) * 43758)` for per-pixel dither.** The
   argument to sin() reaches ~4e6 where float32 has ~0.25 of absolute precision, and
   the sequence collapses onto a lattice you can see. Use interleaved gradient noise
   on pixel coordinates.
8. **Do not put data in the alpha channel of an opaque NodeMaterial.** It is forced to
   1 with no warning. `transparent = true` + `blending = NoBlending`.
9. **Do not trust a single "60 fps" reading.** At 1080p it means "at or under the vsync
   cap" and hides everything. Attribute cost with a kill switch (`?cloudscale=0`) or
   measure at 4K. And re-measure before acting: a bad number here was thermal, not real.
10. **Gate expensive optional shading on a uniform, and check the gate actually fires.**
    The first cheap/full density split used a bound two standard deviations out, so
    nearly every sample took the expensive branch and the optimisation measured as noise.

### Highest-value next work

1. A hero floating object with waterline foam, hull shadow and a wake. This is the
   largest remaining visual gap against the commercial reference — the scene currently
   has no water/object contact at all.
2. Sharper shallow water. The refraction uses the full rippled normal, so the bottom
   pattern averages out per pixel; damping the normal used for the refraction ray
   (while keeping it for reflection) should recover the crystalline look.
3. Orbit camera mode, and a quality tier above Ultra.
