# Research and Source Boundary

마지막 확인일: 2026-07-31

이 문서는 구현 방향을 정하는 참고점이다. 실제 구현을 시작할 때 현재 API와 라이선스를 다시 확인한다.

## 1. 공식 Three.js 자료

### WebGPURenderer

- 문서: https://threejs.org/docs/pages/WebGPURenderer.html
- 확인 내용:
  - WebGPU를 우선 선택
  - 지원되지 않으면 WebGL 2 backend를 사용할 수 있는 구조
  - `forceWebGL` 등 옵션은 현재 문서 기준으로 존재
- 주의:
  - Three.js WebGPU/TSL API는 변경 속도가 빠르므로 import와 material API를 버전별로 재검증

### WebGPU capability helper

- 문서: https://threejs.org/docs/pages/WebGPU.html
- 공식 import 예:
  - `three/addons/capabilities/WebGPU.js`
- 용도:
  - 지원 여부 표시와 오류 UI 참고

### 공식 compute water 예제

- 예제: https://threejs.org/examples/webgpu_compute_water.html
- 용도:
  - WebGPU compute 초기화, 업데이트 루프, 현재 Three.js 스타일 확인
- 금지:
  - 예제를 이해하지 않고 통째로 붙인 뒤 자체 구현이라고 주장

## 2. 공개 IFFT 참고 구현

### Threejs-WebGPU-IFFT-Ocean

- 저장소: https://github.com/Spiri0/Threejs-WebGPU-IFFT-Ocean
- 저장소 표시 라이선스: MIT
- 공개 설명 기준:
  - JONSWAP ocean model
  - inverse FFT
  - WebGPU
  - 3×512 cascade 관련 구현 기록
  - SharedArrayBuffer 사용 시 서버 헤더 조건에 주의
- 사용 원칙:
  1. 현재 `LICENSE` 원문 확인
  2. 복사한 코드가 있으면 원 저작권 고지와 MIT 조건 유지
  3. 참고만 하고 재작성했다면 무엇을 참고했는지 기록
  4. Water Pro의 구현이라고 오인하지 않기

## 3. 일반 렌더링 기법

특정 제품에 종속되지 않는 공개 지식:

- Gerstner waves
- Phillips/JONSWAP wave spectra
- inverse fast Fourier transform ocean
- Schlick Fresnel approximation
- Beer–Lambert absorption
- normal-based sun specular
- curvature/slope/Jacobian crest detection
- temporal accumulation and ping-pong buffers
- projected grid, concentric ring LOD, clipmap
- atmospheric scattering approximations
- procedural caustics

공식 문서, 논문, 저자 공개 자료 같은 1차 출처를 우선한다. 블로그 코드를 그대로 가져오지 않는다.

## 4. 상용 참조 사이트를 보는 방법

허용:

- 일반 사용자처럼 장면을 보고 색감, 구도, 기능 범주, UX를 관찰
- 자체 데모와 나란히 두고 “파도 스케일이 부족함”, “포말이 너무 균일함”처럼 고수준 차이를 기록
- 공개 마케팅 문서의 기능 목록을 비교 기준으로 사용

금지:

- 번들 디컴파일 또는 난독화 해제
- 비공개 셰이더, 텍스처, 모델, 설정 JSON 추출
- 네트워크 요청에서 상용 자산 저장
- 브랜드, 로고, 카피, 고유 UI를 따라 만들기
- 원본 스크린샷을 텍스처나 배경으로 사용

## 5. CDN과 배포

- Three.js CDN 버전을 명시적으로 고정
- `latest` 태그 사용 금지
- `file://`만을 기준으로 성공 판정하지 않음
- WebGPU와 ES module은 로컬 HTTP 서버 또는 HTTPS에서 검수
- SharedArrayBuffer가 필요하면 COOP/COEP 요구사항을 기록
- 최종 단일 HTML이 CDN 하나만 요구하는지, 추가 자산 요청이 없는지 네트워크 패널로 확인

## 6. 구현 결정 기록

에이전트는 아래 표를 채운다.

