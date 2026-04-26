import { Router } from 'express';
import { authRequired } from '../auth.js';
import { adminRequired } from '../admin.js';
import {
  listCodes, createCode, revokeCode,
} from '../invites.js';

const router = Router();

// Все эндпоинты требуют admin-прав. Не админу — 403.
router.use(authRequired, adminRequired);

router.get('/', (_req, res) => {
  res.json({ codes: listCodes() });
});

router.post('/', (req, res) => {
  const { note, maxUses, expiresAt, code } = req.body || {};
  try {
    const created = createCode({
      createdBy: req.user.id,
      note,
      maxUses,
      expiresAt,
      code,
    });
    res.json({ code: created });
  } catch (e) {
    if (String(e?.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'code already exists' });
    }
    throw e;
  }
});

router.delete('/:code', (req, res) => {
  const ok = revokeCode(req.params.code);
  if (!ok) return res.status(404).json({ error: 'not found or already revoked' });
  res.json({ ok: true });
});

export default router;
