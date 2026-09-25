/** Prije učitavanja modula pohrane: MDM datoteke testa g-dovrsetak u privremenoj mapi. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const storageDir = mkdtempSync(path.join(tmpdir(), 'g-mdm-'));
process.env.MDM_STORAGE_DIR = storageDir;
