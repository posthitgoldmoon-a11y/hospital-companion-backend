const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const { chat } = require("../services/gemini");
const { findAvailableManager } = require("../services/manager-filter");
const { createBooking, assignManager } = require("../models/booking");
const { findOrCreateCustomer } = require("../models/customer");
const { makeTextResponse, makeBookingConfirmResponse, sendManagerNotification } = require("../services/kakao-api");
const pool = require("../services/db");

const sessions = {};

const REQUIRED_FIELDS = ["patient_name", "age", "hospital", "region", "date", "time", "duration", "service_type"];

const MANAGER_STEPS = [
  { field: "name", question: "매니저 성함이 어떻게 되시나요?" },
  { field: "phone", question: "연락처를 입력해주세요. (예: 010-1234-5678)" },
  { field: "regions", question: "담당 가능한 지역을 선택해주세요.\n(복수 선택 가능, 쉼표로 구분)\n예: 서울, 경기" },
  { field: "days", question: "가능한 요일을 선택해주세요.\n(복수 선택 가능, 쉼표로 구분)\n예: 월, 화, 수, 목, 금" },
  { field: "times", question: "가능한 시간대를 선택해주세요.\n(복수 선택 가능, 쉼표로 구분)\n예: 오전, 오후, 저녁" },
  { field: "service_type", question: "제공 가능한 서비스를 선택해주세요.\n1. 기사동행 포함\n2. 기사동행 미포함\n3. 둘 다 가능" },
];

function isComplete(data) {
  if (!data) return false;
  return REQUIRED_FIELDS.every(f => data[f] !== null && data[f] !== undefined && data[f] !== "null");
}

function mergeData(existing, newData) {
  if (!newData) return existing;
  const merged = { ...existing };
  for (const key of REQUIRED_FIELDS) {
    if (newData[key] !== null && newData[key] !== undefined && newData[key] !== "null") {
      merged[key] = newData[key];
    }
  }
  return merged;
}

async function isManager(kakaoUserId) {
  const [rows] = await pool.query(
    "SELECT * FROM managers WHERE kakao_user_id = ?",
    [kakaoUserId]
  );
  return rows.length > 0 ? rows[0] : null;
}

async function finalizeBooking(session, kakaoUserId) {
  const customer = await findOrCreateCustomer(kakaoUserId);
  const booking = await createBooking({
    customer_id: customer.id,
    ...session.data,
    duration: parseInt(session.data.duration) || 2,
    service_type: parseInt(session.data.service_type) || 2,
    kakao_user_id: kakaoUserId,
  });

  const manager = await findAvailableManager(session.data.region, parseInt(session.data.service_type), session.data.date, session.data.time);

  if (!manager) {
    sessions[kakaoUserId] = { history: [], data: {}, booked: false };
    return makeTextResponse("죄송합니다. 현재 해당 지역에 가능한 매니저가 없습니다.\n잠시 후 다시 시도해주세요.");
  }

  // 매니저에게 콜 발송 (수락 전까지 배정 안 함)
  sendManagerNotification(manager, { ...booking, region: session.data.region });
  session.data = {};
  session.booted = true;
  const serviceText = booking.service_type == 1 ? '기사동행 포함' : '기사동행 미포함';
  const specialText = booking.special_requests ? `\n⚠️ 요청사항: ${booking.special_requests}` : '';
  return makeTextResponse(
    '✅ 예약 접수가 완료되었습니다!\n\n' +
    `👤 환자: ${booking.patient_name} (${booking.age}세)\n` +
    `🏥 병원: ${booking.hospital} (${booking.region})\n` +
    `📅 날짜: ${booking.date} ${booking.time}\n` +
    `🚗 서비스: ${serviceText}\n` +
    `⏱ 이용시간: ${booking.duration}시간` +
    `${specialText}\n\n` +
    `예약번호: ${booking.id}\n\n` +
    '매니저님께 콜을 발송했습니다.\n곧 연락드리겠습니다 😊'
  );
}

async function handleManagerRegistration(session, kakaoUserId, userMessage) {
  const currentStep = MANAGER_STEPS[session.managerStep];

  // 입력값 저장
  session.managerData[currentStep.field] = userMessage.trim();
  session.managerStep++;

  // 다음 질문
  if (session.managerStep < MANAGER_STEPS.length) {
    return makeTextResponse(MANAGER_STEPS[session.managerStep].question);
  }

  // 모든 정보 수집 완료 → DB 저장
  const d = session.managerData;
  const serviceType = d.service_type.includes("3") ? 0 :
                      d.service_type.includes("1") ? 1 : 2;

  await pool.query(
    `INSERT INTO managers (name, phone, filter_regions, available_days, available_times, service_type, status, kakao_user_id)
     VALUES (?, ?, ?, ?, ?, ?, 'online', ?)`,
    [
      d.name,
      d.phone,
      JSON.stringify(d.regions.split(",").map(r => r.trim())),
      JSON.stringify(d.days.split(",").map(r => r.trim())),
      JSON.stringify(d.times.split(",").map(r => r.trim())),
      serviceType,
      kakaoUserId
    ]
  );

  sessions[kakaoUserId] = { history: [], data: {}, booked: false, isManager: true };

  return makeTextResponse(
    `✅ 매니저 등록이 완료되었습니다!\n\n` +
    `👤 이름: ${d.name}\n` +
    `📞 연락처: ${d.phone}\n` +
    `📍 담당 지역: ${d.regions}\n` +
    `📅 가능 요일: ${d.days}\n` +
    `⏰ 가능 시간: ${d.times}\n\n` +
    `예약 콜이 들어오면 바로 알려드리겠습니다! 🔔`
  );
}

