import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = {
  query: (text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows),
};

export function forTenant(orgId: string) {
  return {
    query: (text: string, params: unknown[] = []) =>
      db.query(`${text} where org_id = $${params.length + 1}`, [...params, orgId]),
  };
}