확인일: 2026-07-31. 아래는 추측이 아니라 npm 레지스트리와 배포 파일 실물을 대조한 결과다.

| 항목 | 선택 | 이유 | 검증 |
|---|---|---|---|
| Three.js version | **0.185.1** | 2026-07-01 릴리스, 최신 안정 | `registry.npmjs.org/three` dist-tags 조회 |
| Renderer | **WebGPURenderer** | 생성자가 `getFallback = () => new WebGLBackend()`를 자동 설치 → 코드베이스 하나로 WebGPU/WebGL2 양쪽 | 배포 소스에서 해당 분기 확인. 실행 시 `backend.isWebGPUBackend === true` |
| Node/shader API | **TSL + `MeshBasicNodeMaterial` 전면 커스텀 `colorNode`** | `MeshStandardNodeMaterial`의 PBR 루프는 흡수·산란·Snell 창을 표현할 어휘가 없고 순수 오버헤드. 톤매핑/색공간은 렌더러가 처리하므로 셰이더는 linear HDR 출력 | 화면 검증. 콘솔 오류 0 |
| Geometry/LOD | **카메라 중심 방사형 단일 메시** (High 384링×448섹터, rim 60 km) | 연속 메시라 LOD 균열·T-junction이 원천적으로 불가능. 간격이 반경에 비례해 삼각형 종횡비가 전 구간 안정 | 1280×720 / 1920×1080에서 메시 끝·구멍 없음 확인 |
| Default wave path | **Gerstner 20성분 / 3밴드 / ω=√(gk)** | 성분별 물리 속도 → 주기가 서로 무리수 관계라 짧은 반복 루프가 안 생김. `H_i = choppy·qw_i/k_i` 형태라 접힘 조건이 `Σk·H = choppy ≤ 1`로 붕괴 → 어떤 파고에서도 정점 뒤집힘 없음 | `Hs` 정규화 검증값 1.000, 실측 진폭 ±1.04 m @ waveHeight 1.8 |
| Ultra wave path | **보류 (미구현)** | 사용자 지시. Gerstner 경로를 완성품 수준으로 마감하는 쪽을 우선 | `task.md` P2 미착수로 표기 |
| Foam history | **Jacobian 압축 + 경사 결합 crest mask** (즉시형). ping-pong 히스토리는 Phase 4 | 높이만 쓰는 방식은 파도 전체를 희게 만든다. Jacobian은 실제 압축 지표 | 화면에서 정상 부근에만 생성됨 확인 |
| Underwater method | **CPU 미러 파고 비교 + ±0.16 m 히스테리시스**, 렌더는 `RenderPipeline`(Phase 6) | `PostProcessing`은 r183부터 deprecated → `RenderPipeline`으로 개명됨 | 배포 소스의 deprecation 경고 확인. 판정 전환은 동작 확인 |
| CDN/offline | **로컬 vendoring** `vendor/three-0.185.1/` 4파일 | 30회 이상 반복되는 검수 루프가 네트워크 상태에 좌우되지 않음. 버전이 경로에 고정됨. 외부 자산 요청 0건 | `three.webgpu.js → ./three.core.js` 상대 참조라 build 3파일로 완결됨을 확인 |
| License notices | **Three.js r185 MIT** | 유일한 서드파티 | `vendor/three-0.185.1/LICENSE` 원문 보존 + `index.html` 상단 주석에 출처 URL·MIT 고지 |

### 사용 라이브러리 경계

- **가져온 것:** Three.js r185 배포 빌드 3파일 (무수정 vendoring). MIT.
- **참고만 하고 직접 작성한 것:** Gerstner 합·분산관계·급경사 정규화, Schlick Fresnel,
  Beer–Lambert 흡수, Jacobian crest 검출, 대기 그라디언트/Mie 근사, Worley 카우스틱,
  방사형 메시 생성, 카메라 컨트롤러, UI 패널.
- **상용 데모에서 가져온 것:** 없음. 코드·셰이더·텍스처·모델·설정값·브랜드·UI 배치 모두 미사용.

### API 함정 기록 (다음 세션이 다시 밟지 않도록)

