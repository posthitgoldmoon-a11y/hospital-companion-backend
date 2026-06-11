const mysql = require("mysql2/promise");
require("dotenv").config();

async function createTables() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      kakao_user_id VARCHAR(255) UNIQUE,
      name VARCHAR(100),
      phone VARCHAR(20),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("customers 테이블 생성 완료");

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS managers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      region VARCHAR(50),
      filter_regions TEXT,
      status ENUM('online', 'offline') DEFAULT 'offline',
      service_type TINYINT DEFAULT 0,
      hourly_rate INT DEFAULT 16000,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("managers 테이블 생성 완료");

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT,
      manager_id INT,
      patient_name VARCHAR(100),
      age INT,
      hospital VARCHAR(200),
      region VARCHAR(50),
      date DATE,
      time TIME,
      duration INT DEFAULT 2,
      service_type TINYINT,
      status ENUM('pending', 'assigned', 'completed', 'cancelled') DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (manager_id) REFERENCES managers(id)
    )
  `);
  console.log("bookings 테이블 생성 완료");

  await conn.end();
  console.log("완료");
}

createTables().catch(console.error);
