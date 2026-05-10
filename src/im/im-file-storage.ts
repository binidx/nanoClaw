import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

export interface FileStorageAdapter {
  save(key: string, data: Buffer, mime: string): Promise<void>;
  read(key: string): Promise<{ data: Buffer; mime: string }>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class LocalFileStorage implements FileStorageAdapter {
  private readonly initPromise: Promise<void>;

  constructor(private readonly root: string) {
    this.initPromise = fsp.mkdir(root, { recursive: true }).then(() => {});
  }

  private resolve(key: string): string {
    const resolved = path.resolve(this.root, key);
    const prefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (resolved !== this.root && !resolved.startsWith(prefix)) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  async save(key: string, data: Buffer, _mime?: string): Promise<void> {
    await this.initPromise;
    const p = this.resolve(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, data);
  }

  async read(key: string): Promise<{ data: Buffer; mime: string }> {
    await this.initPromise;
    const p = this.resolve(key);
    try {
      const data = await fsp.readFile(p);
      return { data, mime: '' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('File not found');
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.initPromise;
    const p = this.resolve(key);
    try {
      await fsp.unlink(p);
    } catch {
      // already gone
    }
  }

  async exists(key: string): Promise<boolean> {
    await this.initPromise;
    const p = this.resolve(key);
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }
}
