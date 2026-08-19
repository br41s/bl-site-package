import { Router } from "express";
import { getConfig, setConfig } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { runLiderpapelSync } from "../sync/liderpapel/sync.js";

const router = Router();

// GET /api/sync/liderpapel/status
router.get("/liderpapel/status", requireAuth, (req, res) => {
  res.json({
    host: process.env.LIDERPAPEL_SFTP_HOST || getConfig("liderpapel_sftp_host"),
    port: process.env.LIDERPAPEL_SFTP_PORT || getConfig("liderpapel_sftp_port"),
    user: process.env.LIDERPAPEL_SFTP_USER || getConfig("liderpapel_sftp_user"),
    supplierCode:
      process.env.LIDERPAPEL_SUPPLIER_CODE || getConfig("liderpapel_supplier_code"),
    hasPassword: Boolean(process.env.LIDERPAPEL_SFTP_PASS || getConfig("liderpapel_sftp_pass")),
    lastSyncStatus: getConfig("liderpapel_last_sync_status"),
    lastSyncAt: getConfig("liderpapel_last_sync_at"),
    lastSyncCount: getConfig("liderpapel_last_sync_count"),
    lastSyncMessage: getConfig("liderpapel_last_sync_message"),
  });
});

// POST /api/sync/liderpapel/config — save sFTP connection settings
router.post("/liderpapel/config", requireAuth, (req, res) => {
  const allowed = [
    "liderpapel_sftp_host",
    "liderpapel_sftp_port",
    "liderpapel_sftp_user",
    "liderpapel_sftp_pass",
    "liderpapel_supplier_code",
    "liderpapel_sync_schedule",
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) setConfig(key, req.body[key]);
  }
  res.json({ success: true });
});

// POST /api/sync/liderpapel/run — manual trigger
router.post("/liderpapel/run", requireAuth, async (req, res) => {
  try {
    const result = await runLiderpapelSync();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
