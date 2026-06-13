const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function getSystemPrompt(industry, booted) {
  const today = new Date().toISOString().split("T")[0];
  const year = new Date().getFullYear();

  if (booted) {
    return `고객의 예약이 완료된 상태입니다. 추가 문의에 친절하게 답변하세요.
새 예약을 원하면 "새로 예약하시겠어요?" 라고 물어보세요.

응답 형식:
MESSAGE:
[답변 내용]

BOOKING_JSON:
{}`;
  }

  const promptFile = path.join(__dirname, "../prompts", `${industry}.txt`);
  if (fs.existsSync(promptFile)) {
    let prompt = fs.readFileSync(promptFile, "utf-8");
    prompt = prompt.replace(/{today}/g, today).replace(/{year}/g, year);
    return prompt;
  }

  // 프롬프트 파일 없으면 기본 프롬프트
  return `당신은 ${industry} 예약 챗봇입니다. 친절하게 예약을 도와주세요.
오늘은 ${today}입니다.

응답 형식:
MESSAGE:
[메시지]

BOOKING_JSON:
{}`;
}

async function chat(conversationHistory, userMessage, booted = false, industry = "hospital_companion") {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const systemPrompt = getSystemPrompt(industry, booted);

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

  const messageMatch = text.match(/MESSAGE:\s*([\s\S]*?)(?=BOOKING_JSON:|SHOW_BUTTONS:|HUMAN_AGENT_REQUEST:|$)/);
  const jsonMatch = text.match(/BOOKING_JSON:\s*(\{[\s\S]*\})/);
  const showDriverButtons = /SHOW_BUTTONS:\s*driver/i.test(text);
  const humanAgentRequest = text.includes("HUMAN_AGENT_REQUEST: true");
  const reset = text.includes("RESET: true");
  const showStylists = text.includes("SHOW_STYLISTS: true");
  const showPrice = text.includes("SHOW_PRICE: true");
  const showDoctors = text.includes("SHOW_DOCTORS: true");
  const showBookingType = text.includes("SHOW_BOOKING_TYPE: true");

  let message;
  if (messageMatch) {
    message = messageMatch[1].trim();
  } else {
    message = text.split("BOOKING_JSON:")[0].trim();
    if (!message) message = text;
  }
  message = message.replace(/SHOW_BUTTONS:.*$/gm, "").replace(/HUMAN_AGENT_REQUEST:.*$/gm, "").replace(/SHOW_STYLISTS:.*$/gm, "").replace(/SHOW_PRICE:.*$/gm, "").replace(/SHOW_DOCTORS:.*$/gm, "").replace(/SHOW_CALENDAR:.*$/gm, "").replace(/SHOW_CALENDAR_RETRY:.*$/gm, "").replace(/SHOW_BOOKING_TYPE:.*$/gm, "").replace(/SHOW_PRICE:.*$/gm, "").replace(/RESET:.*$/gm, "").replace(/SHOW_BOOKING_TYPE:.*$/gm, "").replace(/RESET:.*$/gm, "").trim();

  let bookingData = null;
  if (jsonMatch) {
    try {
      bookingData = JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      console.error("JSON 파싱 오류:", e.message);
    }
  }

  return { message, bookingData, showDriverButtons, humanAgentRequest, reset, showStylists,
    showPrice,
    showDoctors, showBookingType };
}

module.exports = { chat };
