import type { PrinterQueueStatus, PrintJobSummary, PrintQueueResponse } from '@sistema-bar/shared';
import { and, asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { printers, printJobs } from '../db/schema';
import { audit } from '../lib/audit';
import { HttpError, notFound } from '../lib/errors';
import { describeTicket } from '../printing/layouts';
import type { TicketPayload } from '../printing/tickets';
import { renderJob } from '../printing/worker';
import { idParams } from './admin/params';

/** Fila de impressão: acompanhar, reimprimir e destravar (SPEC 5.5). Caixa, gerente e admin. */
export async function printRoutes(app: FastifyInstance, { db, guards, printWorker }: AppDeps) {
  app.addHook('preHandler', guards.requireRole('CAIXA', 'GERENTE'));

  app.get('/queue', async (request): Promise<PrintQueueResponse> => {
    const { status } = z
      .object({ status: z.enum(['PENDENTE', 'IMPRIMINDO', 'OK', 'ERRO', 'ABERTOS']).optional() })
      .parse(request.query);

    const filter =
      status === 'ABERTOS'
        ? inArray(printJobs.status, ['PENDENTE', 'IMPRIMINDO', 'ERRO'])
        : status
          ? eq(printJobs.status, status)
          : undefined;

    const [rows, printerRows, counts, lastOk] = await Promise.all([
      db
        .select({ job: printJobs, printerName: printers.name, sectorLabel: printers.sectorLabel })
        .from(printJobs)
        .innerJoin(printers, eq(printers.id, printJobs.printerId))
        .where(filter)
        .orderBy(desc(printJobs.createdAt))
        .limit(150),
      db.select().from(printers).orderBy(asc(printers.name)),
      db
        .select({
          printerId: printJobs.printerId,
          pending: sql<number>`count(*) filter (where ${printJobs.status} in ('PENDENTE', 'IMPRIMINDO'))::int`,
          errors: sql<number>`count(*) filter (where ${printJobs.status} = 'ERRO')::int`,
        })
        .from(printJobs)
        .groupBy(printJobs.printerId),
      db
        .select({ printerId: printJobs.printerId, at: max(printJobs.printedAt) })
        .from(printJobs)
        .where(eq(printJobs.status, 'OK'))
        .groupBy(printJobs.printerId),
    ]);

    const lastErrors = await db
      .select({ printerId: printJobs.printerId, lastError: printJobs.lastError })
      .from(printJobs)
      .where(eq(printJobs.status, 'ERRO'))
      .orderBy(desc(printJobs.updatedAt));

    const printerStatus: PrinterQueueStatus[] = printerRows.map((p) => {
      const c = counts.find((x) => x.printerId === p.id);
      return {
        printerId: p.id,
        printerName: p.name,
        sectorLabel: p.sectorLabel,
        active: p.active,
        pending: c?.pending ?? 0,
        errors: c?.errors ?? 0,
        lastError: lastErrors.find((e) => e.printerId === p.id)?.lastError ?? null,
        lastPrintedAt: lastOk.find((l) => l.printerId === p.id)?.at?.toISOString() ?? null,
      };
    });

    const jobs: PrintJobSummary[] = rows.map(({ job: j, printerName, sectorLabel }) => ({
      id: j.id,
      printerId: j.printerId,
      printerName,
      sectorLabel,
      type: j.type,
      status: j.status,
      attempts: j.attempts,
      lastError: j.lastError,
      createdAt: j.createdAt.toISOString(),
      printedAt: j.printedAt?.toISOString() ?? null,
      nextAttemptAt: j.nextAttemptAt?.toISOString() ?? null,
      reprintOf: j.reprintOf,
      description: describeTicket(j.payload as TicketPayload),
    }));

    return { mode: printWorker.mode, printers: printerStatus, jobs };
  });

  /** Prévia exatamente como sai no papel (o "emulador" na tela). */
  app.get('/jobs/:id/preview', async (request) => {
    const { id } = idParams.parse(request.params);
    const [row] = await db
      .select({ job: printJobs, printer: printers })
      .from(printJobs)
      .innerJoin(printers, eq(printers.id, printJobs.printerId))
      .where(eq(printJobs.id, id));
    if (!row) throw notFound('Cupom');
    return { text: renderJob(row.job.payload as TicketPayload, row.printer).preview, widthMm: row.printer.widthMm };
  });

  /** Cupom com erro: tenta de novo agora (ex.: trocou o papel), sem esperar o backoff. */
  app.post('/jobs/:id/retry', async (request) => {
    const { id } = idParams.parse(request.params);
    const [updated] = await db
      .update(printJobs)
      .set({ nextAttemptAt: null })
      .where(and(eq(printJobs.id, id), inArray(printJobs.status, ['ERRO', 'PENDENTE'])))
      .returning({ id: printJobs.id });
    if (!updated) throw new HttpError(409, 'NOT_RETRYABLE', 'Este cupom não está aguardando impressão.');
    printWorker.kick();
    return { ok: true };
  });

  /** Reimpressão manual: novo cupom marcado "REIMPRESSÃO" na mesma impressora (SPEC 5.5). */
  app.post('/jobs/:id/reprint', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const [original] = await db.select().from(printJobs).where(eq(printJobs.id, id));
    if (!original) throw notFound('Cupom');
    const payload = { ...(original.payload as TicketPayload), reprint: true };
    const job = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(printJobs)
        .values({ printerId: original.printerId, type: original.type, payload, referenceId: original.referenceId, reprintOf: original.id })
        .returning({ id: printJobs.id });
      await audit(tx, request, { action: 'REIMPRESSAO', entity: 'print_job', entityId: original.id, after: { newJobId: created!.id } });
      return created!;
    });
    printWorker.kick();
    return reply.code(201).send({ id: job.id });
  });

  /** Destrava todos os cupons com erro de uma impressora (ou de todas). */
  app.post('/retry-all', async (request) => {
    const { printerId } = z.object({ printerId: z.string().uuid().optional() }).parse(request.body ?? {});
    await printWorker.retryNow(printerId);
    return { ok: true };
  });
}
