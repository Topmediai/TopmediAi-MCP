import type { Environment } from '../../src/auth-protocol.js';
import type { CredentialStore } from '../../src/credential-store.js';

/** Test-only dependency injection; never selected through production config. */
export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<Environment, string>();
  read(environment: Environment) { return this.values.get(environment) ?? null; }
  async readAsync(environment: Environment) { return this.read(environment); }
  async write(environment: Environment, secret: string) { this.values.set(environment, secret); }
  async remove(environment: Environment) { this.values.delete(environment); }
}
