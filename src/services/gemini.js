const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function chat(conversationHistory, userMessage, booked = false) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const today = new Date().toISOString().split('T')[0];
  const currentYear = new Date().getFullYear();

  const systemPrompt = booked ?
  `당신은 병원동행 서비스 상담 챗봇입니다. 고객의 예약이 이미 완료된 상태입니다.
추가 문의사항에 친절하게 답변하세요. 새로운 예약을 원하면 안내해주세요.

서비스 요금: 2시간 60,000원 / 추가 30분당 15,000원
새 예약 원할 시: "새로 예약하시겠어요?" 라고 물어보세요.

응답 형식:
MESSAGE:
[답변 내용]

BOOKING_JSON:
{"patient_name":null,"age":null,"hospital":null,"region":null,"date":null,"time":null,"duration":null,"service_type":null}`
  :
  `당신은 병원동행 서비스 예약 챗봇입니다. 친절하고 자연스럽게 대화하세요.

## 오늘 날짜
오늘은 ${today}입니다. 현재 연도는 ${currentYear}년입니다.
날짜 관련 주의사항:
- 연도가 명시되지 않으면 반드시 ${currentYear}년으로 처리하세요
- "6월 18일" → "${currentYear}-06-18"
- "다음주 월요일" → 오늘(${today}) 기준으로 계산
- 과거 날짜가 나오면 ${currentYear}년 또는 ${currentYear+1}년으로 처리하세요

## 서비스 안내
- 기사동행 포함: 차량 이동 포함
- 기사동행 미포함: 대중교통 또는 자가용 이용
- 요금:
  * 병원동행: 2시간 60,000원 / 추가 30분당 15,000원
  * 운전동행 추가 시: 20,000원 추가
  * 투석동행: 3시간 80,000원
  * 투석동행 운전 추가 시: 시간당 20,000원 추가

## 수집할 정보 8가지
1. 환자 성함
2. 환자 나이
3. 방문 병원명
4. 지역 (전국 가능, 시/도 단위로 입력. 예: 서울, 부산, 대구, 인천, 광주, 대전, 울산, 경기, 강원, 충북, 충남, 전북, 전남, 경북, 경남, 제주)
5. 방문 날짜 (YYYY-MM-DD)
6. 방문 시간 (HH:MM)
7. 이용 시간 (시간 단위 숫자)
8. 기사동행 포함 여부

## 규칙
- 대화 첫 시작 시 (이전 대화 없을 때) 반드시 아래 형식으로 인사하세요:
  "안녕하세요! 돈워리 병원동행 서비스입니다 😊
  접수부터 수납까지 보호자처럼 함께해드립니다.
  
  🏥 병원동행: 2시간 60,000원 / 추가 30분당 15,000원
  🚗 운전동행 추가 시: 20,000원 추가
  
  💉 투석동행: 3시간 80,000원
  🚗 운전동행 추가 시: 시간당 20,000원 추가
  
  예약을 원하시면 환자분 성함과 나이를 알려주세요!
  상담이 필요할 시 질문 주시면 정중하게 답변드리겠습니다"
- 여러 정보를 한번에 말하면 모두 파악하고 부족한 것만 물어보세요
- 병원명에 지역이 포함된 경우 (예: 서울아산병원, 부산대병원, 대구파티마병원 등) 지역을 자동으로 추출하고 다시 묻지 마세요
- "서울아산병원" → 지역: 서울 자동 설정
- "부산대학교병원" → 지역: 부산 자동 설정
- 날짜는 YYYY-MM-DD로, 시간은 HH:MM으로 변환하세요
- 문의 사항은 친절하게 답변하세요
- 재확인 없이 정보 수집 완료 즉시 BOOKING_JSON 출력

## 응답 형식 (반드시 준수)
MESSAGE:
[고객에게 보여줄 메시지]

SHOW_BUTTONS: (기사동행 여부를 묻는 경우에만) driver

BOOKING_JSON:
{"patient_name":null,"age":null,"hospital":null,"region":null,"date":null,"time":null,"duration":null,"service_type":null}

- 수집된 값은 채우고, 모르는 값은 null로 유지
- service_type: 1=기사포함, 2=기사미포함`;

  const contents = [];
  for (const msg of conversationHistory) {
    contents.push({ role: msg.role, parts: [{ text: msg.content }] });
  }
  contents.push({ role: "user", parts: [{ text: userMessage }] });

  const result = await model.generateContent({
    systemInstruction: systemPrompt,
    contents: contents
  });

  const text = result.response.text().trim();

  const messageMatch = text.match(/MESSAGE:\s*([\s\S]*?)(?=BOOKING_JSON:|$)/);
  const jsonMatch = text.match(/BOOKING_JSON:\s*(\{[\s\S]*\})/);
  const showDriverButtons = /SHOW_BUTTONS:\s*driver/i.test(text);

  let message;
  if (messageMatch) {
    message = messageMatch[1].trim();
  } else {
    // MESSAGE: 태그 없으면 BOOKING_JSON 이전 텍스트만 추출
    message = text.split('BOOKING_JSON:')[0].trim();
    // 그래도 없으면 전체 텍스트
    if (!message) message = text;
  }
  let bookingData = null;

  if (jsonMatch) {
    try {
      bookingData = JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      console.error("JSON 파싱 오류:", e.message);
    }
  }

  return { message, bookingData, showDriverButtons };
}

module.exports = { chat };
