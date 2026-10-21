# TopMediAi-MCP

[English](../../README.md) · [日本語](README.ja.md) · **한국어** · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Italiano](README.it.md) · [繁體中文](README.zh-TW.md)

TopMediai용 로컬 TypeScript stdio MCP 서버 및 Codex 플러그인입니다. **1.0.0**은 이미지 생성, 이미지 변환, 음악, 동영상, 여러 미디어를 참조하는 동영상, 텍스트 음성 변환(TTS), 음성 변환(STS)을 지원합니다. 모델 목록, 비용 견적, 예산 검증, 작업 복구, 이미지·오디오·동영상 미리보기를 제공합니다. 노이즈 제거, 음성 복제, 뮤직비디오는 지원하지 않습니다.

생성에는 로그인한 계정의 이용 권한이 사용됩니다. 모델 목록과 정확한 견적을 확인한 뒤 사용자의 예산 및 현재 대화의 확인 설정에 따라 제출하세요. 참조 파일 업로드에는 외부 저장 동의가 필요하며, 업로드 URL은 공개적으로 접근할 수 있습니다. [데이터 및 개인정보 보호(영어)](../privacy.md)를 참조하세요.

## 설치 및 로그인

Node.js 22.18 이상과 공식 연결 페이지 접근이 필요합니다. Codex 설치에는 Codex CLI가 필요하지만 Cursor 설치에는 필요하지 않습니다. 브라우저와 MCP는 같은 컴퓨터에서 실행하세요. PowerShell에서는 `npm.cmd`, 다른 지원 셸에서는 `npm`을 사용할 수 있습니다.

