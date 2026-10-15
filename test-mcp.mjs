/**
 * End-to-end MCP client test against the local stdio server.
 * Verifies tool discovery, list/create invoice calls, and SQLite persistence.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(root, 'server.mjs');
const dbPath = path.join(root, 'finance-demo.sqlite');

const DEMO_DESCRIPTION = 'MCP_INTERVIEW_DEMO';
const DEMO_CUSTOMER = 'C101';
const DEMO_AMOUNT = 2500;
const DEMO_CURRENCY = 'SEK';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseToolText(result) {
  assert(Array.isArray(result.content) && result.content.length > 0, 'Empty tool content');
  const text = result.content.find((b) => b.type === 'text')?.text;
  assert(typeof text === 'string', 'Tool result missing text block');
  return JSON.parse(text);
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    stderr: 'pipe'
  });

  // Surface server stderr (protocol-safe logs) for the test report.
  transport.stderr?.on('data', (chunk) => {
    process.stderr.write(`[server] ${chunk}`);
  });

  const client = new Client({ name: 'mini-finance-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    console.log('PASS: MCP client connected over stdio');

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log('Tools discovered:', names.join(', '));
    assert(names.includes('list_invoices'), 'Missing list_invoices');
    assert(names.includes('create_invoice_draft'), 'Missing create_invoice_draft');
    assert(names.length === 2, `Expected exactly 2 tools, got ${names.length}`);
    console.log('PASS: Both MCP tools listed');

    const listBeforeResult = await client.callTool({
      name: 'list_invoices',
      arguments: {}
    });
    assert(!listBeforeResult.isError, 'list_invoices failed');
    const listBefore = parseToolText(listBeforeResult);
    assert(Array.isArray(listBefore.invoices), 'list_invoices missing invoices array');
    console.log(`PASS: list_invoices returned ${listBefore.count} invoice(s)`);

    const createResult = await client.callTool({
      name: 'create_invoice_draft',
      arguments: {
        customer_id: DEMO_CUSTOMER,
        amount: DEMO_AMOUNT,
        currency: DEMO_CURRENCY,
        description: DEMO_DESCRIPTION
      }
    });
    assert(!createResult.isError, `create_invoice_draft failed: ${JSON.stringify(createResult)}`);
    const created = parseToolText(createResult);
    assert(created.success === true, 'create_invoice_draft success=false');
    assert(created.status === 'draft', 'Created invoice is not draft');
    assert(created.customerId === DEMO_CUSTOMER, 'Wrong customer on draft');
    assert(Number(created.amount) === DEMO_AMOUNT, 'Wrong amount on draft');
    assert(created.currency === DEMO_CURRENCY, 'Wrong currency on draft');
    assert(created.description === DEMO_DESCRIPTION, 'Wrong description on draft');
    assert(Number.isInteger(created.invoiceId), 'Missing invoiceId');
    console.log(
      `PASS: create_invoice_draft -> invoiceId=${created.invoiceId}` +
        (created.alreadyExisted ? ' (already existed, idempotent)' : ' (newly created)')
    );

    const listAfterResult = await client.callTool({
      name: 'list_invoices',
      arguments: { status: 'draft' }
    });
    assert(!listAfterResult.isError, 'list_invoices (draft filter) failed');
    const listAfter = parseToolText(listAfterResult);
    const found = listAfter.invoices.find(
      (inv) =>
        inv.id === created.invoiceId &&
        inv.description === DEMO_DESCRIPTION &&
        Number(inv.amount) === DEMO_AMOUNT
    );
    assert(found, 'New draft not found via list_invoices');
    console.log('PASS: list_invoices includes the demo draft');

    // Independent SQLite verification (not through MCP).
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `
        SELECT id, customer_id, amount, currency, description, status
        FROM invoices
        WHERE id = ?
      `
      )
      .get(created.invoiceId);
    db.close();

    assert(row, 'Invoice row missing in SQLite file');
    assert(row.customer_id === DEMO_CUSTOMER, 'SQLite customer_id mismatch');
    assert(Number(row.amount) === DEMO_AMOUNT, 'SQLite amount mismatch');
    assert(row.currency === DEMO_CURRENCY, 'SQLite currency mismatch');
    assert(row.description === DEMO_DESCRIPTION, 'SQLite description mismatch');
    assert(row.status === 'draft', 'SQLite status mismatch');
    console.log('PASS: SQLite file contains the draft invoice');

    // Second create must not duplicate the demo draft.
    const createAgain = await client.callTool({
      name: 'create_invoice_draft',
      arguments: {
        customer_id: DEMO_CUSTOMER,
        amount: DEMO_AMOUNT,
        currency: DEMO_CURRENCY,
        description: DEMO_DESCRIPTION
      }
    });
    const again = parseToolText(createAgain);
    assert(again.alreadyExisted === true, 'Expected idempotent alreadyExisted=true');
    assert(again.invoiceId === created.invoiceId, 'Idempotent create returned different id');
    console.log('PASS: Duplicate demo draft prevented');

    console.log('\nALL CHECKS PASSED');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exitCode = 1;
});
