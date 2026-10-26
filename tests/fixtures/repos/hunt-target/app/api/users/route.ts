import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db } from '@/lib/db';

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  const rows = await db.query('select id, org_id, email, name, phone from users where id = $1', [id]);
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(rows[0]);
}