async function processAndCallback(kakaoUserId, userMessage, callbackUrl) {
  const mainButtons = {
    hospital_companion: { btn3: '서비스요금보기', btn4: null },
    hospital:           { btn3: '병원정보', btn4: null },
    restaurant:         { btn3: '매장정보', btn4: '메뉴보기' },
    beauty:             { btn3: '매장정보', btn4: '요금안내' },
    accommodation:      { btn3: '매장정보', btn4: null },
    massage:            { btn3: '매장정보', btn4: '요금안내' },
    airport_taxi:       { btn3: '회사정보', btn4: '요금안내' },
    vet:                { btn3: '병원정보', btn4: '진료비안내' },
    templestay:         { btn3: '템플정보', btn4: '요금안내' },
    skincare:           { btn3: '매장정보', btn4: '요금안내' },
    golf:               { btn3: '골프장정보', btn4: '요금안내' },
    rentcar:            { btn3: '매장정보', btn4: '요금안내' },
    activity:           { btn3: '시설정보', btn4: '요금안내' },
    sports:             { btn3: '시설정보', btn4: '요금안내' },
    partyroom:          { btn3: '회사정보', btn4: '요금안내' },
    nail:               { btn3: '매장정보', btn4: '요금안내' },
    studio:             { btn3: '스튜디오정보', btn4: '요금안내' },
    studycafe:          { btn3: '매장정보', btn4: '요금안내' },
    yoga:               { btn3: '매장정보', btn4: '요금안내' },
    swimming:           { btn3: '수영장정보', btn4: '요금안내' }
  };
  try {
    const isNewSession = !sessions[kakaoUserId];
    if (!sessions[kakaoUserId]) {
      sessions[kakaoUserId] = { history: [], data: {}, booted: false };
    }
    const session = sessions[kakaoUserId];

// 매니저 등록 진행 중
    if (session.step === "manager_registration") {
      const response = await handleManagerRegistration(session, kakaoUserId, userMessage);
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response)
      });
      return;
    }

    // 1단계 버튼 처리
    const industryBookingButtons = {
      hospital_companion: ['상품별 예약', '날짜별 예약'],
      hospital: ['시술별 예약', '의사별 예약', '날짜별 예약'],
      restaurant: ['메뉴별 예약', '날짜별 예약'],
      beauty: ['스타일리스트로 예약', '시술로 예약', '날짜로 예약'],
      accommodation: ['타입별 예약', '날짜별 예약'],
      massage: ['상품별 예약', '날짜별 예약'],
      airport_taxi: ['상품별 예약', '날짜별 예약'],
      vet: ['시술별 예약', '의사별 예약', '날짜별 예약'],
      templestay: ['프로그램별 예약', '날짜별 예약'],
      skincare: ['시술종류별 예약', '날짜별 예약'],
      golf: ['코스별 예약', '날짜별 예약'],
      rentcar: ['차종별 예약', '기간별 예약', '날짜별 예약'],
      activity: ['액티비티별 예약', '날짜별 예약'],
      sports: ['상품별 예약', '날짜별 예약'],
      partyroom: ['상품별 예약', '날짜별 예약'],
      nail: ['시술별 예약', '날짜별 예약'],
      studio: ['상품별 예약', '날짜별 예약'],
      studycafe: ['상품별 예약', '날짜별 예약'],
      yoga: ['상품별 예약', '코치별 예약', '날짜별 예약'],
      swimming: ['상품별 예약', '날짜별 예약']
    };

    // 예약하기 버튼 처리
    if (userMessage.trim() === '예약하기') {
      const btns = (industryBookingButtons[session.industry] || ['날짜별 예약']).map(label => ({
        action: "message", label: label, messageText: label
      }));
      btns.push({ action: "message", label: "↩️ 이전으로", messageText: "이전으로" });
      btns.push({ action: "message", label: "🏠 처음으로", messageText: "처음으로" });
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: {
            outputs: [{ simpleText: { text: "예약 방식을 선택해주세요! 😊" } }],
            quickReplies: btns
          }
        })
      });
      return;
    }

    // 상담하기 버튼 처리
    if (userMessage.trim() === '상담하기') {
      const { message } = await require('../services/gemini').chat(
        session.history, '상담을 시작합니다. 고객이 상담하기를 눌렀습니다. 친절하게 인사하고 어떤 도움이 필요한지 질문해주세요.',
        session.booted, session.industry
      );
      session.history.push({ role: "user", content: "상담하기" });
      session.history.push({ role: "model", content: message });
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: {
            outputs: [{ simpleText: { text: message } }],
            quickReplies: [
              { action: "message", label: "↩️ 이전으로", messageText: "이전으로" },
              { action: "message", label: "🏠 처음으로", messageText: "처음으로" }
            ]
          }
        })
      });
      return;
    }

    // 이전으로 버튼 처리 → 1단계 메인 버튼으로
    if (userMessage.trim() === '이전으로') {
      if (session.industry) {
        const mb = mainButtons[session.industry] || { btn3: '요금안내', btn4: null };
        const quickReplies = [
          { action: "message", label: "1️⃣ 예약하기", messageText: "예약하기" },
          { action: "message", label: "2️⃣ 상담하기", messageText: "상담하기" },
          { action: "message", label: `3️⃣ ${mb.btn3}`, messageText: mb.btn3 }
        ];
        if (mb.btn4) quickReplies.push({ action: "message", label: `4️⃣ ${mb.btn4}`, messageText: mb.btn4 });
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: "2.0",
            template: {
              outputs: [{ simpleText: { text: "처음으로 돌아왔어요 😊 무엇을 도와드릴까요?" } }],
              quickReplies: quickReplies
            }
          })
        });
      }
      return;
    }

    // 매장정보/병원정보 등 클릭 시 → 세부 버튼
    const infoKeywords = ['매장정보', '병원정보', '회사정보', '시설정보', '골프장정보', '템플정보', '스튜디오정보', '수영장정보'];
    if (infoKeywords.includes(userMessage.trim())) {
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: {
            outputs: [{ simpleText: { text: "어떤 정보를 원하시나요? 😊" } }],
            quickReplies: [
              { action: "message", label: "📋 소개보기", messageText: "소개보기" },
              { action: "message", label: "🕐 영업시간", messageText: "영업시간" },
              { action: "message", label: "🅿️ 주차안내", messageText: "주차안내" },
              { action: "message", label: "📅 휴무일안내", messageText: "휴무일안내" },
              { action: "message", label: "↩️ 이전으로", messageText: "이전으로" },
              { action: "message", label: "🏠 처음으로", messageText: "처음으로" }
            ]
          }
        })
      });
      return;
    }

    // 날짜확인 키워드 처리
    if (userMessage.trim() === '날짜확인') {
      if (session.pendingDate) {
        const pendingDate = session.pendingDate;
        delete session.pendingDate;
        const dateMessage = `${pendingDate}으로 예약 날짜와 시간을 선택했습니다. 예약에 필요한 다음 정보를 안내해주세요.`;
        const { message, bookingData } = await chat(session.history, dateMessage, session.booted, session.industry);
        session.data = mergeData(session.data, bookingData);
        session.history.push({ role: "user", content: dateMessage });
        session.history.push({ role: "model", content: message });
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: `📅 ${pendingDate}

${message}` } }] }
          })
        });
      } else {
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: "먼저 날짜/시간을 선택해주세요! 📅" } }] }
          })
        });
      }
      return;
    }

    // 캘린더에서 선택한 날짜 자동 처리
    if (session.pendingDate) {
      const pendingDate = session.pendingDate;
      delete session.pendingDate;
      const { message, bookingData, showDriverButtons, humanAgentRequest, showPrice, showCalendar } = await chat(session.history, pendingDate, session.booted, session.industry);
      session.data = mergeData(session.data, bookingData);
      session.history.push({ role: "user", content: pendingDate });
      session.history.push({ role: "model", content: message });
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: { outputs: [{ simpleText: { text: `📅 ${pendingDate} 선택하셨습니다!

${message}` } }] }
        })
      });
      return;
    }

    // 업종변경 키워드 → 캐러셀로
    const industryChangeKeywords = ['업종변경', '메인으로', '다시', '홈'];
    if (industryChangeKeywords.includes(userMessage.trim())) {
      sessions[kakaoUserId] = { history: [], data: {}, booted: false };
      const BASE_URL = "http://158.180.83.78:3000/images";
      const row1 = [
        { title: "🏥 병원동행", desc: "접수부터 수납까지 보호자처럼", img: "industry_hospital_companion.jpg", msg: "병원동행" },
        { title: "🏨 병원", desc: "전문의와 함께하는 진료 예약", img: "industry_hospital.jpg", msg: "병원" },
        { title: "🍽️ 식당", desc: "특별한 날을 위한 레스토랑", img: "industry_restaurant.jpg", msg: "식당" },
        { title: "💇 미용실", desc: "나만의 스타일을 찾아드려요", img: "industry_beauty.jpg", msg: "미용실" },
        { title: "🏨 숙박", desc: "편안한 휴식을 위한 숙소", img: "industry_accommodation.jpg", msg: "숙박" },
        { title: "💆 마사지", desc: "몸과 마음의 힐링", img: "industry_massage.jpg", msg: "마사지" },
        { title: "✈️ 공항택시", desc: "안전하고 편안한 공항 이동", img: "industry_airport_taxi.jpg", msg: "공항택시" },
        { title: "🐾 동물병원", desc: "소중한 반려동물의 건강", img: "industry_vet.jpg", msg: "동물병원" },
        { title: "🏯 템플스테이", desc: "마음을 치유하는 사찰 체험", img: "industry_templestay.jpg", msg: "템플스테이" },
        { title: "✨ 피부관리", desc: "빛나는 피부를 위한 케어", img: "industry_skincare.jpg", msg: "피부관리" }
      ];
      const row2 = [
        { title: "⛳ 골프", desc: "그린 위의 특별한 라운드", img: "industry_golf.jpg", msg: "골프" },
        { title: "🚗 렌트카", desc: "자유로운 여행을 위한 렌터카", img: "industry_rentcar.jpg", msg: "렌트카" },
        { title: "🧗 액티비티", desc: "짜릿한 야외 액티비티", img: "industry_activity.jpg", msg: "액티비티" },
        { title: "🏋️ 체육시설", desc: "건강한 몸을 위한 운동", img: "industry_sports.jpg", msg: "체육시설" },
        { title: "🎉 파티룸", desc: "특별한 파티를 위한 공간", img: "industry_partyroom.jpg", msg: "파티룸" },
        { title: "💅 네일샵", desc: "아름다운 손끝을 위한 케어", img: "industry_nail.jpg", msg: "네일샵" },
        { title: "📸 사진스튜디오", desc: "소중한 순간을 담아드려요", img: "industry_studio.jpg", msg: "사진스튜디오" },
        { title: "📚 스터디카페", desc: "집중할 수 있는 공간", img: "industry_studycafe.jpg", msg: "스터디카페" },
        { title: "🧘 요가/필라테스", desc: "몸과 마음의 균형", img: "industry_yoga.jpg", msg: "요가" },
        { title: "🏊 수영/볼링", desc: "즐거운 스포츠 활동", img: "industry_swimming.jpg", msg: "수영" }
      ];
      const makeItems = arr => arr.map(item => ({
        title: item.title,
        description: item.desc,
        thumbnail: { imageUrl: `${BASE_URL}/${item.img}`, link: { web: `${BASE_URL}/${item.img}` } },
        buttons: [{ action: "message", label: "선택하기", messageText: item.msg }]
      }));
      const carouselResponse = {
        version: "2.0",
        template: {
          outputs: [
            { simpleText: { text: "업종을 선택해주세요! 😊" } },
            { carousel: { type: "basicCard", items: makeItems(row1) } },
            { carousel: { type: "basicCard", items: makeItems(row2) } }
          ]
        }
      };
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(carouselResponse)
      });
      return;
    }

    // 처음으로 키워드 → 같은 업종 인사말로
    if (userMessage.trim() === '처음으로' || userMessage.trim() === '취소') {
      if (session.industry) {
        session.history = [];
        session.data = {};
        session.booted = false;
        session.step = null;
        const industryNames = {
          hospital_companion: '병원동행', hospital: '병원', restaurant: '식당',
          beauty: '미용실', accommodation: '숙박', massage: '마사지',
          airport_taxi: '공항택시', vet: '동물병원', templestay: '템플스테이',
          skincare: '피부관리', golf: '골프', rentcar: '렌트카',
          activity: '액티비티', sports: '체육시설', partyroom: '파티룸',
          nail: '네일샵', studio: '사진스튜디오', studycafe: '스터디카페',
          yoga: '요가', swimming: '수영'
        };
        userMessage = industryNames[session.industry] || session.industry;
      } else {
        sessions[kakaoUserId] = { history: [], data: {}, booted: false };
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: "2.0",
            template: { outputs: [{ simpleText: { text: "처음 화면으로 돌아갑니다 😊\n아래에서 업종을 선택해주세요!" } }] }
          })
        });
        return;
      }
    }

    // 미용실 스타일리스트 선택 캐러셀
    if (session.industry === 'beauty' && userMessage.trim() === '스타일리스트 선택') {
      const BASE_URL = "http://158.180.83.78:3000/images";
      const stylists = [
        {
          name: "다은 T",
          desc: "모류교정 전문 | 외국인 고객 전문 | 헤드스파 전문",
          img: "daun.jpg",
          msg: "다은T 선택"
        },
        {
          name: "지수 T",
          desc: "컬러 전문 | 손상모 케어 전문 | 블리치 전문",
          img: "jisu.jpg",
          msg: "지수T 선택"
        },
        {
          name: "민준 T",
          desc: "남성 커트 전문 | 펌 전문 | 두상 맞춤 스타일",
          img: "minjun.jpg",
          msg: "민준T 선택"
        }
      ];
      const carouselItems = stylists.map(s => ({
        title: s.name,
        description: s.desc,
        thumbnail: { imageUrl: `${BASE_URL}/${s.img}`, link: { web: `${BASE_URL}/${s.img}` } },
        buttons: [{ action: "message", label: "선택하기", messageText: s.msg }, { action: "webLink", label: "크게 보기 🔍", webLinkUrl: `${BASE_URL}/${s.img}` }]
      }));
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: {
            outputs: [{
              carousel: { type: "basicCard", items: carouselItems }
            }]
          }
        })
      });
      return;
    }

    // 예약 방식 키워드 직접 처리
    const DOCTOR_KEYWORDS = ['의사별 예약', '원장 선택', '의사 선택'];
    const STYLIST_KEYWORDS = ['스타일리스트로 예약', '스타일리스트 선택'];
    const DATE_KEYWORDS = ['날짜별 예약', '날짜로 예약', '날짜 선택', '날짜 입력'];

    if (DATE_KEYWORDS.includes(userMessage.trim())) {
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: {
            outputs: [
              { simpleText: { text: "날짜와 시간을 선택해주세요! 📅" } },
              { basicCard: {
                title: "📅 날짜/시간 선택",
                description: "버튼을 눌러 날짜와 시간을 선택해주세요!",
                buttons: [
                  { action: "webLink", label: "1️⃣ 날짜/시간 선택하기", webLinkUrl: (session.industry === 'accommodation' || session.industry === 'rentcar')
              ? `http://158.180.83.78:3000/calendar_range.html?userId=${kakaoUserId}&industry=${session.industry}`
              : `http://158.180.83.78:3000/calendar.html?userId=${kakaoUserId}` },
                  { action: "message", label: "2️⃣ 선택한 날짜 확인하기", messageText: "날짜확인" }
                ]
              }}
            ]
          }
        })
      });
      return;
    }

    if (session.industry === 'vet' && DOCTOR_KEYWORDS.includes(userMessage.trim())) {
      const BASE_URL = "http://158.180.83.78:3000/images";
      const vets = [
        { name: "김도현 원장", desc: "수의사 15년 | 내과/외과 전문", img: "vet_1.jpg", msg: "김도현 원장 선택" },
        { name: "박준서 원장", desc: "수의사 10년 | 피부/치과 전문", img: "vet_2.jpg", msg: "박준서 원장 선택" },
        { name: "이하은 원장", desc: "수의사 8년 | 영상의학/예방의학 전문", img: "vet_3.jpg", msg: "이하은 원장 선택" }
      ];
      const carouselItems = vets.map(v => ({
        title: v.name,
        description: v.desc,
        thumbnail: { imageUrl: `${BASE_URL}/${v.img}`, link: { web: `${BASE_URL}/${v.img}` } },
        buttons: [
          { action: "webLink", label: "크게 보기 🔍", webLinkUrl: `${BASE_URL}/${v.img}` },
          { action: "message", label: "선택하기", messageText: v.msg }
        ]
      }));
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: { outputs: [{ carousel: { type: "basicCard", items: carouselItems } }] }
        })
      });
      return;
    }

    if (session.industry === 'hospital' && DOCTOR_KEYWORDS.includes(userMessage.trim())) {
      const BASE_URL = "http://158.180.83.78:3000/images";
      const doctors = [
        { name: "김연세 원장", desc: "피부과 전문의 20년 | 레이저 시술 전문", img: "doctor_1.jpg", msg: "김연세 원장 선택" },
        { name: "박푸르미 원장", desc: "피부과 전문의 15년 | 여드름/흉터 전문", img: "doctor_2.jpg", msg: "박푸르미 원장 선택" },
        { name: "이미소 원장", desc: "피부과 전문의 10년 | 안티에이징/리프팅 전문", img: "doctor_3.jpg", msg: "이미소 원장 선택" }
      ];
      const carouselItems = doctors.map(d => ({
        title: d.name,
        description: d.desc,
        thumbnail: { imageUrl: `${BASE_URL}/${d.img}`, link: { web: `${BASE_URL}/${d.img}` } },
        buttons: [{ action: "message", label: "선택하기", messageText: d.msg }, { action: "webLink", label: "크게 보기 🔍", webLinkUrl: `${BASE_URL}/${d.img}` }]
      }));
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: {
            outputs: [
              { simpleText: { text: "담당 원장님을 선택해주세요! 😊" } },
              { carousel: { type: "basicCard", items: carouselItems } }
            ]
          }
        })
      });
      return;
    }

    if (session.industry === 'beauty' && STYLIST_KEYWORDS.includes(userMessage.trim())) {
      const BASE_URL = "http://158.180.83.78:3000/images";
      const stylists = [
        { name: "다은 T", desc: "모류교정 전문 | 외국인 고객 전문 | 헤드스파 전문", img: "daun.jpg", msg: "다은T 선택" },
        { name: "지수 T", desc: "컬러 전문 | 손상모 케어 전문 | 블리치 전문", img: "jisu.jpg", msg: "지수T 선택" },
        { name: "민준 T", desc: "남성 커트 전문 | 펌 전문 | 두상 맞춤 스타일", img: "minjun.jpg", msg: "민준T 선택" }
      ];
      const carouselItems = stylists.map(s => ({
        title: s.name,
        description: s.desc,
        thumbnail: { imageUrl: `${BASE_URL}/${s.img}`, link: { web: `${BASE_URL}/${s.img}` } },
        buttons: [{ action: "message", label: "선택하기", messageText: s.msg }, { action: "webLink", label: "크게 보기 🔍", webLinkUrl: `${BASE_URL}/${s.img}` }]
      }));
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: {
            outputs: [
              { simpleText: { text: "스타일리스트를 선택해주세요! 😊" } },
              { carousel: { type: "basicCard", items: carouselItems } }
            ]
          }
        })
      });
      return;
    }

    // 업종 선택 감지
    const INDUSTRY_MAP = {
      '병원동행': 'hospital_companion',
      '병원': 'hospital',
      '식당': 'restaurant',
      '미용실': 'beauty',
      '숙박': 'accommodation',
      '마사지': 'massage',
      '공항택시': 'airport_taxi',
      '동물병원': 'vet',
      '템플스테이': 'templestay',
      '피부관리': 'skincare',
      '골프': 'golf',
      '렌트카': 'rentcar',
      '액티비티': 'activity',
      '체육시설': 'sports',
      '파티룸': 'partyroom',
      '네일샵': 'nail',
      '사진스튜디오': 'studio',
      '스터디카페': 'studycafe',
      '요가': 'yoga',
      '수영장': 'swimming'
    };
    const selectedIndustry = INDUSTRY_MAP[userMessage.trim()];
    if (selectedIndustry) {
      session.industry = selectedIndustry;
      session.history = [];
      session.data = {};
      session.booted = false;
      if (selectedIndustry) {
        console.log(selectedIndustry + ' 선택됨 - gemini 호출 시작');
        const geminiReply = await chat(session.history, userMessage, session.booted, session.industry);
        console.log('gemini 응답:', JSON.stringify(geminiReply));

        // 배너 URL 준비 (인사말과 함께 전송)
        const bannerUrl = `http://158.180.83.78:3000/images/banner_${selectedIndustry}.jpg`;
        // SHOW_BOOKING_TYPE 감지 - 1단계 메인 버튼 표시
        if (geminiReply.showBookingType) {
          const messageText = geminiReply.message || "어떤 도움이 필요하신가요? 😊";
          const mb = mainButtons[session.industry] || { btn3: '요금안내', btn4: null };
          const quickReplies = [
            { action: "message", label: "1️⃣ 예약하기", messageText: "예약하기" },
            { action: "message", label: "2️⃣ 상담하기", messageText: "상담하기" },
            { action: "message", label: `3️⃣ ${mb.btn3}`, messageText: mb.btn3 }
          ];
          if (mb.btn4) {
            quickReplies.push({ action: "message", label: `4️⃣ ${mb.btn4}`, messageText: mb.btn4 });
          }
          await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: "2.0",
              template: {
                outputs: [
                  { basicCard: { thumbnail: { imageUrl: bannerUrl, fixedRatio: false } } },
                  { simpleText: { text: messageText } }
                ],
                quickReplies: quickReplies
              }
            })
          });
          return;
        }

        // SHOW_STYLISTS 감지 - 스타일리스트 캐러셀 전송
        if (geminiReply.showStylists) {
          const BASE_URL = "http://158.180.83.78:3000/images";
          const stylists = [
            { name: "다은 T", desc: "모류교정 전문 | 외국인 고객 전문 | 헤드스파 전문", img: "daun.jpg", msg: "다은T 선택" },
            { name: "지수 T", desc: "컬러 전문 | 손상모 케어 전문 | 블리치 전문", img: "jisu.jpg", msg: "지수T 선택" },
            { name: "민준 T", desc: "남성 커트 전문 | 펌 전문 | 두상 맞춤 스타일", img: "minjun.jpg", msg: "민준T 선택" }
          ];
          const carouselItems = stylists.map(s => ({
            title: s.name,
            description: s.desc,
            thumbnail: { imageUrl: `${BASE_URL}/${s.img}`, link: { web: `${BASE_URL}/${s.img}` } },
            buttons: [{ action: "message", label: "선택하기", messageText: s.msg }, { action: "webLink", label: "크게 보기 🔍", webLinkUrl: `${BASE_URL}/${s.img}` }]
          }));
          const messageText = geminiReply.message || "스타일리스트를 선택해주세요!";
          await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: "2.0",
              template: {
                outputs: [
                  { simpleText: { text: messageText } },
                  { carousel: { type: "basicCard", items: carouselItems } }
                ]
              }
            })
          });
          return;
        }

        // SHOW_DOCTORS 감지 - 의사 캐러셀 전송
        if (geminiReply.showDoctors) {
          const BASE_URL = "http://158.180.83.78:3000/images";
          const doctors = [
            { name: "김연세 원장", desc: "피부과 전문의 20년 | 레이저 시술 전문", img: "doctor_1.jpg", msg: "김연세 원장 선택" },
            { name: "박푸르미 원장", desc: "피부과 전문의 15년 | 여드름/흉터 전문", img: "doctor_2.jpg", msg: "박푸르미 원장 선택" },
            { name: "이미소 원장", desc: "피부과 전문의 10년 | 안티에이징/리프팅 전문", img: "doctor_3.jpg", msg: "이미소 원장 선택" }
          ];
          const carouselItems = doctors.map(d => ({
            title: d.name,
            description: d.desc,
            thumbnail: { imageUrl: `${BASE_URL}/${d.img}`, link: { web: `${BASE_URL}/${d.img}` } },
            buttons: [{ action: "message", label: "선택하기", messageText: d.msg }, { action: "webLink", label: "크게 보기 🔍", webLinkUrl: `${BASE_URL}/${d.img}` }]
          }));
          const messageText = geminiReply.message || "담당 원장님을 선택해주세요!";
          await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: "2.0",
              template: {
                outputs: [
                  { simpleText: { text: messageText } },
                  { carousel: { type: "basicCard", items: carouselItems } }
                ]
              }
            })
          });
          return;
        }

        // SHOW_PRICE 감지 - 가격표 이미지 전송
        if (geminiReply.showPrice) {
          const priceUrl = `http://158.180.83.78:3000/images/price_${session.industry}.jpg`;
          const messageText = geminiReply.message || "가격표를 확인해주세요!";
          await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: "2.0",
              template: {
                outputs: [
                  { simpleText: { text: messageText } },
                  { basicCard: {
                    thumbnail: { imageUrl: priceUrl, fixedRatio: false },
                    buttons: [{ action: "webLink", label: "크게 보기 🔍", webLinkUrl: priceUrl }]
                  }}
                ]
              }
            })
          });
          return;
        }

        // RESET 감지
        if (geminiReply.reset) {
          sessions[kakaoUserId] = { history: [], data: {}, booted: false };
          const resetResponse = {
            version: "2.0",
            template: { outputs: [{ simpleText: { text: "처음 화면으로 돌아갑니다 😊\n아래에서 업종을 선택해주세요!" } }] }
          };
          await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(resetResponse)
          });
          return;
        }

        // SHOW_BOOKING_TYPE 감지 - 1단계 메인 버튼 표시
        if (geminiReply.showBookingType) {
          const messageText = geminiReply.message || "어떤 도움이 필요하신가요? 😊";
          const mb = mainButtons[session.industry] || { btn3: '요금안내', btn4: null };
          const quickReplies = [
            { action: "message", label: "1️⃣ 예약하기", messageText: "예약하기" },
            { action: "message", label: "2️⃣ 상담하기", messageText: "상담하기" },
            { action: "message", label: `3️⃣ ${mb.btn3}`, messageText: mb.btn3 }
          ];
          if (mb.btn4) {
            quickReplies.push({ action: "message", label: `4️⃣ ${mb.btn4}`, messageText: mb.btn4 });
          }
          await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: "2.0",
              template: {
                outputs: [
                  { basicCard: { thumbnail: { imageUrl: bannerUrl, fixedRatio: false } } },
                  { simpleText: { text: messageText } }
                ],
                quickReplies: quickReplies
              }
            })
          });
          return;
        }

        // SHOW_STYLISTS 감지 - 스타일리스트 캐러셀 전송
        if (geminiReply.showStylists) {
          const BASE_URL = "http://158.180.83.78:3000/images";
          const stylists = [
            { name: "다은 T", desc: "모류교정 전문 | 외국인 고객 전문 | 헤드스파 전문", img: "daun.jpg", msg: "다은T 선택" },
            { name: "지수 T", desc: "컬러 전문 | 손상모 케어 전문 | 블리치 전문", img: "jisu.jpg", msg: "지수T 선택" },
            { name: "민준 T", desc: "남성 커트 전문 | 펌 전문 | 두상 맞춤 스타일", img: "minjun.jpg", msg: "민준T 선택" }
          ];
          const carouselItems = stylists.map(s => ({
            title: s.name,
            description: s.desc,
            thumbnail: { imageUrl: `${BASE_URL}/${s.img}`, link: { web: `${BASE_URL}/${s.img}` } },
            buttons: [{ action: "message", label: "선택하기", messageText: s.msg }, { action: "webLink", label: "크게 보기 🔍", webLinkUrl: `${BASE_URL}/${s.img}` }]
          }));
          const messageText = geminiReply.message || "스타일리스트를 선택해주세요!";
          await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: "2.0",
              template: {
                outputs: [
                  { simpleText: { text: messageText } },
                  { carousel: { type: "basicCard", items: carouselItems } }
                ]
              }
            })
          });
          return;
        }

        // SHOW_DOCTORS 감지 - 의사 캐러셀 전송
        if (geminiReply.showDoctors) {
          const BASE_URL = "http://158.180.83.78:3000/images";
          const doctors = [
            { name: "김연세 원장", desc: "피부과 전문의 20년 | 레이저 시술 전문", img: "doctor_1.jpg", msg: "김연세 원장 선택" },
            { name: "박푸르미 원장", desc: "피부과 전문의 15년 | 여드름/흉터 전문", img: "doctor_2.jpg", msg: "박푸르미 원장 선택" },
            { name: "이미소 원장", desc: "피부과 전문의 10년 | 안티에이징/리프팅 전문", img: "doctor_3.jpg", msg: "이미소 원장 선택" }
          ];
          const carouselItems = doctors.map(d => ({
            title: d.name,
            description: d.desc,
            thumbnail: { imageUrl: `${BASE_URL}/${d.img}`, link: { web: `${BASE_URL}/${d.img}` } },
            buttons: [{ action: "message", label: "선택하기", messageText: d.msg }, { action: "webLink", label: "크게 보기 🔍", webLinkUrl: `${BASE_URL}/${d.img}` }]
          }));
          const messageText = geminiReply.message || "담당 원장님을 선택해주세요!";
          await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: "2.0",
              template: {
                outputs: [
                  { simpleText: { text: messageText } },
                  { carousel: { type: "basicCard", items: carouselItems } }
                ]
              }
            })
          });
          return;
        }

        // SHOW_PRICE 감지 - 가격표 이미지 전송
        if (geminiReply.showPrice) {
          const priceUrl = `http://158.180.83.78:3000/images/price_${session.industry}.jpg`;
          const messageText = geminiReply.message || "가격표를 확인해주세요!";
          await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: "2.0",
              template: {
                outputs: [
                  { simpleText: { text: messageText } },
                  { basicCard: {
                    thumbnail: { imageUrl: priceUrl, fixedRatio: false },
                    buttons: [{ action: "webLink", label: "크게 보기 🔍", webLinkUrl: priceUrl }]
                  }}
                ]
              }
            })
          });
          return;
        }

        // RESET 감지
        if (geminiReply.reset) {
          sessions[kakaoUserId] = { history: [], data: {}, booted: false };
          const resetResponse = {
            version: "2.0",
            template: { outputs: [{ simpleText: { text: "처음 화면으로 돌아갑니다 😊\n아래에서 업종을 선택해주세요!" } }] }
          };
          await fetch(callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(resetResponse)
          });
          return;
        }

        const messageText = geminiReply.message || '어떤 서비스를 원하시나요? 😊';
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: "2.0",
            template: {
              outputs: [
                { basicCard: { thumbnail: { imageUrl: bannerUrl, fixedRatio: false } } },
                { simpleText: { text: messageText } }
              ]
            }
          })
        });
        return;
      }
      // 카테고리 선택 시 세부 업종 버튼 표시
      const SUB_INDUSTRIES = {
        'medical': ['병원', '동물병원', '피부관리'],
        'restaurant': ['식당'],
        'beauty': ['미용실', '네일샵', '마사지', '왁싱'],
        'accommodation': ['숙박', '템플스테이', '펜션/캠핑'],
        'transport': ['공항택시', '렌트카', '이사'],
        'leisure': ['골프', '액티비티', '요가/필라테스', '수영장/볼링', '노래방', '키즈카페'],
        'space': ['파티룸', '스터디카페', '공간대여', '사진스튜디오', '세차장'],
        'pet': ['반려동물 미용/호텔']
      };
      const subs = SUB_INDUSTRIES[selectedIndustry] || [];
      const buttons = subs.map(s => ({ action: "message", label: s, messageText: `업종_${s}` }));
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: {
            outputs: [{ simpleText: { text: "세부 업종을 선택해주세요! 😊" } }],
            quickReplies: buttons
          }
        })
      });
      return;
    }

    // 업종 미선택 시 20개 캐러셀
    if (!session.industry) {
      const BASE_URL = "http://158.180.83.78:3000/images";
      const row1 = [
        { title: "🏥 병원동행", desc: "접수부터 수납까지 보호자처럼", img: "industry_hospital_companion.jpg", msg: "병원동행" },
        { title: "🏨 병원", desc: "병원 예약 도우미", img: "industry_hospital.jpg", msg: "병원" },
        { title: "🍽️ 식당", desc: "맛집 예약 서비스", img: "industry_restaurant.jpg", msg: "식당" },
        { title: "💇 미용실", desc: "헤어 예약 서비스", img: "industry_beauty.jpg", msg: "미용실" },
        { title: "🏩 숙박", desc: "숙박 예약 서비스", img: "industry_accommodation.jpg", msg: "숙박" },
        { title: "💆 마사지", desc: "마사지 예약 서비스", img: "industry_massage.jpg", msg: "마사지" },
        { title: "✈️ 공항택시", desc: "공항 이동 서비스", img: "industry_airport_taxi.jpg", msg: "공항택시" },
        { title: "🐾 동물병원", desc: "반려동물 진료 예약", img: "industry_vet.jpg", msg: "동물병원" },
        { title: "🛕 템플스테이", desc: "템플스테이 예약", img: "industry_templestay.jpg", msg: "템플스테이" },
        { title: "✨ 피부관리", desc: "피부관리 예약 서비스", img: "industry_skincare.jpg", msg: "피부관리" }
      ];
      const row2 = [
        { title: "⛳ 골프", desc: "골프장 예약 서비스", img: "industry_golf.jpg", msg: "골프" },
        { title: "🚗 렌트카", desc: "렌트카 예약 서비스", img: "industry_rentcar.jpg", msg: "렌트카" },
        { title: "🪂 액티비티", desc: "레저 액티비티 예약", img: "industry_activity.jpg", msg: "액티비티" },
        { title: "🏋️ 체육시설", desc: "체육시설 예약", img: "industry_sports.jpg", msg: "체육시설" },
        { title: "🎉 파티룸", desc: "파티룸 예약 서비스", img: "industry_partyroom.jpg", msg: "파티룸" },
        { title: "💅 네일/뷰티", desc: "네일 예약 서비스", img: "industry_nail.jpg", msg: "네일샵" },
        { title: "📸 사진스튜디오", desc: "스튜디오 예약", img: "industry_studio.jpg", msg: "사진스튜디오" },
        { title: "📚 스터디카페", desc: "스터디카페 예약", img: "industry_study.jpg", msg: "스터디카페" },
        { title: "🧘 요가/필라테스", desc: "요가 예약 서비스", img: "industry_yoga.jpg", msg: "요가" },
        { title: "🏊 수영장/볼링", desc: "레저 시설 예약", img: "industry_leisure.jpg", msg: "수영장" }
      ];
      const makeItems = arr => arr.map(item => ({
        title: item.title,
        description: item.desc,
        thumbnail: { imageUrl: `${BASE_URL}/${item.img}`, link: { web: `${BASE_URL}/${item.img}` } },
        buttons: [{ action: "message", label: "선택하기", messageText: item.msg }]
      }));
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: {
            outputs: [
              { simpleText: { text: "안녕하세요! 😊\n어떤 서비스를 이용하시겠어요?\n아래에서 업종을 선택해주세요!" } },
              { carousel: { type: "basicCard", items: makeItems(row1) } },
              { carousel: { type: "basicCard", items: makeItems(row2) } }
            ]
          }
        })
      });
      return;
    }

        // "매니저등록" 키워드 감지
    if (userMessage.trim() === "매니저등록") {
      session.step = "manager_registration";
      session.managerStep = 0;
      session.managerData = {};
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTextResponse(
          "매니저 등록을 시작합니다! 👋\n\n" + MANAGER_STEPS[0].question
        ))
      });
      return;
    }

    // Gemini 처리 시작 로그
    console.log("processAndCallback 시작:", kakaoUserId, userMessage);

    // 매니저 여부 확인
    const managerInfo = await isManager(kakaoUserId);
    if (managerInfo) {
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTextResponse(
          `안녕하세요 ${managerInfo.name} 매니저님! 👋\n\n현재 배정된 예약을 확인하려면 "내 예약"이라고 입력해주세요.`
        ))
      });
      return;
    }

    // 고객 예약 흐름
    // 내 예약 조회 요청 감지
    const isMyBookingRequest = /내.*예약|예약.*내역|예약.*확인|예약.*조회|예약.*보여|내가.*예약|나.*예약/.test(userMessage);
    if (isMyBookingRequest) {
      const db = require('../services/db');
      const userKey = kakaoUserId;
      const [rows] = await db.query(
        'SELECT * FROM bookings WHERE kakao_user_id = ? ORDER BY created_at DESC LIMIT 5',
        [userKey]
      );
      let replyMsg = '';
      if (rows.length === 0) {
        replyMsg = '아직 예약 내역이 없습니다 😊\n새로운 예약을 원하시면 환자분 성함과 나이를 알려주세요!';
      } else {
        replyMsg = '📋 예약 내역입니다!\n\n';
        rows.forEach((b, i) => {
          const status = b.status === 'confirmed' ? '✅ 확정' : b.status === 'pending' ? '⏳ 대기중' : b.status === 'cancelled' ? '❌ 취소' : b.status;
          replyMsg += (i+1) + '. ' + b.date + ' ' + b.time + '\n' +
            '   환자: ' + b.patient_name + ' (' + b.age + '세)\n' +
            '   병원: ' + b.hospital + ' (' + b.region + ')\n' +
            '   서비스: ' + (b.service_type == 1 ? '기사동행 포함' : '기사동행 미포함') + '\n' +
            '   상태: ' + status + '\n\n';
        });
      }
      if (callbackUrl) {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } })
        });
      } else {
        return res.json({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } });
      }
      return;
    }

    const { message, bookingData, showDriverButtons, humanAgentRequest, showPrice } = await chat(session.history, userMessage, session.booted, session.industry);
    session.data = mergeData(session.data, bookingData);
    session.history.push({ role: "user", content: userMessage });
    session.history.push({ role: "model", content: message });
    if (session.history.length > 20) session.history = session.history.slice(-20);

    // SHOW_PRICE 감지 - 가격표 이미지 전송
    if (showPrice && session.industry) {
      const priceUrl = `http://158.180.83.78:3000/images/price_${session.industry}.jpg`;
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "2.0",
          template: {
            outputs: [
              { simpleText: { text: message } },
              { basicCard: {
                thumbnail: { imageUrl: priceUrl, fixedRatio: false },
                buttons: [{ action: "webLink", label: "크게 보기 🔍", webLinkUrl: priceUrl }]
              }}
            ]
          }
        })
      });
      return;
    }

    if (!session.booked && isComplete(session.data)) {
      const confirmResponse = await finalizeBooking(session, kakaoUserId);
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirmResponse)
      });
    } else {
      // 기사동행 여부 질문일 때 퀵리플라이 버튼 추가
      // 상담원 연결 요청 감지
      if (humanAgentRequest) {
        const telegramMsg = `🚨 상담원 연결 요청!\n\n👤 고객 발화: "${userMessage}"\n\n💬 최근 대화:\n${session.history.slice(-4).map(h => `  ${h.role === 'user' ? '고객' : '봇'}: ${h.parts && h.parts[0] ? h.parts[0].text : ''}`).join('\n')}\n\n👉 center-pf.kakao.com 에서 채팅 확인하세요`;
        const adminIds = process.env.TELEGRAM_ADMIN_CHAT_ID ? process.env.TELEGRAM_ADMIN_CHAT_ID.split(',') : [];
        for (const adminId of adminIds) {
          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: adminId.trim(), text: telegramMsg })
          });
        }
      }
      // 모든 응답에 예약/상담 버튼 자동 추가
      const mb = mainButtons[session.industry] || { btn3: '요금안내', btn4: null };
      const defaultQuickReplies = [
        { action: "message", label: "1️⃣ 예약하기", messageText: "예약하기" },
        { action: "message", label: "2️⃣ 상담하기", messageText: "상담하기" },
        { action: "message", label: "🏠 처음으로", messageText: "처음으로" }
      ];

      let response;
      if (showDriverButtons) {
        response = {
          version: "2.0",
          template: {
            outputs: [{ simpleText: { text: message } }],
            quickReplies: [
              { label: "🚗 기사 포함", action: "message", messageText: "기사 포함" },
              { label: "🚶 기사 미포함", action: "message", messageText: "기사 미포함" }
            ]
          }
        };
      } else {
        // 대화 중엔 버튼 없이 텍스트로만 자연스럽게 이어가기
        response = {
          version: "2.0",
          template: {
            outputs: [{ simpleText: { text: message } }]
          }
        };
      }
      
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response)
      });
    }

  } catch (err) {
    console.error("처리 오류:", err);
    try {
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTextResponse("일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요."))
      });
    } catch (e) {
      console.error("콜백 전송 실패:", e);
    }
  }
}

