import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Persistent SQLite file next to this script (survives MCP server restarts).
const dbPath = fileURLToPath(new URL('./finance-demo.sqlite', import.meta.url));
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    currency TEXT NOT NULL CHECK(length(currency) = 3),
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('unpaid', 'paid', 'draft')),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );
`);

// Seed fictional Swedish demo customers (idempotent).
const upsertCustomer = db.prepare(
  'INSERT OR IGNORE INTO customers (id, name) VALUES (?, ?)'
);
upsertCustomer.run('C101', 'Nordic Timber AB');
upsertCustomer.run('C102', 'Växjö Design Studio AB');
upsertCustomer.run('C103', 'Stockholm Cloud Consulting AB');

const invoiceCount = db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
if (invoiceCount === 0) {
  const seed = db.prepare(`
    INSERT INTO invoices (customer_id, amount, currency, description, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  seed.run('C101', 4500.0, 'SEK', 'Consulting services Q1', 'unpaid');
  seed.run('C102', 1250.5, 'SEK', 'Website support retainer', 'unpaid');
  seed.run('C103', 890.0, 'SEK', 'Cloud migration workshop', 'unpaid');
  seed.run('C101', 3200.0, 'SEK', 'Prior year closing work', 'paid');
}

const findCustomer = db.prepare('SELECT id, name FROM customers WHERE id = ?');
const findDemoDraft = db.prepare(`
  SELECT i.id, i.customer_id AS customerId, c.name AS customerName,
         i.amount, i.currency, i.description, i.status
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  WHERE i.customer_id = ?
    AND i.amount = ?
    AND i.currency = ?
    AND i.description = ?
    AND i.status = 'draft'
  LIMIT 1
`);
const insertDraft = db.prepare(`
  INSERT INTO invoices (customer_id, amount, currency, description, status)
  VALUES (?, ?, ?, ?, 'draft')
`);
const getInvoiceById = db.prepare(`
  SELECT i.id, i.customer_id AS customerId, c.name AS customerName,
         i.amount, i.currency, i.description, i.status
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  WHERE i.id = ?
`);

function listInvoicesFiltered({ customer_id, status } = {}) {
  const clauses = [];
  const params = [];
  if (customer_id) {
    clauses.push('i.customer_id = ?');
    params.push(customer_id);
  }
  if (status) {
    clauses.push('i.status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `
    SELECT i.id, i.customer_id AS customerId, c.name AS customerName,
           i.amount, i.currency, i.description, i.status
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    ${where}
    ORDER BY i.id
  `;
  return db.prepare(sql).all(...params);
}

function createServer() {
  const server = new McpServer({ name: 'mini-finance', version: '1.0.0' });

  server.registerTool(
    'list_invoices',
    {
      description:
        'List invoices from the local SQLite demo database. Optionally filter by customer_id and/or status (unpaid, paid, draft). Read-only.',
      inputSchema: z.object({
        customer_id: z
          .string()
          .optional()
          .describe('Optional customer ID filter, e.g. C101'),
        status: z
          .enum(['unpaid', 'paid', 'draft'])
          .optional()
          .describe('Optional status filter')
      })
    },
    async ({ customer_id, status } = {}) => {
      const invoices = listInvoicesFiltered({ customer_id, status });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: invoices.length, invoices }, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    'create_invoice_draft',
    {
      description:
        'Create a DRAFT invoice in the local SQLite demo database. Validates the customer ID. Does NOT send, post, finalize, or book the invoice.',
      inputSchema: z.object({
        customer_id: z
          .string()
          .describe('Existing customer ID, e.g. C101, C102, or C103'),
        amount: z
          .number()
          .positive()
          .describe('Invoice amount in major currency units, e.g. 2500'),
        currency: z
          .string()
          .length(3)
          .describe('ISO 4217 currency code, e.g. SEK'),
        description: z
          .string()
          .max(200)
          .describe('Short invoice description')
      })
    },
    async ({ customer_id, amount, currency, description }) => {
      const customer = findCustomer.get(customer_id);
      if (!customer) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Customer ${customer_id} not found. Use C101, C102, or C103 in this demo.`
            }
          ]
        };
      }

      const currencyCode = currency.toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Invalid currency. Use a 3-letter ISO code such as SEK.'
            }
          ]
        };
      }

      // Reject amounts that are not representable with two decimal places.
      const rounded = Math.round(amount * 100) / 100;
      if (!Number.isFinite(rounded) || rounded <= 0 || Math.abs(rounded - amount) > 0.000001) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Invalid amount. Use a positive number with at most two decimal places.'
            }
          ]
        };
      }

      // Idempotent demo marker: avoid duplicate MCP_INTERVIEW_DEMO drafts on re-runs.
      const existing = findDemoDraft.get(
        customer_id,
        rounded,
        currencyCode,
        description
      );
      if (existing) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  alreadyExisted: true,
                  invoiceId: existing.id,
                  status: existing.status,
                  customerId: existing.customerId,
                  customerName: existing.customerName,
                  amount: existing.amount,
                  currency: existing.currency,
                  description: existing.description,
                  message:
                    'Draft already present in finance-demo.sqlite; not duplicated. Not posted or sent.'
                },
                null,
                2
              )
            }
          ]
        };
      }

      const result = insertDraft.run(
        customer_id,
        rounded,
        currencyCode,
        description
      );
      const created = getInvoiceById.get(Number(result.lastInsertRowid));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                alreadyExisted: false,
                invoiceId: created.id,
                status: created.status,
                customerId: created.customerId,
                customerName: created.customerName,
                amount: created.amount,
                currency: created.currency,
                description: created.description,
                message:
                  'Saved as draft in finance-demo.sqlite; not posted or sent.'
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  return server;
}

// stdout is reserved for MCP JSON-RPC; all diagnostics go to stderr.
console.error(`Mini Finance MCP ready (SQLite): ${dbPath}`);
void serveStdio(createServer);