1. **`PostProcessing`은 r183부터 deprecated → `RenderPipeline`.** 생성자·메서드 동일.
2. **`three.tsl.js`는 내부에서 `import { TSL } from 'three/webgpu'`를 한다.**
   importmap에 `three/webgpu` 매핑이 없으면 로드 자체가 실패한다.
3. **TSL `Loop()` / `.toVar()`는 반드시 `Fn()` 콜백 안에서 호출해야 한다.**
   밖에서 부르면 빌더의 현재 스택이 없어 루프 본문이 셰이더에 생성되지 않는다.
   컴파일 오류도 경고도 나지 않고 누산기가 조용히 0으로 남는다. (`log.md` 문제 1)
4. TSL에 `atan2`는 없다. 2인자 `atan`을 쓴다.
5. `bloom`/`fxaa`/`gtao`는 코어 TSL이 아니라 addons(`three/addons/tsl/display/*`)에 있다.
6. **`screenUV`는 텍스처 규약(y 아래 방향)이다.** NDC(y 위 방향)로 쓰려면 뒤집어야 한다.
   그대로 역투영에 넣으면 화면이 상하로 미러링되어 "위를 보는" 광선이 전부
   "아래를 보는" 광선이 된다 — 오류 없이, 기하만 틀린다.
7. **클립 공간 z 범위가 백엔드마다 다르다** (WebGPU 0..1 / WebGL −1..1).
   깊이에서 뷰 광선을 만들 때 역투영 행렬 대신 카메라 FOV로 직접 만드는 편이 규약에 무관하다.
   더 나아가, 그 복원이 정말 필요한지부터 의심할 것. (`log.md` 문제 10)
8. **`PlaneGeometry`는 XY 평면(z = 0)이다.** `positionGeometry.xz`를 쓰면 평면이 선으로 붕괴한다.
   X축 −90° 회전 후에는 월드 Y 변위 = 로컬 Z를 음수로 미는 것. (`log.md` 문제 8)

## 8. QA 계측 함정

렌더링 API만큼이나 시간을 잡아먹은 부분이라 별도로 기록한다.

- **`canvas.toDataURL()`은 QA 스크린샷에 쓸 수 없다.** 표시(presented)된 표면을 읽으므로
  `render()` 직후 호출하면 이전 프레임이 나온다. WebGL 2 백엔드에서는 `preserveDrawingBuffer`가
  없어 합성 후 버퍼가 비워지므로 간헐적으로 순수 검정이 나온다.
  → **CDP `Page.captureScreenshot`** 을 쓸 것. 합성기에서 직접 가져오므로 두 백엔드 모두 정확하다.
- **임베디드/인앱 브라우저는 페이지를 `visibilityState: "hidden"`으로 보고할 수 있다.**
  그러면 `requestAnimationFrame`이 아예 발행되지 않아 렌더 루프가 한 번도 돌지 않는다.
  그 환경에서 측정한 FPS는 무의미하고, 스크린샷은 전부 로드 직후 프레임이다.
  → 성능·애니메이션 판정은 **실 Chrome을 CDP로 구동**해서만 한다 (`tools/qa.mjs`).
- 이 두 가지를 모르면 "존재하지 않는 렌더링 버그"를 추적하게 된다. 실제로 그랬다.


### 함정 9 — `NodeMaterial`은 불투명 재질의 알파를 1로 강제한다

렌더 타깃에 (색, 커버리지) 같은 4채널 데이터를 쓰려고 알파를 데이터 채널로 쓰면
`transparent = false`인 재질에서는 그 값이 조용히 1로 덮인다. 컴파일 오류도 경고도 없다.
`transparent = true` + `blending = NoBlending`이면 채널은 보존하면서 합성은 하지 않는다.

### 함정 10 — 화면 UV 기반 sin 해시는 float32에서 격자로 붕괴한다

