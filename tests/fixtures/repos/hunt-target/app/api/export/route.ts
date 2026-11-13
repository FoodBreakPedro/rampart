import { getSession } from '@/lib/auth';
import { db } from '@/lib/db';

export async function GET() {
  const session = await getSession();
  if (!session) return new Response('unauthorized', { status: 401 });

  const rows = await db.query('select * from invoices');
  const header = Object.keys(rows[0] ?? {}).join(',');
  const lines = rows.map((r: Record<string, unknown>) => Object.values(r).join(','));
  return new Response([header, ...lines].join('\n'), {
    headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="invoices.csv"' },
  });
}
