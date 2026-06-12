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

서비스 요금: 2시간 40,000원 / 추가 30분당 10,000원
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
- 요금: 2시간 40,000원 / 추가 30분당 10,000원

## 수집할 정보 8가지
1. 환자 성함
2. 환자 나이
3. 방문 병원명
4. 지역 (서울/경기/인천)
5. 방문 날짜 (YYYY-MM-DD)
6. 방문 시간 (HH:MM)
7. 이용 시간 (시간 단위 숫자)
8. 기사동행 포함 여부

## 규칙
- 여러 정보를 한번에 말하면 모두 파악하고 부족한 것만 물어보세요
- 날짜는 YYYY-MM-DD로, 시간은 HH:MM으로 변환하세요
- 문의 사항은 친절하게 답변하세요
- 재확인 없이 정보 수집 완료 즉시 BOOKING_JSON 출력

## 응답 형식 (반드시 준수)
MESSAGE:
[고객에게 보여줄 메시지]

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

  return { message, bookingData };
}

module.exports = { chat };
