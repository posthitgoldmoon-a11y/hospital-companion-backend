# 카카오 챗봇 셋업 가이드 (시행착오 정리)

## 🚨 가장 중요! 콜백 2단계 응답
잘못하면 400 에러 계속 남. 이게 핵심!

1단계 - 스킬서버 → 카카오 (즉시응답, template 없음!)
res.status(200).json({ version: "2.0", useCallback: true });

2단계 - 스킬서버 → callbackUrl (실제 응답)
await fetch(callbackUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    version: "2.0",
    template: { outputs: [{ simpleText: { text: "메시지" } }] }
  })
});

## 🔧 서버 세팅 순서
1. npm install express cors dotenv node-fetch @google/generative-ai mysql2
2. Oracle Cloud → Networking → VCN → Security Lists → Ingress Rules → TCP 포트 추가
3. 서버 방화벽: sudo iptables -I INPUT -p tcp --dport 포트번호 -j ACCEPT
4. sudo netfilter-persistent save
5. pm2 start src/app.js --name 앱이름
6. pm2 save

## 📱 카카오 챗봇 어드민 설정 순서 (chatbot.kakao.com)
1. 스킬 등록: 스킬 URL = http://서버IP:포트/webhook/skill
2. 시나리오 → 폴백 블록 클릭
3. 봇 응답 → 스킬 데이터 사용 선택
4. 콜백 응답 사용 ON
5. 블록 이름 반드시 입력
6. 저장
7. 배포 버튼 클릭 (이거 빠뜨리면 적용 안됨!)
8. 웰컴 블록 OFF (폴백 블록이랑 충돌함)

## ⚠️ DB 주의사항
- DEFAULT 값은 영어로만! 한글 하면 MySQL 에러남
  - ❌ DEFAULT '대기중'
  - ✅ DEFAULT 'pending'
- 프로젝트마다 테이블 분리

## ❌ 자주 하는 실수
- URL을 터미널에 직접 입력하면 안됨 (브라우저에서 열기)
- pm2 restart 할 때 --update-env 빠뜨리면 env 안 읽힘
- 콜백 설정하고 배포 안 하면 적용 안됨
- 시크릿키 찾을 필요 없음! 카카오 챗봇은 시크릿키 없음
- /tmp 폴더에서 node 실행하면 node_modules 없어서 에러남

## 📁 프로젝트별 정보
### 팬토리 (fantory-backend)
- 서버: 158.180.83.78
- 포트: 3001
- Bot ID: 696b367f07c97c327f55dc33
- 스킬 URL: http://158.180.83.78:3001/webhook/skill
- DB: sql12.freesqldatabase.com / sql12829870

### 병원동행 (hospital-companion-backend)
- 서버: 158.180.83.78
- 포트: 3000

## 🆕 2026-06-14 추가 (오늘 배운 것들)

## 🚨 카카오맵 REST API 사용 시
- 카카오 개발자 콘솔 → 제품 설정 → 카카오맵 → 활성화 ON 필수!
- 안하면 "disabled OPEN_MAP_AND_LOCAL service" 에러 남
- REST API 키로 서버에서 직접 호출 (도메인 등록 불필요)
- 주소검색은 프론트에서 직접 호출 X → 서버 프록시로 호출해야 함
  (프론트에서 직접 호출하면 도메인 등록 필요해서 복잡해짐)

## 🆕 카카오 개발자 콘솔 2026년 변경사항
- 웹 도메인 등록 위치가 바뀜!
- ❌ 예전: 앱 → 플랫폼 → Web 플랫폼 등록
- ✅ 현재: 앱 → 플랫폼 키 → JavaScript 키 → JavaScript SDK 도메인

## 🆕 카카오 지도 검색 연동 방법
- 카카오 REST API 키 발급 후 .env에 KAKAO_REST_API_KEY 추가
- app.js에 /api/search-address 프록시 엔드포인트 추가
- address.html에서 /api/search-address로 fetch 호출
- 선택 결과는 /address-result POST로 서버 저장
- webhook.js에서 /address-result/:userId/:type GET으로 조회

## 🆕 카카오톡 webLink 버튼 주의사항
- quickReplies에서 webLink action 지원 안 됨!
- ❌ quickReplies에 webLink 넣으면 버튼 안 보임
- ✅ basicCard의 buttons에 webLink 넣어야 함
- 구조: outputs에 basicCard → buttons에 webLink
       quickReplies에는 message action만 사용

## 🆕 REST API 키 오타 주의
- 키 복사할 때 마지막 글자 잘릴 수 있음
- 반드시 curl로 테스트 후 진행
- "appKey does not exist" 에러 → 키 오타 확인
- "disabled service" 에러 → 제품 활성화 확인

## 🆕 fantory-backend 구조 확인 (2026-06-14)
- 메인 진입점: src/app.js (server.js 없음)
- 웹훅 로직: src/routes/webhook.js
- src/services/ → 비어있음
- src/prompts/ → 비어있음
- webhook.js 현재 상태: 기사동행 서비스 코드 그대로

## 🗄️ DB 테이블 구조 (sql12829870)
### fantory_customers
- kakao_user_id VARCHAR (PK)
- name VARCHAR
- phone VARCHAR
- created_at TIMESTAMP

### fantory_bookings
- id INT AUTO_INCREMENT (PK)
- kakao_user_id VARCHAR
- datetime VARCHAR
- hours VARCHAR
- fare VARCHAR
- location VARCHAR
- destination VARCHAR
- waypoint VARCHAR
- partner_gender VARCHAR
- partner_age VARCHAR
- partner_hobby VARCHAR
- parking VARCHAR
- extension VARCHAR
- status VARCHAR DEFAULT 'pending'
- created_at TIMESTAMP

## 🔑 환경변수 키 목록 (.env)
- PORT
- GEMINI_API_KEY
- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID
- SERVER_IP
- DB_HOST
- DB_PORT
- DB_USER
- DB_PASSWORD
- DB_NAME
- KAKAO_JS_KEY
- KAKAO_REST_API_KEY

## 📋 hospital-companion-backend 재활용 가능 코드
- src/prompts/hospital.txt → 팬토리 병원 프롬프트 베이스
- src/routes/webhook.js → 콜백구조, 의사캐러셀, 가격표, 캘린더, 예약조회 재활용
- src/services/ → gemini.js, telegram-bot.js, db.js 재활용
- 버릴 것: 20개 업종 캐러셀, 매니저 등록/배정 시스템

## 🤖 Gemini 작동 방식 (gemini.js)
- 프롬프트 파일: src/prompts/{industry}.txt 로드
- {today}, {year} 자동 치환
- 모델: gemini-2.5-flash

### 프롬프트에서 감지하는 키워드 (응답에 포함시 트리거)
- SHOW_BOOKING_TYPE: true → 예약/상담/정보 메인 버튼
- SHOW_DOCTORS: true → 의사 캐러셀
- SHOW_STYLISTS: true → 스타일리스트 캐러셀
- SHOW_PRICE: true → 가격표 이미지
- SHOW_CALENDAR: true → 캘린더 웹링크
- HUMAN_AGENT_REQUEST: true → 텔레그램 알림
- RESET: true → 세션 초기화

### 응답 형식 (프롬프트에 반드시 명시)
MESSAGE:
[메시지 내용]

BOOKING_JSON:
{"name":null,"phone":null,...}

### 새 업종 추가 시
1. src/prompts/{업종}.txt 생성
2. 위 키워드 규칙대로 프롬프트 작성
3. webhook.js에 업종명 INDUSTRY_MAP 추가
4. 필요시 캐러셀 카드 추가
