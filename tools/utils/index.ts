import fs from 'fs-extra';
import { logger } from '../../lib/logger/index.ts';

export const newFiles = new Set();

/**
 * @param {string } file
 * @param {string} code
 * @returns {Promise<void>}
 */
export async function updateFile(file: string, code: string): Promise<void> {
  let oldCode: string | null = null;
  if (await fs.pathExists(file)) {
    oldCode = await fs.readFile(file, 'utf8');
  }
  if (code !== oldCode) {
    if (!code) {
      logger.error({ file }, 'Missing content');
    }
    await fs.outputFile(file, code ?? '', { encoding: 'utf8' });
  }
  newFiles.add(file);
}

/**
 * @param {string } file
 * @returns {Promise<string | null>}
 */
export async function readFile(file: string): Promise<string> {
  if (await fs.pathExists(file)) {
    return fs.readFile(file, 'utf8');
  }
  return '';
}
