import { TopMediaiError } from '../types.js';

/** Read the complete backend JSON response without a client-imposed byte limit. */
export async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new TopMediaiError('INVALID_RESPONSE', 'The backend response is empty.');
  // The fetch abort signal continues to enforce the request timeout while reading.
  const bytes = await response.arrayBuffer();
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TopMediaiError('INVALID_RESPONSE', 'The backend did not return valid JSON.');
  }
}
