/**
 * Source Adapter Interface
 * Abstracts the "fetch" stage of the pack import pipeline.
 * Each source type (git, npm, url, file) implements this interface.
 */

export interface FetchedPackPayload {
  /** Raw manifest JSON (package.json, manifest.yaml, etc.) */
  rawManifest: Record<string, unknown>;
  /** Optional archive buffer (tar.gz, zip) */
  archiveBuffer?: Buffer;
  /** Source metadata */
  sourceMeta: {
    sourceType: string;
    sourceUrl: string;
    fetchedAt: Date;
    sizeBytes?: number;
    checksum?: string;
  };
}

export interface SourceAdapter {
  readonly sourceType: string;
  fetch(sourceUrl: string): Promise<FetchedPackPayload>;
  validate(sourceUrl: string): boolean;
}

/**
 * Git Repository Adapter
 * Fetches pack manifest from a Git repository URL.
 */
export class GitSourceAdapter implements SourceAdapter {
  readonly sourceType = 'GIT';

  validate(sourceUrl: string): boolean {
    return (
      /^https?:\/\/.+\.git$|^git@/.test(sourceUrl) ||
      /^https?:\/\/(github|gitlab|bitbucket)\./.test(sourceUrl)
    );
  }

  async fetch(sourceUrl: string): Promise<FetchedPackPayload> {
    // Phase 1: Simulated fetch — in production, this would:
    // 1. git clone --depth 1
    // 2. Read manifest.json / pack.yaml from root
    // 3. Archive the repository contents
    console.log(`[GitAdapter] Fetching from ${sourceUrl}`);

    return {
      rawManifest: {
        name: this.extractNameFromUrl(sourceUrl),
        version: '1.0.0',
        sourceType: 'GIT',
        description: `Pack imported from ${sourceUrl}`,
        capabilities: [],
      },
      sourceMeta: {
        sourceType: 'GIT',
        sourceUrl,
        fetchedAt: new Date(),
      },
    };
  }

  private extractNameFromUrl(url: string): string {
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    return match?.[1] ?? `git-pack-${Date.now()}`;
  }
}

/**
 * NPM Registry Adapter
 * Fetches pack from npm registry.
 */
export class NpmSourceAdapter implements SourceAdapter {
  readonly sourceType = 'NPM';

  validate(sourceUrl: string): boolean {
    // Accepts npm package names or registry URLs
    return (
      /^@?[\w-]+\/[\w-]+$|^https:\/\/registry\.npmjs\.org/.test(sourceUrl) ||
      /^[\w-]+$/.test(sourceUrl)
    );
  }

  async fetch(sourceUrl: string): Promise<FetchedPackPayload> {
    console.log(`[NpmAdapter] Fetching from ${sourceUrl}`);

    return {
      rawManifest: {
        name: sourceUrl.replace(/^https:\/\/registry\.npmjs\.org\//, ''),
        version: '1.0.0',
        sourceType: 'NPM',
        description: `Pack imported from npm: ${sourceUrl}`,
        capabilities: [],
      },
      sourceMeta: {
        sourceType: 'NPM',
        sourceUrl,
        fetchedAt: new Date(),
      },
    };
  }
}

/**
 * URL Adapter
 * Fetches pack from a direct URL (tar.gz or zip archive).
 */
export class UrlSourceAdapter implements SourceAdapter {
  readonly sourceType = 'URL';

  validate(sourceUrl: string): boolean {
    return /^https?:\/\//.test(sourceUrl);
  }

  async fetch(sourceUrl: string): Promise<FetchedPackPayload> {
    console.log(`[UrlAdapter] Fetching from ${sourceUrl}`);

    return {
      rawManifest: {
        name: `url-pack-${Date.now()}`,
        version: '1.0.0',
        sourceType: 'URL',
        description: `Pack imported from ${sourceUrl}`,
        capabilities: [],
      },
      sourceMeta: {
        sourceType: 'URL',
        sourceUrl,
        fetchedAt: new Date(),
      },
    };
  }
}

/**
 * File Upload Adapter
 * Handles packs uploaded directly as files.
 */
export class FileSourceAdapter implements SourceAdapter {
  readonly sourceType = 'FILE';

  validate(sourceUrl: string): boolean {
    return sourceUrl.startsWith('file://') || sourceUrl.startsWith('/');
  }

  async fetch(sourceUrl: string): Promise<FetchedPackPayload> {
    console.log(`[FileAdapter] Reading from ${sourceUrl}`);

    return {
      rawManifest: {
        name: `file-pack-${Date.now()}`,
        version: '1.0.0',
        sourceType: 'FILE',
        description: `Pack uploaded from local file`,
        capabilities: [],
      },
      sourceMeta: {
        sourceType: 'FILE',
        sourceUrl,
        fetchedAt: new Date(),
      },
    };
  }
}

/**
 * Adapter Registry — resolves the correct adapter for a given sourceType.
 */
const adapters: SourceAdapter[] = [
  new GitSourceAdapter(),
  new NpmSourceAdapter(),
  new UrlSourceAdapter(),
  new FileSourceAdapter(),
];

export function getSourceAdapter(sourceType: string): SourceAdapter {
  const adapter = adapters.find((a) => a.sourceType.toUpperCase() === sourceType.toUpperCase());
  if (!adapter) {
    throw new Error(`No source adapter found for type: ${sourceType}`);
  }
  return adapter;
}

export function detectSourceType(sourceUrl: string): string {
  for (const adapter of adapters) {
    if (adapter.validate(sourceUrl)) {
      return adapter.sourceType;
    }
  }
  return 'URL'; // default fallback
}
