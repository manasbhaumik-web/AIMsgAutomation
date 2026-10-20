import { Client } from 'pg';
import { hashPassword } from '../auth/password';
import { CryptoService } from '../crypto/crypto.service';
import { migrate } from './migrate';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');

  if (cmd === 'migrate') {
    const applied = await migrate(adminUrl);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date');
  } else if (cmd === 'create-admin') {
    const [email, password] = args;
    if (!email || !password || password.length < 12) throw new Error('usage: create-admin <email> <password (12+ chars)>');
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const hash = await hashPassword(password);
      const r = await client.query('SELECT auth_create_user($1, $2, $3, $4) AS id', [email, null, hash, 'admin']);
      console.log(`Created platform admin ${email} (${r.rows[0].id})`);
    } finally {
      await client.end();
    }
  } else if (cmd === 'rotate-keys') {
    // Re-wraps every stored data key with the current MASTER_KEY (old keys go in MASTER_KEY_PREVIOUS). Idempotent and safe to re-run.
    const crypto = new CryptoService({ MASTER_KEY: process.env.MASTER_KEY ?? '', MASTER_KEY_PREVIOUS: process.env.MASTER_KEY_PREVIOUS } as never);
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const targets: [string, string, string][] = [['llm_providers', 'enc_api_key', 'id'], ['connected_accounts', 'enc_tokens', 'id'], ['push_devices', 'enc_token', 'id'], ['webhook_inbox', 'enc_payload', 'id']];
      for (const [table, col, key] of targets) {
        const rows = await client.query(`SELECT ${key} AS k, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`); // identifiers are constants above
        let changed = 0;
        for (const r of rows.rows) {
          const next = crypto.rewrap(r.v as Buffer);
          if (!next) continue;
          await client.query(`UPDATE ${table} SET ${col} = $2 WHERE ${key} = $1`, [r.k, next]);
          changed++;
        }
        console.log(`${table}.${col}: ${changed} of ${rows.rowCount} re-wrapped`);
      }
    } finally {
      await client.end();
    }
  } else {
    throw new Error('usage: cli.js <migrate | create-admin | rotate-keys>');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