`fract(sin(dot(screenUV, vec2(12.9898, 78.233))) * 43758.5453)`은 셰이더 예제의 관용구지만
정규화된 UV를 넣으면 sin의 인자가 ~4e6에 이른다. float32의 절대 정밀도가 그 크기에서 약
0.25라 난수열이 규칙적인 무늬가 된다. 픽셀 좌표 기반 interleaved gradient noise가 더 싸고
디더 용도로는 백색잡음보다 낫다(3×3 이웃 저불일치).

### 함정 11 — 상수만으로 조명한 항은 컴파일도 되고 그럴듯해 보인다

수면의 부피 색이 `ambient`와 `skyLight` **두 상수**로만 조명되고 있었다. 둘 다 법선과
무관하므로 어느 파면이든 같은 색이 나온다. 그런데 아래를 내려다보는 시선에서는 Fresnel이
반사를 2% 근처로 눌러버려서, 전경 픽셀은 사실상 전부 그 상수 조합이다.
결과는 "형태는 있는데 셰이딩이 없는" 물 — 흔히 "움직이는 평면"이라고 표현되는 그것이다.

일반화: **어떤 항이 법선에 의존하지 않는데 그 항이 결과의 대부분을 차지한다면,
기하는 렌더링되지만 조명은 렌더링되지 않는다.** 셰이더는 잘 컴파일되고 화면도 그럴듯하다.
찾는 방법은 "이 픽셀 색을 결정하는 입력이 무엇인가"를 항별로 세어보는 것뿐이다.

역방향 함정도 같이 있었다: 그 조명을 **픽셀 단위 법선**으로 넣으면 물체 색이
스페큘러와 같은 앨리어싱을 얻는다. 굴절·산란되어 나온 빛은 픽셀 안의 경사 분포 전체로
평균된 것이므로 파도 스케일 법선을 써야 한다.

### 함정 12b — 레이마치의 스텝을 화면 방사량에 비례시키지 말 것

수중 광선 마치에서 스텝을 `장면 깊이 / N`으로 잡았다. 수면까지의 거리는 아래에서 보면
**그 자체가 화면 중심으로부터의 방사 함수**다. 그래서 모든 샘플이 방사적으로 스케일된
좌표에 떨어졌고, 화면 전체가 카메라 축으로 수렴하는 별폭발이 되었다.

일반화: 마치의 스텝 크기가 화면 위치에 대해 매끄럽게 변하는 어떤 양에 비례하면,
샘플 좌표는 그 양의 등고선을 따라 정렬되고 무늬가 그 등고선을 그린다.
**스텝은 고정 거리로 잡고, 장면 깊이는 샘플을 가리는 용도로만 쓴다.**

같은 마치에서 두 번 더 틀렸고 둘 다 같은 종류다:

- **샘플링 주파수를 맞추지 않았다.** 표면용 카우스틱(셀 0.87 m)을 55 m를 10스텝으로
  나눈 마치에 그대로 썼다 — 5.5 m 간격, 여섯 셀 건너뛰기. 연속 샘플이 무상관이면
  마치는 신호가 아니라 잡음을 적분한다. 부피 적분에는 **부피용 필드**가 따로 필요하다.
- **클램프를 배제로 착각했다.** `max(-p.y, 0)`은 수면 위 샘플을 깊이 0으로 만들어
  *최대* 기여를 시킨다. 값을 유한하게 유지하는 것과 샘플을 빼는 것은 다른 일이다.
  경계면을 지나는 자취가 주름이 되어 화면에 그려진다.

### 함정 12 — 절차적 무늬가 의도의 정확한 반대를 그릴 수 있다

Worley F1 거리는 **셀 중심에서 0, 경계에서 최대**다. `1 - min(w1, w2)`를 7제곱하면
경계의 가는 웹이 아니라 중심의 동그란 덩어리만 남는다. 카우스틱 코드가 바로 위 주석에
"가는 필라멘트"라고 적어놓고 정확히 반대를 그리고 있었고, 그 상태로 여러 회차를 통과했다.

절차적 무늬는 **틀려도 자연스러워 보인다**. 육각 격자의 동그란 덩어리도 "무슨 무늬"로는
보이기 때문에 스크린샷 훑기에서 걸러지지 않는다. 노이즈 함수의 값이 어디서 극값을 갖는지
한 번은 종이에 적고 들어갈 것.

