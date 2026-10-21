import { openMysqlDatabase, createMysqlPool } from './mysql/connection.js';
import { MysqlServerDatabase } from './mysql/server-database.js';
import { cliText } from './cli-locale.js';

const password = process.env['MAR_RESET_PASSWORD'];
if (password === undefined) {
  console.error(cliText('resetPasswordRequired'));
  process.exitCode = 1;
} else {
  const pool = await openMysqlDatabase();
  const database = new MysqlServerDatabase(
    pool,
    undefined,
    createMysqlPool({ connectionLimit: 4 })
  );
  try {
    await database.initialize();
    await database.resetPassword(password, 'local-command');
    console.log(cliText('resetPasswordCompleted'));
  } finally {
    await database.close();
  }
}
