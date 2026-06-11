const pool = require("./db");

async function findAvailableManager(region, serviceType) {
  const [managers] = await pool.query(
    "SELECT * FROM managers WHERE status = 'online' ORDER BY created_at ASC"
  );

  const filtered = managers.filter((manager) => {
    let filterRegions = [];
    try {
      filterRegions = typeof manager.filter_regions === "string"
        ? JSON.parse(manager.filter_regions)
        : manager.filter_regions || [];
    } catch {
      filterRegions = [];
    }

    const regionMatch = filterRegions.length === 0 || filterRegions.includes(region);
    const serviceMatch = manager.service_type === 0 || manager.service_type === parseInt(serviceType);
    return regionMatch && serviceMatch;
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
