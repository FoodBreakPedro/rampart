import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { forTenant } from '@/lib/db';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = await forTenant(session.orgId).query('select id, customer, total, status from invoices');
  return NextResponse.json(rows);
}
