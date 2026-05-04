# Eg-walker 기반 브라우저 협업 코드 편집기

## 1. 프로젝트 개요

본 프로젝트는 Eg-walker 알고리즘을 브라우저 기반 코드 편집 환경에 적용하기 위한 캡스톤 프로토타입이다.

CodeMirror 6을 편집기 UI로 사용하고, WebSocket 중계 서버를 통해 여러 브라우저 클라이언트 간 편집 연산을 동기화한다. 본 구현은 Eg-walker 알고리즘 자체를 새로 제안하는 것이 아니라, 기존 Eg-walker 구조를 실제 브라우저 편집기와 연결하기 위한 문서 엔진, 에디터 바인딩, 전체/증분 동기화 구조를 구현하는 데 목적이 있다.

## 2. 실행 환경

* Bun
* TypeScript
* Vite
* CodeMirror 6
* WebSocket

## 3. 설치 방법

프로젝트 루트에서 다음 명령어를 실행한다.

```bash
bun install
```

## 4. 실행 방법

서버와 클라이언트는 각각 다른 터미널에서 실행한다.

### 4.1 WebSocket 중계 서버 실행

첫 번째 터미널에서 다음 명령어를 실행한다.

```bash
bun ./src/wsRelayServer.ts
```

서버가 정상적으로 실행되면 다음 주소에서 WebSocket 연결을 받는다.

```text
ws://127.0.0.1:8787
```

또는 클라이언트 코드 기준으로는 다음 주소를 사용한다.

```text
ws://localhost:8787
```

### 4.2 클라이언트 개발 서버 실행

두 번째 터미널에서 다음 명령어를 실행한다.

```bash
bun run dev
```

브라우저에서 Vite가 출력한 주소로 접속한다. 일반적으로 다음 주소를 사용한다.

```text
http://localhost:5173
```

여러 클라이언트를 테스트하려면 브라우저 탭을 2개 이상 열고 같은 `room`으로 접속한다.

예시:

```text
http://localhost:5173/?room=test&id=A
http://localhost:5173/?room=test&id=B
http://localhost:5173/?room=test&id=C
```

`room` 값이 같은 클라이언트끼리 같은 문서를 편집하는 참여자로 동작한다. `id` 값은 각 클라이언트의 agent 식별자로 사용된다. `id`를 지정하지 않으면 클라이언트에서 임의의 식별자가 생성된다.

## 5. 기본 사용 방법

1. WebSocket 중계 서버를 실행한다.
2. 클라이언트 개발 서버를 실행한다.
3. 같은 `room`을 사용하는 브라우저 탭을 2개 이상 연다.
4. 각 클라이언트에서 `sync: OFF` 버튼을 눌러 자동 동기화를 켠다.
5. 한 클라이언트에서 텍스트를 입력한다.
6. 다른 클라이언트에 변경 사항이 반영되는지 확인한다.
7. `request full sync` 버튼을 누르면 전체 OpLog 기반 동기화를 요청한다.
8. `reset` 버튼을 누르면 해당 클라이언트의 문서 상태와 OpLog를 초기화한다.

## 6. 주요 파일 구조

```text
project-root/
├─ README.md
├─ package.json
├─ bun.lock
├─ tsconfig.json
├─ index.html
└─ src/
   ├─ egwalker.ts
   ├─ collabCore.ts
   ├─ editorBinding.ts
   ├─ main.ts
   ├─ style.css
   └─ wsRelayServer.ts
```

## 7. 주요 파일 설명