router.post("/", async (req, res) => {
  try {
    const body = req.body;
    const userRequest = body.userRequest;
    const kakaoUserId = userRequest.user.id;
    const userMessage = userRequest.utterance.trim();
    const callbackUrl = userRequest.callbackUrl;
    console.log("callbackUrl:", callbackUrl, "userMessage:", userMessage);

    if (!callbackUrl) {
      if (!sessions[kakaoUserId]) {
        sessions[kakaoUserId] = { history: [], data: {}, booked: false };
        // 첫 진입 시 캐러셀 카드 보여주기
        return res.json({
          version: "2.0",
          template: {
            outputs: [
              {
                simpleText: {
                  text: "안녕하세요! 돈워리 병원동행 서비스입니다 😊\n접수부터 수납까지 보호자처럼 함께해드립니다."
                }
              },
              {
                carousel: {
                  type: "basicCard",
                  items: [
                    {
                      title: "📅 예약하기",
                      description: "병원동행 예약을 도와드립니다",
                      buttons: [{ action: "message", label: "예약 시작", messageText: "예약하고 싶어요" }]
                    },
                    {
                      title: "💬 문의하기",
                      description: "서비스 관련 궁금한 점을 물어보세요",
                      buttons: [{ action: "message", label: "문의하기", messageText: "문의가 있어요" }]
                    },
                    {
                      title: "💰 요금안내",
                      description: "서비스 요금을 확인해보세요",
                      buttons: [{ action: "message", label: "요금 확인", messageText: "요금이 어떻게 되나요?" }]
                    },
                    {
                      title: "👩‍💼 직원연결",
                      description: "상담원과 직접 연결해드립니다",
                      buttons: [{ action: "message", label: "직원 연결", messageText: "직원 연결해주세요" }]
                    }
                  ]
                }
              }
            ]
          }
        });
      }
      const session = sessions[kakaoUserId];

      if (session.step === "manager_registration") {
        const response = await handleManagerRegistration(session, kakaoUserId, userMessage);
        return res.json(response);
      }

      if (userMessage.trim() === "매니저등록") {
        session.step = "manager_registration";
        session.managerStep = 0;
        session.managerData = {};
        return res.json(makeTextResponse("매니저 등록을 시작합니다! 👋\n\n" + MANAGER_STEPS[0].question));
      }

      // 내 예약 조회 요청 감지
    const isMyBookingRequest = /내.*예약|예약.*내역|예약.*확인|예약.*조회|예약.*보여|내가.*예약|나.*예약/.test(userMessage);
    if (isMyBookingRequest) {
      const db = require('../services/db');
      const userKey = kakaoUserId;
      const [rows] = await db.query(
        'SELECT * FROM bookings WHERE kakao_user_id = ? ORDER BY created_at DESC LIMIT 5',
        [userKey]
      );
      let replyMsg = '';
      if (rows.length === 0) {
        replyMsg = '아직 예약 내역이 없습니다 😊\n새로운 예약을 원하시면 환자분 성함과 나이를 알려주세요!';
      } else {
        replyMsg = '📋 예약 내역입니다!\n\n';
        rows.forEach((b, i) => {
          const status = b.status === 'confirmed' ? '✅ 확정' : b.status === 'pending' ? '⏳ 대기중' : b.status === 'cancelled' ? '❌ 취소' : b.status;
          replyMsg += (i+1) + '. ' + b.date + ' ' + b.time + '\n' +
            '   환자: ' + b.patient_name + ' (' + b.age + '세)\n' +
            '   병원: ' + b.hospital + ' (' + b.region + ')\n' +
            '   서비스: ' + (b.service_type == 1 ? '기사동행 포함' : '기사동행 미포함') + '\n' +
            '   상태: ' + status + '\n\n';
        });
      }
      if (callbackUrl) {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } })
        });
      } else {
        return res.json({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } });
      }
      return;
    }

    const { message, bookingData, showDriverButtons, humanAgentRequest } = await chat(session.history, userMessage, session.booted, session.industry);
      session.data = mergeData(session.data, bookingData);
      session.history.push({ role: "user", content: userMessage });
      session.history.push({ role: "model", content: message });

      if (!session.booked && isComplete(session.data)) {
        const confirmResponse = await finalizeBooking(session, kakaoUserId);
        return res.json(confirmResponse);
      }
      return res.json(makeTextResponse(message));
    }

    if (callbackUrl) {
      res.json({
        version: "2.0",
        useCallback: true,
        template: {
          outputs: [{ simpleText: { text: "잠시만요 🔍" } }]
        }
      });
      console.log("processAndCallback 호출 직전");
      processAndCallback(kakaoUserId, userMessage, callbackUrl).catch(e => console.error("processAndCallback 오류:", e.message));
    } else {
      // callbackUrl 없을 때 직접 처리
      if (!sessions[kakaoUserId]) {
        sessions[kakaoUserId] = { history: [], data: {}, booked: false };
      }
      const session = sessions[kakaoUserId];
      // 내 예약 조회 요청 감지
    const isMyBookingRequest = /내.*예약|예약.*내역|예약.*확인|예약.*조회|예약.*보여|내가.*예약|나.*예약/.test(userMessage);
    if (isMyBookingRequest) {
      const db = require('../services/db');
      const userKey = kakaoUserId;
      const [rows] = await db.query(
        'SELECT * FROM bookings WHERE kakao_user_id = ? ORDER BY created_at DESC LIMIT 5',
        [userKey]
      );
      let replyMsg = '';
      if (rows.length === 0) {
        replyMsg = '아직 예약 내역이 없습니다 😊\n새로운 예약을 원하시면 환자분 성함과 나이를 알려주세요!';
      } else {
        replyMsg = '📋 예약 내역입니다!\n\n';
        rows.forEach((b, i) => {
          const status = b.status === 'confirmed' ? '✅ 확정' : b.status === 'pending' ? '⏳ 대기중' : b.status === 'cancelled' ? '❌ 취소' : b.status;
          replyMsg += (i+1) + '. ' + b.date + ' ' + b.time + '\n' +
            '   환자: ' + b.patient_name + ' (' + b.age + '세)\n' +
            '   병원: ' + b.hospital + ' (' + b.region + ')\n' +
            '   서비스: ' + (b.service_type == 1 ? '기사동행 포함' : '기사동행 미포함') + '\n' +
            '   상태: ' + status + '\n\n';
        });
      }
      if (callbackUrl) {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } })
        });
      } else {
        return res.json({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } });
      }
      return;
    }

    const { message, bookingData, showDriverButtons, humanAgentRequest } = await chat(session.history, userMessage, session.booted, session.industry);
      session.data = mergeData(session.data, bookingData);
      session.history.push({ role: "user", content: userMessage });
      session.history.push({ role: "model", content: message });
      if (!session.booked && isComplete(session.data)) {
        const confirmResponse = await finalizeBooking(session, kakaoUserId);
        return res.json(confirmResponse);
      }
      return res.json(makeTextResponse(message));
    }

  } catch (err) {
    console.error("Webhook 오류:", err);
    return res.json(makeTextResponse("일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요."));
  }
});

