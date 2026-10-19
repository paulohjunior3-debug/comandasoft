import { loadConfig } from '../config';
import { createDb } from './client';

const config = loadConfig();
const conn = createDb(config.DATABASE_URL);
await conn.migrate();
await conn.close();
console.log('Migrations aplicadas.');
