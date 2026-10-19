import { renderEscPos, renderText, type Codepage } from '@sistema-bar/escpos';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client';
import { printers, printJobs } from '../db/schema';
import { ticketBlocks } from './layouts';
import type { TicketPayload } from './tickets';
import type { PrintTransport } from './transport';

/** Espera depois de cada falha: 5 s, 10 s, 20 s, 40 s e depois a cada 60 s, sem desistir. */
export const backoffMs = (attempts: number) => Math.min(60_000, 5_000 * 2 ** Math.max(0, attempts - 1));

type PrinterRow = typeof printers.$inferSelect;

/** Prévia em texto e bytes ESC/POS de um cupom, para a impressora informada. */
export function renderJob(payload: TicketPayload, printer: Pick<PrinterRow, 'widthMm' | 'codepage' | 'cut'>) {
  const blocks = ticketBlocks(payload);
  const widthMm = printer.widthMm === 58 ? 58 : 80;
  return {
    preview: renderText(blocks, widthMm),
    bytes: renderEscPos(blocks, { widthMm, codepage: printer.codepage as Codepage, cut: printer.cut }),
  };
}

/**
 * Worker da fila de impressão (SPEC 5.5).
 * - Cada impressora tem sua própria fila, em ordem: se o bar está sem papel, a cozinha continua.
 * - Falhou: o cupom fica em ERRO e é tentado de novo com espera crescente, até imprimir.
 * - Os cupons seguintes daquela impressora esperam, para não saírem fora de ordem.
 */
export function createPrintWorker({
  db,
  transport,
  log,
  intervalMs = 2_000,
}: {
  db: Db;
  transport: PrintTransport;
  log?: FastifyBaseLogger;
  intervalMs?: number;
}) {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  async function printNext(printer: PrinterRow): Promise<boolean> {
    const [job] = await db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.printerId, printer.id), inArray(printJobs.status, ['PENDENTE', 'ERRO'])))
      .orderBy(asc(printJobs.createdAt))
      .limit(1);
    if (!job) return false;
    if (job.nextAttemptAt && job.nextAttemptAt > new Date()) return false; // aguardando o backoff

    // Reserva o cupom (o WHERE no status impede que dois ciclos peguem o mesmo).
    const [claimed] = await db
      .update(printJobs)
      .set({ status: 'IMPRIMINDO', attempts: job.attempts + 1 })
      .where(and(eq(printJobs.id, job.id), eq(printJobs.status, job.status)))
      .returning({ id: printJobs.id });
    if (!claimed) return false;

    try {
      const { bytes, preview } = renderJob(job.payload as TicketPayload, printer);
      await transport.send(printer, { id: job.id, bytes, preview });
      await db
        .update(printJobs)
        .set({ status: 'OK', printedAt: new Date(), lastError: null, nextAttemptAt: null })
        .where(eq(printJobs.id, job.id));
      return true;
    } catch (err) {
      const attempts = job.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      log?.warn({ jobId: job.id, printer: printer.name, err: message }, 'Falha ao imprimir');
      await db
        .update(printJobs)
        .set({ status: 'ERRO', lastError: message, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) })
        .where(eq(printJobs.id, job.id));
      return false;
    }
  }

  async function cycle() {
    const list = await db.select().from(printers).where(eq(printers.active, true));
    // Impressoras em paralelo; dentro de cada uma, um cupom por vez, em ordem.
    await Promise.all(
      list.map(async (p) => {
        while (await printNext(p)) {
          /* continua enquanto houver cupom pronto para esta impressora */
        }
      }),
    );
  }

  const worker = {
    /** Uma rodada completa. Chamadas durante uma rodada agendam mais uma ao final. */
    runOnce(): Promise<void> {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          try {
            await cycle();
          } catch (err) {
            log?.error({ err }, 'Erro no worker de impressão');
          }
        } while (again);
      })().finally(() => {
        running = null;
      });
      return running;
    },

    /** Pedido novo chegou: imprime já, sem esperar o próximo ciclo. */
    kick() {
      if (timer) void worker.runOnce();
    },

    async start() {
      // Cupom que estava "imprimindo" quando o servidor caiu: volta para a fila.
      await db.update(printJobs).set({ status: 'PENDENTE' }).where(eq(printJobs.status, 'IMPRIMINDO'));
      timer = setInterval(() => void worker.runOnce(), intervalMs);
      void worker.runOnce();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },

    /** Tenta de novo agora os cupons com erro (ex.: trocou o papel). */
    async retryNow(printerId?: string) {
      await db
        .update(printJobs)
        .set({ nextAttemptAt: null })
        .where(and(eq(printJobs.status, 'ERRO'), printerId ? eq(printJobs.printerId, printerId) : undefined));
      worker.kick();
    },
  };
  return worker;
}

export type PrintWorker = ReturnType<typeof createPrintWorker>;

