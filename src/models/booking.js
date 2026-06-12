const pool = require("../services/db");

async function createBooking(data) {
  const { customer_id, patient_name, age, hospital, date, time, service_type, region, duration = 2, kakao_user_id = null } = data;
  const [result] = await pool.query(
    "INSERT INTO bookings (customer_id, patient_name, age, hospital, date, time, service_type, region, duration, status, kakao_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
    [customer_id, patient_name, age, hospital, date, time, service_type, region, duration, kakao_user_id]
  );
  return { id: result.insertId, ...data, status: "pending" };
}

async function assignManager(bookingId, managerId) {
  await pool.query(
    "UPDATE bookings SET manager_id = ?, status = 'assigned' WHERE id = ?",
    [managerId, bookingId]
  );
}

async function getBookingById(bookingId) {
  const [rows] = await pool.query("SELECT * FROM bookings WHERE id = ?", [bookingId]);
  return rows[0] || null;
}

async function updateBookingStatus(bookingId, status) {
  await pool.query("UPDATE bookings SET status = ? WHERE id = ?", [status, bookingId]);
}

module.exports = { createBooking, assignManager, getBookingById, updateBookingStatus };