// 캘린더 날짜 선택 콜백
router.get('/calendar-select', async (req, res) => {
  const { date, userId } = req.query;
  console.log('calendar-select 호출 - date:', date, 'userId:', userId ? userId.substring(0,10)+'...' : '없음');
  if (date && userId) {
    if (!sessions[userId]) sessions[userId] = { history: [], data: {}, booted: false };
    sessions[userId].pendingDate = date;
    console.log('pendingDate 저장 완료:', date);
  } else {
    console.log('❌ date 또는 userId 없음');
  }
  res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>선택 완료</title>
<style>
  body { font-family: 'Apple SD Gothic Neo', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #f5f5f5; }
  .box { background: white; border-radius: 16px; padding: 30px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.1); width: 300px; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h2 { font-size: 18px; color: #333; margin-bottom: 8px; }
  p { font-size: 14px; color: #666; margin-bottom: 24px; }
  .date { font-size: 16px; font-weight: bold; color: #4a90e2; margin-bottom: 24px; }
  .btn { display: block; width: 100%; padding: 14px; background: #FEE500; color: #333; border: none; border-radius: 10px; font-size: 16px; font-weight: bold; cursor: pointer; text-decoration: none; }
</style>
</head>
<body>
<div class="box">
  <div class="icon">✅</div>
  <h2>날짜/시간 선택 완료!</h2>
  <div class="date">${date}</div>
  <p>카카오톡으로 돌아가서<br>예약을 계속 진행해주세요</p>
  <div style="background:#f0f7ff;border-radius:10px;padding:12px;margin-bottom:20px;font-size:16px;font-weight:bold;color:#4a90e2;">${date}</div>
  <p style="font-size:14px;color:#555;line-height:1.6;">이 창을 닫고<br>카카오톡 채팅창에서<br><b>✅ 선택한 날짜 확인하기</b><br>버튼을 눌러주세요!</p>
</div>
</body>
</html>`);
});

module.exports = router;