프로젝트 디렉터리에서 실행하세요.

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run install:codex
```

Cursor는 의존성을 설치한 뒤 `npm.cmd run install:cursor`로 설치합니다. 프로젝트 한정 설치에는 `-- --project ./my-project`를 추가하세요. [Cursor 가이드(영어)](../cursor.md)를 참조하세요.

Codex 표시 이름은 `TopMediAi-MCP`, 설치 식별자는 `topmediai-mcp@topmediai-local`입니다. 설치 시 로컬 `plugin/.mcp.json`이 생성됩니다. 토큰이나 쿠키는 플러그인에 저장되지 않지만 로컬 실행 파일 경로가 포함되므로 커밋하거나 배포하지 마세요. 프로젝트를 이동하거나 컴퓨터를 바꾸면 다시 설치하세요.

현재 채팅에서 `get_service_status`를 호출합니다. 로그인이 필요하면 `start_login`으로 공식 페이지를 열고 계정을 확인한 후 연결을 승인하세요. 저장되거나 세션이 종료될 때까지 같은 `login_id`로 `wait_for_login`을 반복합니다. 저장 후 같은 채팅에서 `get_service_status`, `get_balance`를 호출하고 원래 요청을 이어갑니다. Codex나 MCP 재시작은 필요하지 않습니다.

대체 CLI 명령:

```powershell
npm.cmd run login
npm.cmd run login:status
npm.cmd run logout
```

로그인은 최대 10분간 기다립니다. 비공개 연결 링크는 기본적으로 숨겨집니다. 브라우저가 자동으로 열리지 않을 때만 로컬에서 `--show-private-link`를 사용하세요. 이 링크는 공유, 스크린샷 촬영, 채팅 붙여넣기를 하면 안 됩니다.

설치 자체 검사는 별도 MCP 프로세스가 시작되는지만 확인하며 현재 채팅의 도구 로드나 인증 유효성을 보장하지 않습니다. 도구가 없으면 플러그인 활성화 상태를 확인하고 패키지를 갱신해 MCP를 다시 연결하세요. 필요하면 새 채팅을 시작합니다. 다른 생성기의 결과를 TopMediai 결과로 표시하지 마세요.

## 환경 및 설정

공개 설치 프로그램, 서버, CLI는 **프로덕션만** 지원하며 공식 웹사이트와 API 주소가 내장되어 있습니다. 일반 사용자는 `.env` 생성, 환경 선택, 호스트명 입력, 토큰 복사가 필요 없습니다. 선택 설정은 [.env.example](../../.env.example), 자세한 내용은 [프로덕션 설정(영어)](../production-switch.md)을 참조하세요.

- 기본 연결은 직접 API 방식입니다. 서비스 주소는 유효한 HTTPS 오리진이어야 하며 필수 값이 명시적으로 비어 있으면 거부됩니다. 기능이 제한된 레거시 게이트웨이는 `TOPMEDIAI_PRODUCTION_GATEWAY_HOST`를 명시한 경우에만 활성화됩니다.
- 설치는 셸 설정을 읽고 서비스 주소, 환경, 업로드 설정을 고정합니다. 재정의 값은 설치 전에 지정하세요. 직접 시작 및 로그인 CLI의 차이는 설정 예제 주석을 참조하세요.
- 기본적으로 비공개 로컬 인증 정보를 사용합니다. 명시적 `TOPMEDIAI_TOKEN` 재정의 값은 공개 파일, 스크린샷, 이슈에 포함하지 마세요. 표준 설치는 기존 재정의 값을 비웁니다.
- 인증 정보는 Windows Credential Manager, macOS Keychain 또는 Linux Secret Service에 저장되며 호출마다 다시 읽습니다. 저장된 인증 정보를 읽으면 `credential_source=system-store`가 표시되고 저장소는 `credential_storage`로 확인합니다. 계정 변경 시 작업 디렉터리가 전환되며 진행 중인 요청은 원래 인증 정보를 유지합니다.
- **JSON 저장 방식에서 업그레이드한 뒤에는 다시 로그인해야 합니다.** 기존 JSON은 읽거나 이전하거나 자동 삭제하지 않습니다. 이전 디렉터리는 비밀 정보가 없는 로그인 잠금 메타데이터용이며, 남은 비밀 파일은 별도로 관리하고 공개하지 마세요. Linux에는 데스크톱 D-Bus와 Secret Service가 필요합니다. 저장소가 잠기거나 접근이 거부되거나 사용할 수 없어도 일반 텍스트 파일로 대체하지 않습니다. 시스템 암호는 OS 대화 상자에만 입력하세요.
- Windows 저장·읽기·삭제는 격리된 테스트로 확인했으나 macOS/Linux의 전체 클라이언트 흐름은 실기 검증이 필요합니다. 같은 OS 사용자의 Codex/Cursor는 프로덕션 인증 정보를 공유하므로 로그아웃이나 계정 변경이 양쪽의 다음 호출에 영향을 줍니다. 동일 사용자로 실행되는 모든 프로세스로부터 격리되는 것은 아닙니다.
- 생성 및 업로드용 추가 기능 스위치는 없습니다. 업로드에는 파일별 동의와 전용 디렉터리가 필요합니다. 주소, 업로드 설정, 코드 변경 후 설치 설정과 패키지를 갱신하고 MCP를 다시 연결하세요.
- 로컬 로그아웃은 저장된 인증 정보만 삭제합니다. 웹사이트 로그아웃, 서버 토큰 취소, 제출한 작업 취소는 하지 않습니다.

```powershell
npm.cmd run setup:plugin
```

갱신 후 `get_service_status.server_version`을 확인하세요. 전체 앱 재시작을 기본 절차로 요구하지 않습니다.

클라이언트별 실행 설정에서 `MCP_CLIENT_SOURCE`를 지정합니다. Codex는 `5`, Claude Code는 `6`, Cursor는 `7`이며 알 수 없으면 헤더를 보내지 않습니다. 설치 프로그램은 해당 값을 지정하고 기존 `TOPMEDIAI_SOURCE` 본문 채널은 유지합니다. 업데이트 후 실행 설정을 갱신하고 다시 연결하세요. [클라이언트 식별(영어)](../client-source.md).

오디오 스위치를 제공하는 동영상 작업은 `generate_audio`를 생략하면 기본적으로 소리를 생성합니다. 명시적 무음 요청에는 `false`를 지정하세요. 스위치 없는 모델은 공급자 동작을 따르며 강제 오디오 모델은 음소거할 수 없습니다. 목록·견적·제출 설정을 일치시키고 변경 후 다시 견적을 받으세요.

## 도구 및 제작 흐름

| 목적 | 주요 도구 |
| --- | --- |
| 상태 및 로그인 | `get_service_status`, `start_login`, `wait_for_login`, `cancel_login` |
| 계정 및 계획 | `get_balance`, `review_generation_plan` |
| 이미지 | `list_image_models`, `estimate_image_cost`, `generate_image`, `get_image_task` |
| 참조 이미지 및 미리보기 | `upload_reference_image`, `preview_image_task` |
| 음악 | `list_music_models`, `estimate_music_cost`, `generate_music` |
| 동영상 | `list_video_models`, `estimate_video_cost`, `generate_video`, `upload_reference_media`, `preview_video_task` |
| 음성 | `list_voices`, `get_voice_detail`, `list_tts_models`, `list_sts_models`, `get_speech_entitlements`, `upload_speech_audio`, `estimate_tts_cost`, `generate_tts`, `estimate_sts_cost`, `generate_sts` |
| 멀티미디어 조회 및 재생 | `get_generation_capabilities`, `get_generation_task`, `preview_audio_task` |

실제로 로드된 도구 목록을 기준으로 합니다. 모델을 지정하지 않았다면 현재 목록의 기본 모델을 사용하며 가격이나 스타일에 따라 임의 변경하지 않습니다. 매개변수, 참조 한도, 음성 언어, 기능은 현재 목록에서 확인하세요. 목록에 있다고 견적이나 생성이 가능하다는 뜻은 아닙니다.

유효한 견적, 안정적인 `request_id`, 명시적인 예산으로 제출합니다. `review_generation_plan`은 현재 흐름의 견적을 합산합니다. 기본적으로 지정된 고비용 모델 또는 예상 합계가 **1000 크레딧을 초과**하면 확인이 필요합니다. 사용자의 명시적 설정이 우선합니다. 견적 만료, 입력 변경, 가격 상승 시 다시 검토하세요. 도구는 사용자 동의를 대체하지 않으며 로컬 예산은 서버의 강제 지출 한도가 아닙니다.

시간 초과, 취소, 연결 끊김, 제출 결과 불명은 생성이나 과금이 없었다는 증거가 아닙니다. 원래 작업 식별자를 유지하고 계정 기록을 확인하며 자동 재생성하지 마세요. 계정이나 설정 변경으로 작업이 안 보이는 경우에도 먼저 기록을 확인합니다.

완료된 이미지는 미리보기를 우선합니다. 만료된 링크는 원래 작업에 `get_image_task({request_id, refresh_result:true})`를 호출하지만 갱신은 보장되지 않습니다. 오디오는 플레이어나 이름 있는 링크로, 동영상은 인라인 플레이어와 원본 결과 링크로 전달합니다. 미리보기 실패와 생성 실패를 구분하고 일부 단계가 실패해도 성공한 결과는 전달하세요.

## 동영상 미리보기

동영상 완료 후 원래 `task_handle`로 `preview_video_task`를 호출하여 읽기 전용 플레이어와 이름 있는 원본 링크를 표시합니다. 클릭 재생, 일시 정지, 탐색, 음량, 전체 화면, 재시도를 지원합니다. 부분 완료 시 성공한 버전을 보여 주고 변경 없는 카드를 반복해서 열지 않습니다.

미리보기는 계정의 저장된 작업만 읽으며 백엔드 조회, 로컬 다운로드, 생성, 과금, 작업 변경을 하지 않습니다. 허용된 동영상 CDN에서만 계정 인증 정보 없이 미디어를 로드합니다. UI·형식·재생 오류가 있어도 원본 링크를 유지하며 다시 생성하지 않습니다. 브라우저 이동, 스크린샷, 다운로드에는 명시적 요청이 필요합니다.

업데이트 후 패키지를 갱신하고 MCP를 다시 연결하여 `server_version=1.0.0`, 도구 35개, `preview_video_task`를 확인하세요. 카드 표시와 전체 화면은 호스트 지원에 따라 달라집니다.

## 참조 미디어 업로드

전용 디렉터리에서 사용자가 허용한 파일만 선택하세요. 개인 파일이나 인증 정보 디렉터리로 접근 범위를 넓히지 마세요.

```powershell
$env:TOPMEDIAI_UPLOAD_ROOT = 'C:\path\to\upload-inputs'
npm.cmd run setup:plugin
```

먼저 디렉터리를 만들고 허용된 파일을 넣은 다음 설정 갱신 후 MCP를 다시 연결합니다.

- **이미지:** PNG/JPEG, 최대 5 MiB. 반환된 `reference_image_id`를 사용하고 ID를 추측하거나 다른 계정과 공유하지 마세요. [이미지 업로드(영어)](../image-to-image-security.md).
- **동영상 참조:** MP4/WAV/MP3. 전용 디렉터리와 로컬 FFmpeg/FFprobe가 필요합니다. 개수, 크기, 길이, 조합 제한은 작업별 모델 목록에서 확인합니다. ID와 순서는 견적에 연결됩니다.
- **STS 원본 오디오:** MP3/WAV/AAC/FLAC/AIFF/OGG, 최대 50 MiB 및 300초. 동일한 디렉터리 설정과 FFmpeg/FFprobe가 필요합니다. [음성 가이드(영어)](../speech-integration.md).

로컬 검증과 메타데이터 제거가 클라우드 파일을 비공개로 만들지는 않습니다. 업로드 URL, 결과 링크, 전체 로컬 보고서를 공개 이슈에 그대로 넣지 마세요.

## 진단 및 공유 보고서

```powershell
# 읽기 전용 조회이며 생성을 제출하지 않습니다
npm.cmd run diagnose
# 개인정보를 가린 공유용 사본도 만듭니다
npm.cmd run diagnose -- --share-report
```

콘솔에는 기본적으로 요약만 표시됩니다. 전체 보고서 `.data/diagnostic-runs/latest-production.json`은 비공개입니다. 공유 사본 `.data/diagnostic-runs/shared-production.json`은 계정 식별자, 프롬프트, 비용, 미디어 URL, 비공개 링크, 로컬 경로를 숨깁니다. 공유 전에 내용을 확인하세요. 전체 보고서의 이름만 바꾸면 개인정보가 제거되지 않습니다. 일반 MCP 결과는 실제 잔액과 결과 링크를 계속 제공합니다.

## 개발 및 공개 검사

```powershell
npm.cmd test
npm.cmd run check:public
npm.cmd run check:public -- --build
npm.cmd run prepare:public
```

`prepare:public`은 검토된 파일로 독립 스냅샷을 만들고 기존 이력을 상속하지 않는 로컬 Git 저장소를 초기화합니다. 검사를 통과한 사본만 공개하세요. 현재 파일 편집으로 과거 이력이 삭제되지는 않습니다. [공개 검사(영어)](../releasing.md)를 참조하세요.

## 라이선스

프로젝트의 원본 코드는 [MIT License](../../LICENSE)를 따르며 저작권자는 TopMediai입니다. 타사 코드와 의존성에는 각자의 라이선스와 저작권 고지가 적용됩니다.

소스 라이선스는 TopMediai 클라우드 서비스의 무료 이용을 허용하지 않습니다. 로그인, 생성, 업로드 등은 계정 권한, 요금, 서비스 약관을 따릅니다. 이름, 상표, 브랜드 아이콘은 이 MIT 허용 범위에 포함되지 않으며 적절한 사용 허가가 필요합니다.