| 파일                     | 역할                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/egwalker.ts`      | Eg-walker 기반 문서 엔진이다. OpLog, 이벤트 그래프, 부분 재생, 병합, TextPatch 생성, full/delta sync에 필요한 연산 변환을 담당한다.     |
| `src/collabCore.ts`    | 문서 엔진을 외부에서 사용하기 위한 중간 계층이다. 로컬 입력 처리, 원격 delta 병합, 전체 동기화, 패치 이벤트 전달, 디버그 텍스트 생성을 담당한다.             |
| `src/editorBinding.ts` | CodeMirror 6와 CollabCore를 연결한다. CodeMirror의 로컬 변경을 Eg-walker 연산으로 변환하고, 원격 패치를 CodeMirror 변경으로 반영한다. |
| `src/main.ts`          | 브라우저 클라이언트 실행 진입점이다. UI 생성, WebSocket 연결, full sync, delta sync, 버튼 이벤트 처리를 담당한다.                    |
| `src/wsRelayServer.ts` | room 기반 WebSocket 중계 서버이다. 문서 병합은 하지 않고 같은 room에 있는 클라이언트에게 메시지만 전달한다.                               |
| `src/style.css`        | 편집기 화면, 디버그 패널, 버튼 영역의 스타일을 정의한다.                                                                    |
| `index.html`           | 브라우저 앱의 HTML 진입점이다. `src/main.ts`를 모듈로 로드한다.                                                         |
| `package.json`         | 실행 스크립트와 의존성 정보를 포함한다.                                                                               |
| `tsconfig.json`        | TypeScript 컴파일 설정을 포함한다.                                                                             |

## 8. 구현 기능

* CodeMirror 6 기반 브라우저 코드 편집기
* 로컬 입력을 Eg-walker 삽입/삭제 연산으로 변환
* 선택 범위 교체 입력을 삭제 연산과 삽입 연산으로 분리
* 한글 IME 조합 등 replace 형태 입력 처리
* OpLog 기반 이벤트 그래프 표현
* branch snapshot 기반 부분 재생
* 원격 연산 병합
* 병합 결과를 TextPatch 형태로 반환
* TextPatch를 CodeMirror changes로 변환하여 부분 반영
* remote annotation을 이용한 원격 반영 재전송 방지
* WebSocket room 기반 메시지 중계
* 초기 전체 동기화
* version 기반 증분 동기화
* 연속 삽입/삭제 연산 묶음 압축
* delta 적용 실패 시 full sync 요청을 통한 복구

## 9. 동작 확인 시나리오

### 9.1 양방향 원격 반영 확인

1. 클라이언트 A와 B를 같은 `room`으로 접속한다.
2. 두 클라이언트 모두 `sync`를 켠다.
3. A에서 텍스트를 입력한다.
4. B에 같은 내용이 반영되는지 확인한다.
5. B에서 텍스트를 입력한다.
6. A에 같은 내용이 반영되는지 확인한다.

### 9.2 초기 전체 동기화 확인

1. A와 B가 같은 `room`에서 문서를 편집한다.
2. 새 클라이언트 C를 같은 `room`으로 접속한다.
3. C가 `full sync`를 통해 기존 문서 상태를 수신하는지 확인한다.

### 9.3 증분 동기화 확인

1. `full sync` 이후 A에서 새 텍스트를 입력한다.
2. 전체 OpLog가 아니라 version 비교를 통해 누락된 연산만 전송되는지 확인한다.
3. 수신 측에서 delta를 병합하고 TextPatch가 CodeMirror에 반영되는지 확인한다.

### 9.4 원격 반영 재전송 방지 확인

1. A에서 입력한 변경이 B에 반영된다.
2. B에서 반영된 원격 변경이 다시 B의 로컬 입력으로 기록되지 않는지 확인한다.
3. 동일한 변경이 네트워크로 반복 전송되지 않는지 확인한다.

### 9.5 reset 및 full sync 복구 확인

1. 한 클라이언트에서 `reset`을 누른다.
2. 해당 클라이언트의 문서와 OpLog가 초기화되는지 확인한다.
3. `request full sync`를 눌러 다른 클라이언트의 전체 OpLog를 다시 받아오는지 확인한다.
4. 수신한 전체 OpLog를 기준으로 문서 상태가 복구되는지 확인한다.

## 10. 메시지 흐름 요약

본 구현의 네트워크 메시지는 JSON 형식으로 교환된다. 주요 메시지 흐름은 다음과 같다.

| 메시지                 | 역할                                     |
| ------------------- | -------------------------------------- |
| `hello`             | 클라이언트가 특정 room에 접속했음을 중계 서버에 알린다.      |
| `request-full-sync` | 전체 OpLog 동기화를 요청한다.                    |
| `full-sync`         | 전체 OpLog를 전송한다. 초기 접속 또는 복구 상황에서 사용한다. |
| `announce-version`  | 자신의 현재 version 정보를 다른 클라이언트에게 알린다.     |
| `request-delta`     | 상대방 version을 기준으로 자신에게 없는 연산을 요청한다.    |
| `delta`             | 누락된 연산만 압축된 묶음 형태로 전송한다.               |
| `reset`             | 문서 상태 초기화에 사용하기 위해 정의한 메시지 타입이다.       |

## 11. 현재 한계

* 내부 자료구조는 B-tree 또는 order statistic tree가 아니라 배열 기반이다.
* agent별 sequence가 연속적으로 도착한다는 가정이 남아 있다.
* 중간 sequence가 누락된 상태에서 뒤의 연산이 먼저 도착하는 일반적인 비순차 수신 상황은 제한적으로만 처리한다.
* 현재 실행 구조는 완전한 P2P가 아니라 WebSocket 중계 서버 기반이다.
* WebRTC 기반 전송 계층은 구현하지 않았다.
* 대규모 문서와 다중 사용자 환경에 대한 정량적 성능 평가는 충분히 수행하지 못했다.
* CodeMirror 6 이외의 편집기 바인딩은 구현하지 않았다.

## 12. 제출 파일에서 제외한 항목

제출용 압축 파일에는 실행과 검토에 필요한 소스 코드만 포함한다.

제외 항목:

```text
node_modules/
src/backup/
사용하지 않는 public 리소스
임시 로그 파일
```

`node_modules`는 용량이 크기 때문에 포함하지 않는다. 의존성은 `package.json`과 `bun.lock`을 기반으로 `bun install`을 실행하여 복원한다.

## 13. 빌드 확인

필요하면 다음 명령어로 TypeScript 컴파일과 Vite 빌드를 확인할 수 있다.

```bash
bun run build
```

빌드 결과를 미리 확인하려면 다음 명령어를 사용할 수 있다.

```bash
bun run preview
```

## 14. 참고

본 구현은 캡스톤 연구를 위한 프로토타입이며, 상용 수준의 협업 편집기 완성을 목표로 하지 않는다. 핵심 목적은 Eg-walker의 이벤트 그래프 기반 병합 구조를 브라우저 편집기, 패치 기반 UI 반영, WebSocket 기반 동기화 흐름과 연결하는 것이다.
