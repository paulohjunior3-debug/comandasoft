import { salesReportQuerySchema } from '@sistema-bar/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app';
import { buildSalesReport } from '../../lib/sales-report';

/** Relatórios (SPEC 5.9): vendas e entradas por período, caixa, forma de pagamento e cupom fiscal. */
export async function reportRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/sales', async (request) => buildSalesReport(db, salesReportQuerySchema.parse(request.query)));
}