## 9. 성능 계측 함정 (Phase 14 추가)

### vsync 상한은 측정을 삼킨다

1080p에서 "60 fps / 16.67 ms"는 **"16.67 ms 이하"**라는 뜻이지 16.67 ms가 아니다.
어떤 기능이 3 ms를 쓰는지 4 ms를 쓰는지 이 숫자로는 알 수 없고, 상한 아래에서 무엇을 더해도
숫자가 변하지 않다가 어느 순간 갑자기 무너진다. 귀속하려면 그 기능만 끄는 스위치가 필요하다
(`?cloudscale=0`) 또는 상한이 없는 해상도(4K)에서 재야 한다.

### 같은 설정을 두 번 재라

Phase 14에서 동일한 코드가 20.84 ms와 16.67 ms로 나왔다. 연속으로 무거운 세션을 돌린 뒤의
측정이 4 ms 느렸다. 한 번의 나쁜 수치로 설계를 바꾸기 전에 재측정해야 한다 —
그러지 않았다면 필요 없는 최적화에 시간을 더 썼을 것이다.

### 페어링도 상한에 붙은 측정은 구하지 못한다 (Phase 18 추가)

굴절 비용을 페어드 A/B로 쟀더니 세 라운드 전부 델타가 **정확히 0**이었다.
양쪽 arm이 둘 다 16.67 ms에 앉아 있었기 때문이다. 상한 아래에서는 어떤 항도
보이지 않고, arm을 아무리 정교하게 교대해도 0에서 0을 빼면 0이다.

즉 **순서 교대는 열 드리프트를 지우고, 상한은 신호 자체를 지운다.** 서로 다른 두
고장이고 해법도 다르다: 드리프트는 페어링으로, 상한은 **프레임이 상한을 벗어나는
해상도**(1080p라면 dpr 2, 픽셀 4배)로 재야 한다. `qa.mjs abshafts`가 dpr을 받는
이유다.

증상이 "깨끗한 0"이라 오히려 신뢰하기 쉽다는 점이 이 함정의 위험한 부분이다.
**델타가 0으로 나오면 먼저 두 arm의 절대값이 상한에 붙어 있는지 본다.**

### 기준선은 파일이 아니라 지금 돌린 측정이다 (Phase 16 추가)

Phase 16에서 Storm Front의 spark가 커밋된 `report-flicker.json`의 4.59%에서 10.9%로
올라간 것을 보고 회귀로 판단해 두 번 추측 수정했다. 둘 다 효과가 없었다.
같은 빌드를 **지금 이 기계 상태에서** 다시 재보니 10.78%였다. 회귀는 없었다.

바로 위 "같은 설정을 두 번 재라"를 적어두고도 이 함정에 빠진 이유는, 그 규칙을
*새 측정*에만 적용하고 **기준선은 파일이니까 믿을 수 있다**고 취급했기 때문이다.
기준선도 측정이고, 다른 날 다른 열 상태에서 나온 측정이다.
비교하려면 기준선 쪽도 같은 세션에서 다시 재야 한다 — `git stash` 후
`git checkout <ref> -- src/`로 이전 빌드를 돌려 재측정하는 데 2분이면 된다.

이 규칙은 spark·MAD 같은 **꼬리 통계**에서 특히 강하다. 평균은 열 드리프트에
둔감하지만 꼬리는 그렇지 않다.

### 유니폼 분기는 공짜, 픽셀 분기는 아니다

바닥 없는 프리셋에서도 해석적 해저가 픽셀당 14 옥타브를 돌고 있었다. `seabedMix`로 감싸자
사라졌다 — 유니폼이라 드로우 전체에서 분기가 일관되기 때문이다. 같은 방식을 픽셀 데이터에
적용하면 워프 발산으로 오히려 느려진다. Phase 14의 `DETAIL_GAIN` 0.34가 정확히 그 실패였다:
분기 조건이 fBm 표준편차의 2배 밖이라 거의 모든 샘플이 비싼 쪽을 탔고, 최적화가 잡음으로 측정됐다.
