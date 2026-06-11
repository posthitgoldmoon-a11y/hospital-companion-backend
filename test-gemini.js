require('dotenv').config();
const { chat } = require('./src/services/gemini');

async function test() {
  const history = [];
  const response = await chat(history, "어머니 이름은 김순자고 75세이신데 2026-06-15 오전 10시에 강남세브란스병원 가셔야 해요. 서울이고요, 차량도 필요하고 3시간이요");
  console.log("=== Gemini 원본 응답 ===");
  console.log(response);
  console.log("=== booking_complete 포함 여부 ===");
  console.log(response.includes('booking_complete'));
}

test().catch(console.error);
