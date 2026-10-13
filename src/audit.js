import { prisma } from './db.js';

// Fire-and-forget audit trail. Never blocks or fails the user's request.
export function audit(req, action, { restaurantId, actorUserId, actorEmail, entityType, entityId, detail } = {}) {
  prisma.auditLog
    .create({
      data: {
        restaurantId: restaurantId ?? req.user?.restaurantId ?? null,
        actorUserId: actorUserId ?? req.user?.id ?? null,
        actorEmail: actorEmail ?? req.user?.email ?? null,
        action,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
        detail: detail ?? undefined,
        ip: req.ip ?? null
      }
    })
    .catch((err) => console.error('audit write failed:', err.message));
}
