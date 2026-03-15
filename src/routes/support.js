import { Router } from 'express';

import prisma from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.post('/', requireAuth, async (req, res) => {
  const { subject, message } = req.body || {};
  if (!subject || subject.toString().trim().length < 3) {
    return res.status(400).json({ error: 'Subject is too short.' });
  }
  if (!message || message.toString().trim().length < 3) {
    return res.status(400).json({ error: 'Message is too short.' });
  }

  const row = await prisma.supportTicket.create({
    data: {
      userId: req.user.id,
      subject: subject.toString().trim(),
      message: message.toString().trim(),
      status: 'open',
      messages: {
        create: {
          userId: req.user.id,
          message: message.toString().trim(),
        },
      },
    },
    include: {
      messages: {
        include: {
          user: { select: { id: true, email: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  return res.status(201).json(row);
});

router.get('/me', requireAuth, async (req, res) => {
  const rows = await prisma.supportTicket.findMany({
    where: { userId: req.user.id },
    include: {
      messages: {
        include: {
          user: { select: { id: true, email: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ data: rows });
});

router.get('/', requireAuth, requireRole('admin'), async (_req, res) => {
  const rows = await prisma.supportTicket.findMany({
    include: {
      user: true,
      messages: {
        include: {
          user: { select: { id: true, email: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ data: rows });
});

router.patch('/:id/reply', requireAuth, requireRole('admin'), async (req, res) => {
  const { reply } = req.body || {};
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid ticket id.' });
  }
  if (!reply || reply.toString().trim().length < 3) {
    return res.status(400).json({ error: 'Reply is too short.' });
  }

  const existing = await prisma.supportTicket.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'Ticket not found.' });
  }
  if (existing.status === 'closed') {
    return res.status(400).json({ error: 'Ticket is already closed.' });
  }

  const row = await prisma.supportTicket.update({
    where: { id },
    data: {
      adminReply: reply.toString().trim(),
      repliedAt: new Date(),
      status: 'answered',
      messages: {
        create: {
          userId: req.user.id,
          message: reply.toString().trim(),
        },
      },
    },
    include: {
      messages: {
        include: {
          user: { select: { id: true, email: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  return res.json(row);
});

router.post('/:id/messages', requireAuth, async (req, res) => {
  const { message } = req.body || {};
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid ticket id.' });
  }
  if (!message || message.toString().trim().length < 3) {
    return res.status(400).json({ error: 'Message is too short.' });
  }

  const existing = await prisma.supportTicket.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'Ticket not found.' });
  }
  if (existing.status === 'closed') {
    return res.status(400).json({ error: 'Ticket is already closed.' });
  }
  if (req.user.role !== 'admin' && existing.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await prisma.supportTicketMessage.create({
    data: {
      ticketId: id,
      userId: req.user.id,
      message: message.toString().trim(),
    },
  });

  const nextStatus = req.user.role === 'admin' ? 'answered' : 'open';
  const row = await prisma.supportTicket.update({
    where: { id },
    data: {
      status: nextStatus,
      adminReply: req.user.role === 'admin' ? message.toString().trim() : existing.adminReply,
      repliedAt: req.user.role === 'admin' ? new Date() : existing.repliedAt,
    },
    include: {
      user: true,
      messages: {
        include: {
          user: { select: { id: true, email: true, role: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  return res.json(row);
});

router.patch('/:id/close', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid ticket id.' });
  }

  const existing = await prisma.supportTicket.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'Ticket not found.' });
  }

  if (req.user.role !== 'admin' && existing.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const row = await prisma.supportTicket.update({
    where: { id },
    data: { status: 'closed', closedAt: new Date() },
  });
  return res.json(row);
});

export default router;
