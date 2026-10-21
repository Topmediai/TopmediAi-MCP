import { systemCredentialStore } from '../../src/credential-store.js';
// Test-only preload for the installer and its child MCP. Never inspect the user's OS store.
systemCredentialStore.read = () => null;
systemCredentialStore.readAsync = async () => null;
systemCredentialStore.write = async () => { throw new Error('Installer tests must not save credentials'); };
systemCredentialStore.remove = async () => { throw new Error('Installer tests must not remove credentials'); };
