const pool = require("./db");

function getKoreanDay(date) {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return days[new Date(date).getDay()];
}

function getTimeSlot(time) {
  const hour = parseInt(time.split(":")[0]);
  if (hour >= 6 && hour < 12) return "오전";
  if (hour >= 12 && hour < 18) return "오후";
  return "저녁";
}

async function findAvailableManager(region, serviceType, date = null, time = null) {
  const [managers] = await pool.query(
    "SELECT * FROM managers WHERE status = 'online' ORDER BY created_at ASC"
  );

  const filtered = managers.filter((manager) => {
    // 지역 매칭
    let filterRegions = [];
    try {
      filterRegions = typeof manager.filter_regions === "string"
        ? JSON.parse(manager.filter_regions)
        : manager.filter_regions || [];
    } catch { filterRegions = []; }
    const regionMatch = filterRegions.length === 0 || filterRegions.includes(region);

    // 서비스 타입 매칭
    const serviceMatch = manager.service_type === 0 || manager.service_type === parseInt(serviceType);

    // 요일 매칭
    let dayMatch = true;
    if (date && manager.available_days) {
      try {
        const availableDays = typeof manager.available_days === "string"
          ? JSON.parse(manager.available_days)
          : manager.available_days || [];
        const bookingDay = getKoreanDay(date);
        dayMatch = availableDays.length === 0 || availableDays.includes(bookingDay);
      } catch { dayMatch = true; }
    }

    // 시간대 매칭
    let timeMatch = true;
    if (time && manager.available_times) {
      try {
        const availableTimes = typeof manager.available_times === "string"
          ? JSON.parse(manager.available_times)
          : manager.available_times || [];
        const bookingTimeSlot = getTimeSlot(time);
        timeMatch = availableTimes.length === 0 || availableTimes.includes(bookingTimeSlot);
      } catch { timeMatch = true; }
    }

    return regionMatch && serviceMatch && dayMatch && timeMatch;
  });

  if (filtered.length === 0) return null;

  const managerWithLoad = await Promise.all(
    filtered.map(async (manager) => {
      const [rows] = await pool.query(
        "SELECT COUNT(*) as count FROM bookings WHERE manager_id = ? AND status = 'assigned'",
        [manager.id]
      );
      return { ...manager, activeBookings: rows[0].count };
    })
  );

  managerWithLoad.sort((a, b) => a.activeBookings - b.activeBookings);
  return managerWithLoad[0];
}

module.exports = { findAvailableManager };
