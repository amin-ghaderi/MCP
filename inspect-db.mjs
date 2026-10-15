import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const dbPath = fileURLToPath(new URL('./finance-demo.sqlite', import.meta.url));
const db = new DatabaseSync(dbPath, { readOnly: true });

console.error(`Database: ${dbPath}`);
console.log('\nCustomers:');
console.table(db.prepare('SELECT id, name FROM customers ORDER BY id').all());

console.log('Invoices:');
console.table(
  db
    .prepare(
      `
      SELECT i.id, c.name AS customer, i.amount, i.currency,
             i.status, i.description
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      ORDER BY i.id
    `
    )
    .all()
);

db.close();
