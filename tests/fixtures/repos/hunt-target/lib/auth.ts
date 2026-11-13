import { cookies } from 'next/headers';
import { db } from './db';

export type Session = { userId: string; orgId: string; role: 'member' | 'admin' };

export async function getSession(): Promise<Session | null> {
  const token = cookies().get('session')?.value;
  if (!token) return null;
  const rows = await db.query('select user_id, org_id, role from sessions where token = $1', [token]);
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, orgId: rows[0].org_id, role: rows[0].role };
}
