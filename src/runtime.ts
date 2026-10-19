import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { ImageService } from './service.js';
import { GenerationService } from './generation/service.js';
import { VoiceCatalog } from './generation/voices.js';

export interface RuntimeContext {
  config: Config;
  service: ImageService;
  generation: GenerationService;
  voices: VoiceCatalog;
}

/** Refresh between tool calls; an in-flight call keeps its original account and stores. */
export class RuntimeServices {
  private context: RuntimeContext;
  private signature: string;

  constructor(config: Config, private readonly reloadConfig?: () => Config) {
    this.context = this.create(config);
    this.signature = this.key(config);
  }

  private key(config: Config): string {
    // Never log or persist the configuration, which contains the account token.
    return createHash('sha256').update(JSON.stringify(config)).digest('hex');
  }

  private create(config: Config): RuntimeContext {
    const snapshot = Object.freeze({ ...config });
    return { config: snapshot, service: new ImageService(snapshot),
      generation: new GenerationService(snapshot), voices: new VoiceCatalog(snapshot) };
  }

  current(snapshot?: Config): RuntimeContext {
    if (!snapshot && !this.reloadConfig) return this.context;
    // A missing, invalid or unsafe credential must never fall back to the old token.
    const config = snapshot ?? this.reloadConfig!();
    const signature = this.key(config);
    if (signature !== this.signature) {
      const context = this.create(config);
      this.context = context;
      this.signature = signature;
    }
    return this.context;
  }
}
