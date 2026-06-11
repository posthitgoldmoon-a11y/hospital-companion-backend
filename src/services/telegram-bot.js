const TelegramBot = require("node-telegram-bot-api");
const pool = require("./db");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const managerSessions = {};

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
"수도권 전체" 또는 "어디든" 이면 ["서울","경기","인천"] 반환.
텍스트: "${text}"
응답 예시: ["서울","경기"]`
  );
  const response = result.response.text().trim();
  const match = response.match(/\[[\s\S]*\]/);
  if (!match) return ["서울"];
  try { return JSON.parse(match[0]); } catch { return ["서울"]; }
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
      d.name,
      d.phone,
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
    `예약 콜이 들어오면 바로 알려드리겠습니다! 🔔\n\n` +
    `📌 정보 수정은 언제든지 "수정" 이라고 입력해주세요.\n` +
    `🟢 콜 받기 시작: "대기중" 입력\n` +
    `🔴 콜 받기 중지: "휴식" 입력`
  );
}

async function handleModification(chatId, manager) {
  managerSessions[chatId] = { step: "modify", data: { ...manager } };
  bot.sendMessage(chatId,
    `✏️ 수정할 항목을 선택해주세요.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📍 담당 지역", callback_data: "modify_regions" }],
          [{ text: "📅 가능 요일", callback_data: "modify_days" }],
          [{ text: "⏰ 가능 시간대", callback_data: "modify_times" }],
          [{ text: "🚗 서비스 타입", callback_data: "modify_service" }],
          [{ text: "📞 연락처", callback_data: "modify_phone" }],
        ]
      }
    }
  );
}

// /start 명령어
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const existing = await getManagerByChatId(chatId);
  if (existing) {
    bot.sendMessage(chatId,
      `안녕하세요 ${existing.name} 매니저님! 👋\n\n` +
      `현재 상태: ${existing.status === "online" ? "🟢 대기중" : "🔴 오프라인"}\n\n` +
      `명령어:\n` +
      `대기중 - 콜 받기 시작\n` +
      `휴식 - 콜 받기 중지\n` +
      `내 정보 - 등록 정보 확인\n` +
      `수정 - 정보 수정`
    );
  } else {
    await sendWelcome(chatId);
  }
});

// 텍스트 메시지 처리
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text || text.startsWith("/")) return;

  const session = managerSessions[chatId];

  // 등록 진행 중
  if (session && session.step !== "modify") {
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

  // 수정
  if (text === "수정") {
    const manager = await getManagerByChatId(chatId);
    if (!manager) {
      bot.sendMessage(chatId, `먼저 매니저 등록을 해주세요.`);
      return;
    }
    await handleModification(chatId, manager);
    return;
  }

  // 등록된 매니저 명령어
  const manager = await getManagerByChatId(chatId);
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
    bot.sendMessage(chatId,
      `명령어 안내:\n대기중 - 콜 받기 시작\n휴식 - 콜 받기 중지\n내 정보 - 등록 정보 확인\n수정 - 정보 수정`
    );
    return;
  }

  await sendWelcome(chatId);
});

// 버튼 콜백 처리
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = managerSessions[chatId];

  // 개인정보 동의
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

  // 수정 항목 선택
  if (data === "modify_regions") {
    bot.answerCallbackQuery(query.id);
    session.step = "modify_regions";
    bot.sendMessage(chatId, "새로운 담당 지역을 입력해주세요.\n예) 서울이랑 경기요 / 수도권 전체요");
    return;
  }
  if (data === "modify_days") {
    bot.answerCallbackQuery(query.id);
    session.step = "days";
    let current = [];
    try { current = JSON.parse(session.data.available_days || "[]"); } catch {}
    session.data.days = current;
    session.isModifying = true;
    bot.sendMessage(chatId, "변경할 요일을 선택해주세요.",
      makeSelectionKeyboard(["월", "화", "수", "목", "금", "토", "일"], current)
    );
    return;
  }
  if (data === "modify_times") {
    bot.answerCallbackQuery(query.id);
    session.step = "times";
    let current = [];
    try { current = JSON.parse(session.data.available_times || "[]"); } catch {}
    session.data.times = current;
    session.isModifying = true;
    bot.sendMessage(chatId, "변경할 시간대를 선택해주세요.",
      makeSelectionKeyboard(["오전", "오후", "저녁"], current)
    );
    return;
  }
  if (data === "modify_service") {
    bot.answerCallbackQuery(query.id);
    session.step = "modify_service";
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
    session.step = "modify_phone";
    bot.sendMessage(chatId, "새로운 연락처를 입력해주세요.\n예) 010-1234-5678");
    return;
  }

  // 지역/요일/시간 선택
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
        // 수정 완료
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

  // 서비스 타입 선택
  if (data.startsWith("service_")) {
    const serviceType = parseInt(data.replace("service_", ""));
    bot.answerCallbackQuery(query.id);

    if (session.step === "modify_service") {
      await pool.query("UPDATE managers SET service_type = ? WHERE telegram_id = ?",
        [serviceType, String(chatId)]);
      delete managerSessions[chatId];
      bot.sendMessage(chatId, `✅ 서비스 타입이 수정되었습니다.`);
      return;
    }

    session.data.service_type = serviceType;
    await completeRegistration(chatId);
    return;
  }

  bot.answerCallbackQuery(query.id);
});

module.exports = bot;
