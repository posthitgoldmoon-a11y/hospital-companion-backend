const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function processCustomerInput(userMessage) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const prompt = `당신은 병원동행 서비스 챗봇입니다.
고객 메시지를 분석해서 아래 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만 출력하세요.

분류 기준:
1 = 병원동행 예약 (기사동행 포함)
2 = 병원동행 예약 (기사동행 미포함)
3 = 서비스 문의
4 = 예약 취소/변경
5 = 기타

고객 메시지: "${userMessage}"

응답 형식:
{
  "category": "1~5 중 하나",
  "understood": "이해한 내용 한 줄 요약",
  "extracted_info": {
    "patient_name": "추출된 환자 이름 또는 null",
    "age": "추출된 나이 또는 null",
    "hospital": "추출된 병원명 또는 null",
    "date": "추출된 날짜 (YYYY-MM-DD) 또는 null",
    "time": "추출된 시간 (HH:MM) 또는 null",
    "region": "추출된 지역 또는 null"
  }
}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Gemini 응답 파싱 실패: " + text);
  return JSON.parse(jsonMatch[0]);
}

async function extractSingleInfo(userMessage, fieldType) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const fieldDescriptions = {
    patient_name: "환자 이름",
    age: "환자 나이 (숫자만)",
    hospital: "병원 이름",
    date: "날짜 (YYYY-MM-DD 형식으로)",
    time: "시간 (HH:MM 24시간 형식으로)",
    region: "지역 (서울/경기/인천 중 하나)",
    duration: "이용 시간 (숫자만, 단위: 시간)",
  };

  const prompt = `고객 메시지에서 "${fieldDescriptions[fieldType]}"을(를) 추출하세요.
추출된 값만 텍스트로 출력하세요. 없으면 "null"을 출력하세요.

고객 메시지: "${userMessage}"`;

  const result = await model.generateContent(prompt);
  const value = result.response.text().trim();
  return value === "null" ? null : value;
}

module.exports = { processCustomerInput, extractSingleInfo };
