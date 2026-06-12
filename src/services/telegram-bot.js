const TelegramBot = require("node-telegram-bot-api");
const pool = require("./db");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const managerSessions = {};

const USAGE_GUIDE = 
  `📌 이용 안내\n\n` +
  `🟢 대기중 - 콜 받기 시작\n` +
  `🔴 휴식 - 콜 받기 중지\n` +
  `📋 내 예약 - 배정된 예약 확인\n` +
  `📊 내 실적 - 이번달 수행 건수\n` +
  `✏️ 수정 - 정보 수정\n\n` +
  `💡 콜이 오면 수락/거절 버튼이 함께 옵니다.\n` +
  `💡 수락한 콜 취소는 "예약취소 [예약번호]" 로 입력해주세요.\n` +
  `💡 "도움말" 입력 시 이 안내를 다시 볼 수 있습니다.`;

async function getManagerByChatId(chatId) {
  const [rows] = await pool.query(
    "SELECT * FROM managers WHERE telegram_id = ?",
    [String(chatId)]
  );
  return rows.length > 0 ? rows[0] : null;
}

async function extractRegions(text) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(
    `다음 텍스트에서 지역을 추출해서 JSON 배열로만 응답하세요. 서울/경기/인천 중에서만 선택하세요.
"수도권 전체" 또는 "어디든" 또는 "다" 이면 ["서울","경기","인천"] 반환.
텍스트: "${text}"
응답 예시: ["서울","경기"]`
  );
  const response = result.response.text().trim();
  const match = response.match(/\[[\s\S]*\]/);
  if (!match) return ["서울"];
  try { return JSON.parse(match[0]); } catch { return ["서울"]; }
}

async function analyzeManagerIntent(text, currentStep, managerData) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(
    `매니저 등록/수정 챗봇입니다. 사용자 입력을 분석해서 JSON으로만 응답하세요.

현재 단계: ${currentStep}
사용자 입력: "${text}"

분석 결과 형식:
{
  "intent": "continue(계속진행) / restart(처음부터) / restart_step(현재단계재시작) / cancel(취소) / modify(수정요청)",
  "modify_field": "regions/days/times/service_type/phone 중 하나 또는 null",
  "modify_value": "수정할 값 또는 null"
}

예시:
- "다시 할게요" → {"intent": "restart_step", "modify_field": null, "modify_value": null}
- "처음부터요" → {"intent": "restart", "modify_field": null, "modify_value": null}
- "취소할게요" → {"intent": "cancel", "modify_field": null, "modify_value": null}
- "수요일만 가능해" → {"intent": "modify", "modify_field": "days", "modify_value": "수요일"}
- "서울 추가해줘" → {"intent": "modify", "modify_field": "regions", "modify_value": "서울 추가"}
- "오전만 가능해" → {"intent": "modify", "modify_field": "times", "modify_value": "오전"}
`
  );
  const response = result.response.text().trim();
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) return { intent: "continue" };
  try { return JSON.parse(match[0]); } catch { return { intent: "continue" }; }
}

function makeSelectionKeyboard(options, selected, doneLabel = "✅ 선택 완료") {
  const buttons = options.map(opt => [{
    text: selected.includes(opt) ? `✅ ${opt}` : opt,
    callback_data: `select_${opt}`
  }]);
  buttons.push([{ text: doneLabel, callback_data: "select_done" }]);
  return { reply_markup: { inline_keyboard: buttons } };
}

async function sendWelcome(chatId) {
  await bot.sendMessage(chatId,
    `안녕하세요! 돈워리 병원동행 매니저 봇입니다. 👋\n\n` +
    `📌 등록하신 정보는 언제든지 수정 가능합니다.\n` +
    `✏️ 수정하려면 언제든지 "수정" 이라고 입력해주세요.\n\n` +
    `매니저 등록을 시작하려면 "매니저등록" 을 입력해주세요.`
  );
}

async function askName(chatId) {
  managerSessions[chatId] = { step: "name", data: {} };
  bot.sendMessage(chatId, "1️⃣ 성함이 어떻게 되시나요?");
}

async function askPhone(chatId) {
  managerSessions[chatId].step = "phone";
  bot.sendMessage(chatId, "2️⃣ 연락처를 알려주세요.\n예) 010-1234-5678");
}

