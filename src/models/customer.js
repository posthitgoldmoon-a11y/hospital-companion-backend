const pool = require("../services/db");

async function findOrCreateCustomer(kakaoUserId) {
  const [rows] = await pool.query(
    "SELECT * FROM customers WHERE kakao_user_id = ?",
    [kakaoUserId]
  );
  if (rows.length > 0) return rows[0];

  const [result] = await pool.query(
    "INSERT INTO customers (kakao_user_id) VALUES (?)",
    [kakaoUserId]
  );
  return { id: result.insertId, kakao_user_id: kakaoUserId };
}

module.exports = { findOrCreateCustomer };