async function askConsent(chatId) {
  managerSessions[chatId].step = "consent";
  bot.sendMessage(chatId,
    `📋 개인정보 수집 및 이용 동의\n\n` +
    `• 수집항목: 성함, 연락처\n` +
    `• 수집목적: 매니저 서비스 운영\n` +
    `• 보유기간: 서비스 탈퇴 시까지\n\n` +
    `위 내용에 동의하시나요?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ 동의합니다", callback_data: "consent_yes" }],
          [{ text: "❌ 동의하지 않습니다", callback_data: "consent_no" }]
        ]
      }
    }
  );
}

async function askRegions(chatId) {
  if (!managerSessions[chatId]) managerSessions[chatId] = { step: "regions", data: {} };
  managerSessions[chatId].step = "regions";
  bot.sendMessage(chatId,
    `📌 아래부터는 실시간 콜 매칭에 사용되는 정보입니다.\n` +
    `정확하게 입력해주실수록 맞는 콜을 받으실 수 있습니다.\n\n` +
    `3️⃣ 담당 가능한 지역을 알려주세요.\n` +
    `예) "서울이요" / "서울이랑 경기요" / "수도권 전체요"`
  );
}

async function askDays(chatId) {
  managerSessions[chatId].step = "days";
  managerSessions[chatId].data.days = managerSessions[chatId].data.days || [];
  const selected = managerSessions[chatId].data.days;
  bot.sendMessage(chatId,
    "4️⃣ 가능한 요일을 선택해주세요. (복수 선택 가능)",
    makeSelectionKeyboard(["월", "화", "수", "목", "금", "토", "일"], selected)
  );
}

async function askTimes(chatId) {
  managerSessions[chatId].step = "times";
  managerSessions[chatId].data.times = managerSessions[chatId].data.times || [];
  const selected = managerSessions[chatId].data.times;
  bot.sendMessage(chatId,
    "5️⃣ 가능한 시간대를 선택해주세요. (복수 선택 가능)",
    makeSelectionKeyboard(["오전", "오후", "저녁"], selected)
  );
}

async function askServiceType(chatId) {
  managerSessions[chatId].step = "service_type";
  bot.sendMessage(chatId,
    "6️⃣ 운전대행 서비스도 가능하신가요?\n(고객 차량으로 운전 후 병원 동행)",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚗 운전대행 가능 (동행+운전)", callback_data: "service_0" }],
          [{ text: "🚶 동행만 가능", callback_data: "service_2" }],
        ]
      }
    }
  );
}

async function completeRegistration(chatId) {
  const d = managerSessions[chatId].data;
  await pool.query(
    `INSERT INTO managers (name, phone, filter_regions, available_days, available_times, service_type, status, telegram_id)
     VALUES (?, ?, ?, ?, ?, ?, 'online', ?)`,
    [
      d.name, d.phone,
      JSON.stringify(d.regions),
      JSON.stringify(d.days),
      JSON.stringify(d.times),
      d.service_type,
      String(chatId)
    ]
  );
  delete managerSessions[chatId];
  bot.sendMessage(chatId,
    `✅ 매니저 등록이 완료되었습니다!\n\n` +
    `👤 이름: ${d.name}\n` +
    `📞 연락처: ${d.phone}\n` +
    `📍 담당 지역: ${d.regions.join(", ")}\n` +
    `📅 가능 요일: ${d.days.join(", ")}\n` +
    `⏰ 가능 시간: ${d.times.join(", ")}\n` +
    `🚗 서비스: ${d.service_type === 0 ? "운전대행+동행" : "동행만"}\n\n` +
    USAGE_GUIDE
  );
}

async function handleModification(chatId, manager) {
  managerSessions[chatId] = { step: "modify", data: { ...manager } };
  bot.sendMessage(chatId, `✏️ 수정할 항목을 선택해주세요.`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📍 담당 지역", callback_data: "modify_regions" }],
        [{ text: "📅 가능 요일", callback_data: "modify_days" }],
        [{ text: "⏰ 가능 시간대", callback_data: "modify_times" }],
        [{ text: "🚗 서비스 타입", callback_data: "modify_service" }],
        [{ text: "📞 연락처", callback_data: "modify_phone" }],
      ]
    }
  });
}

async function showMyBookings(chatId, manager) {
  const [rows] = await pool.query(
    `SELECT * FROM bookings WHERE manager_id = ? AND status = 'assigned' ORDER BY date ASC, time ASC`,
    [manager.id]
  );
  if (rows.length === 0) {
    bot.sendMessage(chatId, "📋 현재 배정된 예약이 없습니다.");
    return;
  }
          let msg = "\uD83D\uDCCB \uBC30\uC815\uB41C \uC608\uC57D \uBAA9\uB85D\n\n";
  rows.forEach((b, i) => {
    msg += `[${i + 1}] 예약번호: ${b.id}\n` +
      `👤 ${b.patient_name} (${b.age}세)\n` +
      `🏥 ${b.hospital}\n` +
      `📅 ${b.date} ${b.time}\n` +
      `🚗 ${b.service_type === 1 ? "운전대행+동행" : "동행만"}\n\n`;
  });
  bot.sendMessage(chatId, msg);
}

async function showMyStats(chatId, manager) {
  const now = new Date();
  const firstDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const [rows] = await pool.query(
    `SELECT COUNT(*) as total FROM bookings WHERE manager_id = ? AND status IN ('assigned','completed') AND date >= ?`,
    [manager.id, firstDay]
  );
  const [completed] = await pool.query(
    `SELECT COUNT(*) as total FROM bookings WHERE manager_id = ? AND status = 'completed' AND date >= ?`,
    [manager.id, firstDay]
  );
  bot.sendMessage(chatId,
    `📊 이번달 실적\n\n` +
    `📅 배정 건수: ${rows[0].total}건\n` +
    `✅ 완료 건수: ${completed[0].total}건`
  );
}

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const existing = await getManagerByChatId(chatId);
  if (existing) {
    bot.sendMessage(chatId,
      `안녕하세요 ${existing.name} 매니저님! 👋\n\n` +
      `현재 상태: ${existing.status === "online" ? "🟢 대기중" : "🔴 오프라인"}\n\n` +
      USAGE_GUIDE
    );
  } else {
    await sendWelcome(chatId);
  }
});

// 텍스트 메시지
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text || text.startsWith("/")) return;

  const session = managerSessions[chatId];

  // 등록 진행 중
  if (session && session.step !== "modify") {
    // Gemini로 의도 분석 (이름/전화번호 단계 제외)
    if (!["name", "phone", "consent"].includes(session.step)) {
      const intent = await analyzeManagerIntent(text, session.step, session.data);

      if (intent.intent === "cancel") {
        delete managerSessions[chatId];
        bot.sendMessage(chatId, "등록이 취소되었습니다. 다시 시작하려면 '매니저등록' 을 입력해주세요.");
        return;
      }
      if (intent.intent === "restart") {
        await askName(chatId);
        return;
      }
      if (intent.intent === "restart_step") {
        if (session.step === "regions") await askRegions(chatId);
        else if (session.step === "days") await askDays(chatId);
        else if (session.step === "times") await askTimes(chatId);
        return;
      }
      if (intent.intent === "modify" && intent.modify_field === "regions") {
        const regions = await extractRegions(intent.modify_value || text);
        session.data.regions = regions;
        bot.sendMessage(chatId, `📍 ${regions.join(", ")} 으로 변경했습니다.`);
        await askDays(chatId);
        return;
      }
    }

    if (session.step === "name") {
      session.data.name = text;
      await askPhone(chatId);
      return;
    }
    if (session.step === "phone") {
      session.data.phone = text;
      await askConsent(chatId);
      return;
    }
    if (session.step === "regions") {
      const regions = await extractRegions(text);
      session.data.regions = regions;
      bot.sendMessage(chatId, `📍 ${regions.join(", ")} 으로 설정했습니다.`);
      await askDays(chatId);
      return;
    }
    if (session.step === "modify_phone") {
      await pool.query("UPDATE managers SET phone = ? WHERE telegram_id = ?", [text, String(chatId)]);
      delete managerSessions[chatId];
      bot.sendMessage(chatId, `✅ 연락처가 ${text} 로 수정되었습니다.`);
      return;
    }
    if (session.step === "modify_regions") {
      const regions = await extractRegions(text);
      await pool.query("UPDATE managers SET filter_regions = ? WHERE telegram_id = ?",
        [JSON.stringify(regions), String(chatId)]);
      delete managerSessions[chatId];
      bot.sendMessage(chatId, `✅ 담당 지역이 ${regions.join(", ")} 으로 수정되었습니다.`);
      return;
    }
    return;
  }

  // 매니저등록
  if (text === "매니저등록") {
    const existing = await getManagerByChatId(chatId);
    if (existing) {
      bot.sendMessage(chatId, `이미 등록된 매니저입니다. (${existing.name})\n수정하려면 "수정" 을 입력해주세요.`);
      return;
    }
    await askName(chatId);
    return;
  }

  const manager = await getManagerByChatId(chatId);

  // 등록된 매니저 Gemini 자연어 수정 처리
  if (manager && session?.step !== "modify") {
    const modifyKeywords = ["바꿔", "변경", "수정", "추가", "제거", "빼", "만 가능", "로 바꿔"];
    const isModifyRequest = modifyKeywords.some(k => text.includes(k));

    if (isModifyRequest) {
      const intent = await analyzeManagerIntent(text, "modify", {});
      if (intent.intent === "modify" && intent.modify_field) {
        if (intent.modify_field === "regions") {
          const regions = await extractRegions(intent.modify_value || text);
          await pool.query("UPDATE managers SET filter_regions = ? WHERE telegram_id = ?",
            [JSON.stringify(regions), String(chatId)]);
          bot.sendMessage(chatId, `✅ 담당 지역이 ${regions.join(", ")} 으로 수정되었습니다.`);
          return;
        }
        if (intent.modify_field === "days") {
          managerSessions[chatId] = { step: "days", data: { days: [] }, isModifying: true };
          let current = [];
          try { current = JSON.parse(manager.available_days || "[]"); } catch {}

          // Gemini로 요일 추출
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          const r = await model.generateContent(
            `다음 텍스트에서 요일을 추출해서 JSON 배열로만 응답하세요. 월/화/수/목/금/토/일 중에서만.
"모두" 또는 "매일" 이면 ["월","화","수","목","금","토","일"] 반환.
텍스트: "${text}"
응답 예시: ["월","수","금"]`
          );
          const rtext = r.response.text().trim();
          const match = rtext.match(/\[[\s\S]*\]/);
          if (match) {
            const days = JSON.parse(match[0]);
            await pool.query("UPDATE managers SET available_days = ? WHERE telegram_id = ?",
              [JSON.stringify(days), String(chatId)]);
            delete managerSessions[chatId];
            bot.sendMessage(chatId, `✅ 가능 요일이 ${days.join(", ")} 으로 수정되었습니다.`);
            return;
          }
          // 추출 실패 시 버튼으로
          managerSessions[chatId].data.days = current;
          bot.sendMessage(chatId, "변경할 요일을 선택해주세요.",
            makeSelectionKeyboard(["월", "화", "수", "목", "금", "토", "일"], current)
          );
          return;
        }
        if (intent.modify_field === "times") {
          managerSessions[chatId] = { step: "times", data: { times: [] }, isModifying: true };
          let current = [];
          try { current = JSON.parse(manager.available_times || "[]"); } catch {}
          managerSessions[chatId].data.times = current;
          bot.sendMessage(chatId, "변경할 시간대를 선택해주세요.",
            makeSelectionKeyboard(["오전", "오후", "저녁"], current)
          );
          return;
        }
      }
    }
  }

  if (manager) {
    if (text === "대기중") {
      await pool.query("UPDATE managers SET status = 'online' WHERE telegram_id = ?", [String(chatId)]);
      bot.sendMessage(chatId, "🟢 대기 상태로 변경되었습니다. 콜이 들어오면 알려드릴게요!");
      return;
    }
    if (text === "휴식") {
      await pool.query("UPDATE managers SET status = 'offline' WHERE telegram_id = ?", [String(chatId)]);
      bot.sendMessage(chatId, "🔴 휴식 상태로 변경되었습니다.");
      return;
    }
    if (text === "내 예약") {
      await showMyBookings(chatId, manager);
      return;
    }
    if (text === "내 실적") {
      await showMyStats(chatId, manager);
      return;
    }
    if (text === "내 정보") {
      let regions = manager.filter_regions;
      let days = manager.available_days;
      let times = manager.available_times;
      try { regions = JSON.parse(regions).join(", "); } catch {}
      try { days = JSON.parse(days).join(", "); } catch {}
      try { times = JSON.parse(times).join(", "); } catch {}
      bot.sendMessage(chatId,
        `👤 이름: ${manager.name}\n` +
        `📞 전화: ${manager.phone}\n` +
        `📍 지역: ${regions}\n` +
        `📅 요일: ${days}\n` +
        `⏰ 시간: ${times}\n` +
        `🚗 서비스: ${manager.service_type === 0 ? "운전대행+동행" : "동행만"}\n` +
        `상태: ${manager.status === "online" ? "🟢 대기중" : "🔴 오프라인"}\n\n` +
        `수정하려면 "수정" 을 입력해주세요.`
      );
      return;
    }
    if (text === "수정") {
      await handleModification(chatId, manager);
      return;
    }
    if (text === "도움말") {
      bot.sendMessage(chatId, USAGE_GUIDE);
      return;
    }
    if (text.startsWith("예약취소")) {
      const bookingId = text.replace("예약취소", "").trim();
      if (!bookingId) {
        bot.sendMessage(chatId, "예약번호를 입력해주세요.\n예) 예약취소 12");
        return;
      }
      const [rows] = await pool.query(
        "SELECT * FROM bookings WHERE id = ? AND manager_id = ?",
        [bookingId, manager.id]
      );
      if (rows.length === 0) {
        bot.sendMessage(chatId, "해당 예약을 찾을 수 없습니다.");
        return;
      }
      await pool.query("UPDATE bookings SET manager_id = NULL, status = 'pending' WHERE id = ?", [bookingId]);
      bot.sendMessage(chatId, `✅ 예약번호 ${bookingId} 취소가 완료되었습니다.`);
      return;
    }
    // Gemini 자연어 처리
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const prompt = `
매니저가 다음 메시지를 보냈습니다: "${text}"

아래 중 어떤 의도인지 JSON으로만 답하세요:
- "my_schedule": 내 예약/일정 확인 ("내 일정", "내 예약", "예약 알려줘" 등)
- "my_stats": 실적/건수 확인 ("몇 건", "이번달", "실적" 등)  
- "set_online": 대기/콜 받기 ("대기할게", "콜 받을게", "시작할게" 등)
- "set_offline": 휴식/중지 ("쉴게요", "오늘 쉬어요", "콜 끊어줘" 등)
- "my_info": 내 정보 확인 ("내 정보", "내 조건", "내 설정" 등)
- "modify": 정보 수정 ("바꿔줘", "수정할게", "변경해줘" 등)
- "unknown": 위에 해당 없음

{"intent": "..."}
`;
      const result = await model.generateContent(prompt);
      const responseText = result.response.text().trim();
      const match = responseText.match(/{[^}]+}/);
      const parsed = match ? JSON.parse(match[0]) : { intent: "unknown" };

      if (parsed.intent === "my_schedule") {
        const [bookings] = await pool.query(
          "SELECT * FROM bookings WHERE manager_id = ? AND status = 'assigned' ORDER BY date ASC, time ASC LIMIT 10",
          [manager.id]
        );
        if (bookings.length === 0) {
          bot.sendMessage(chatId, "📋 현재 배정된 예약이 없습니다.");
        } else {
          let msg = "\uD83D\uDCCB \uBC30\uC815\uB41C \uC608\uC57D \uBAA9\uB85D\n\n";
          bookings.forEach((b, i) => {
            msg += (i+1) + ". 예약번호 " + b.id + "\n";
            msg += "   👤 " + b.patient_name + " (" + b.age + "세)\n";
            msg += "   🏥 " + b.hospital + "\n";
            msg += "   📅 " + b.date + " " + b.time + "\n";
            msg += "   ⏱ " + b.duration + "시간\n\n";
          });
          bot.sendMessage(chatId, msg);
        }
        return;
      }

      if (parsed.intent === "my_stats") {
        const now = new Date();
        const firstDay = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
        const [stats] = await pool.query(
          "SELECT COUNT(*) as count FROM bookings WHERE manager_id = ? AND date >= ?",
          [manager.id, firstDay]
        );
        bot.sendMessage(chatId, `📊 이번달 담당 예약: ${stats[0].count}건`);
        return;
      }

      if (parsed.intent === "set_online") {
        await pool.query("UPDATE managers SET status = 'online' WHERE telegram_id = ?", [chatId.toString()]);
        bot.sendMessage(chatId, "🟢 대기중 상태로 변경되었습니다. 콜을 받을 준비가 되었습니다!");
        return;
      }

      if (parsed.intent === "set_offline") {
        await pool.query("UPDATE managers SET status = 'offline' WHERE telegram_id = ?", [chatId.toString()]);
        bot.sendMessage(chatId, "🔴 휴식 상태로 변경되었습니다.");
        return;
      }

      if (parsed.intent === "my_info") {
        const regions = JSON.parse(manager.filter_regions || '[]').join(', ');
        const days = JSON.parse(manager.available_days || '[]').join(', ');
        const times = JSON.parse(manager.available_times || '[]').join(', ');
        bot.sendMessage(chatId,
          `👤 내 정보

` +
          `이름: ${manager.name}
` +
          `📞 전화: ${manager.phone}
` +
          `📍 지역: ${regions}
` +
          `📅 요일: ${days}
` +
          `⏰ 시간: ${times}
` +
          `🚗 서비스: ${manager.service_type === 0 ? "운전대행+동행" : "동행만"}
` +
          `상태: ${manager.status === "online" ? "🟢 대기중" : "🔴 오프라인"}`
        );
        return;
      }

      if (parsed.intent === "modify") {
        await handleModification(chatId, manager);
        return;
      }

    } catch (e) {
      console.error("Gemini 자연어 처리 오류:", e.message);
    }

    bot.sendMessage(chatId, USAGE_GUIDE);
    return;
  }

  await sendWelcome(chatId);
});

// 버튼 콜백
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = managerSessions[chatId];

  if (data === "consent_yes") {
    bot.answerCallbackQuery(query.id, { text: "동의하셨습니다." });
    await askRegions(chatId);
    return;
  }
  if (data === "consent_no") {
    bot.answerCallbackQuery(query.id);
    delete managerSessions[chatId];
    bot.sendMessage(chatId, "개인정보 동의가 필요합니다. 등록이 취소되었습니다.");
    return;
  }

  // 콜 수락/거절
  if (data.startsWith("accept_")) {
    const bookingId = data.replace("accept_", "");
    const manager = await getManagerByChatId(chatId);
    if (!manager) { bot.answerCallbackQuery(query.id); return; }
    const [rows] = await pool.query("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    if (rows.length === 0 || rows[0].status !== "pending") {
      bot.answerCallbackQuery(query.id, { text: "이미 처리된 예약입니다." });
      return;
    }
    await pool.query("UPDATE bookings SET manager_id = ?, status = 'assigned' WHERE id = ?",
      [manager.id, bookingId]);
    bot.answerCallbackQuery(query.id, { text: "수락했습니다!" });
    bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id });
    bot.sendMessage(chatId, `✅ 예약번호 ${bookingId} 수락 완료!\n취소하려면 "예약취소 ${bookingId}" 를 입력해주세요.`);

    // 고객 카카오톡으로 예약 확정 알림 발송
    const booking = rows[0];
    if (booking.kakao_user_id) {
      const serviceText = booking.service_type === 1 ? '운전대행+동행' : '동행만';
      const confirmMsg =
        `✅ 예약이 확정되었습니다!\n\n` +
        `👤 환자: ${booking.patient_name} (${booking.age}세)\n` +
        `🏥 병원: ${booking.hospital}\n` +
        `📅 일시: ${booking.date} ${booking.time}\n` +
        `🚗 서비스: ${serviceText}\n` +
        `👩‍⚕️ 담당 매니저: ${manager.name} (${manager.phone})\n\n` +
        `궁금한 점이 있으시면 언제든지 문의해주세요 😊`;
      // 관리자에게 고객 확정 안내 요청 알림
      const { sendTelegramMessage } = require('./kakao-api');
      const adminIds = (process.env.TELEGRAM_ADMIN_CHAT_IDS || process.env.TELEGRAM_ADMIN_CHAT_ID || '').split(',').filter(id => id.trim());
      for (const adminId of adminIds) {
        await sendTelegramMessage(adminId.trim(),
          `📨 고객 확정 안내 필요\n\n` +
          `👤 ${booking.patient_name} (${booking.age}세)\n` +
          `📅 ${booking.date} ${booking.time}\n` +
          `👩‍⚕️ 매니저: ${manager.name} (${manager.phone})\n\n` +
          `고객 카카오 채널에서 직접 확정 안내 메시지를 보내주세요!`
        );
      }
    }
    return;
  }
  if (data.startsWith("reject_")) {
    const bookingId = data.replace("reject_", "");
    bot.answerCallbackQuery(query.id, { text: "거절했습니다." });
    bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id });
    bot.sendMessage(chatId, `❌ 예약번호 ${bookingId} 거절했습니다.`);
    return;
  }

  if (data === "modify_regions") {
    bot.answerCallbackQuery(query.id);
    if (session) session.step = "modify_regions";
    bot.sendMessage(chatId, "새로운 담당 지역을 입력해주세요.\n예) 서울이랑 경기요 / 수도권 전체요");
    return;
  }
  if (data === "modify_days") {
    bot.answerCallbackQuery(query.id);
    if (session) {
      session.step = "days";
      let current = [];
      try { current = JSON.parse(session.data.available_days || "[]"); } catch {}
      session.data.days = current;
      session.isModifying = true;
      bot.sendMessage(chatId, "변경할 요일을 선택해주세요.",
        makeSelectionKeyboard(["월", "화", "수", "목", "금", "토", "일"], current)
      );
    }
    return;
  }
  if (data === "modify_times") {
    bot.answerCallbackQuery(query.id);
    if (session) {
      session.step = "times";
      let current = [];
      try { current = JSON.parse(session.data.available_times || "[]"); } catch {}
      session.data.times = current;
      session.isModifying = true;
      bot.sendMessage(chatId, "변경할 시간대를 선택해주세요.",
        makeSelectionKeyboard(["오전", "오후", "저녁"], current)
      );
    }
    return;
  }
  if (data === "modify_service") {
    bot.answerCallbackQuery(query.id);
    if (session) session.step = "modify_service";
    bot.sendMessage(chatId, "서비스 타입을 선택해주세요.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚗 운전대행 가능 (동행+운전)", callback_data: "service_0" }],
          [{ text: "🚶 동행만 가능", callback_data: "service_2" }],
        ]
      }
    });
    return;
  }
  if (data === "modify_phone") {
    bot.answerCallbackQuery(query.id);
    if (session) session.step = "modify_phone";
    bot.sendMessage(chatId, "새로운 연락처를 입력해주세요.\n예) 010-1234-5678");
    return;
  }

  if (data.startsWith("select_")) {
    if (!session) { bot.answerCallbackQuery(query.id); return; }
    const value = data.replace("select_", "");

    if (value === "done") {
      const currentStep = session.step;
      const selectedList = session.data[currentStep];
      if (!selectedList || selectedList.length === 0) {
        bot.answerCallbackQuery(query.id, { text: "최소 1개 이상 선택해주세요." });
        return;
      }
      bot.answerCallbackQuery(query.id);

      if (session.isModifying) {
        const field = currentStep === "days" ? "available_days" : "available_times";
        await pool.query(`UPDATE managers SET ${field} = ? WHERE telegram_id = ?`,
          [JSON.stringify(selectedList), String(chatId)]);
        delete managerSessions[chatId];
        bot.sendMessage(chatId, `✅ ${currentStep === "days" ? "요일" : "시간대"}이 ${selectedList.join(", ")} 으로 수정되었습니다.`);
        return;
      }
      if (currentStep === "days") await askTimes(chatId);
      else if (currentStep === "times") await askServiceType(chatId);
      return;
    }

    const currentStep = session.step;
    const list = session.data[currentStep];
    const idx = list.indexOf(value);
    if (idx === -1) list.push(value);
    else list.splice(idx, 1);

    let options = [];
    if (currentStep === "days") options = ["월", "화", "수", "목", "금", "토", "일"];
    else if (currentStep === "times") options = ["오전", "오후", "저녁"];

    bot.editMessageReplyMarkup(
      makeSelectionKeyboard(options, list).reply_markup,
      { chat_id: chatId, message_id: query.message.message_id }
    );
    bot.answerCallbackQuery(query.id, { text: `${value} ${idx === -1 ? "선택" : "해제"}` });
    return;
  }

  if (data.startsWith("service_")) {
    const serviceType = parseInt(data.replace("service_", ""));
    bot.answerCallbackQuery(query.id);
    if (session?.step === "modify_service") {
      await pool.query("UPDATE managers SET service_type = ? WHERE telegram_id = ?",
        [serviceType, String(chatId)]);
      delete managerSessions[chatId];
      bot.sendMessage(chatId, `✅ 서비스 타입이 수정되었습니다.`);
      return;
    }
    if (session) {
      session.data.service_type = serviceType;
      await completeRegistration(chatId);
    }
    return;
  }

  bot.answerCallbackQuery(query.id);
});

module.exports = bot;
