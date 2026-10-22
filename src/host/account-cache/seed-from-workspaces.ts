import * as fs from 'fs/promises';
import * as path from 'path';
import type { AccountCache } from './account-cache';
import { validCatalogProviders, validUsageProviders } from './validate';

async function readJson(file: string): Promise<{ parsed: unknown; fetchedAt: number } | null> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { parsed: JSON.parse(text), fetchedAt: Math.floor(stat.mtimeMs) };
  } catch {
    return null;
  }
}

// Newest-wins upsert in the cache means file order does not matter.
export async function seedFromWorkspaces(cache: AccountCache, workspacesDir: string): Promise<void> {
  if (!cache.available || !cache.isEmpty()) { return; }
  let slugs: string[];
  try {
    slugs = await fs.readdir(workspacesDir);
  } catch {
    return;
  }
  for (const slug of slugs) {
    const usage = await readJson(path.join(workspacesDir, slug, 'usage.json'));
    if (usage) {
      for (const [instance, windows] of Object.entries(validUsageProviders(usage.parsed))) {
        cache.writeUsage({ instance, windows, fetchedAt: usage.fetchedAt });
      }
    }
    const catalog = await readJson(path.join(workspacesDir, slug, 'catalog.json'));
    if (catalog) {
      for (const [instance, models] of Object.entries(validCatalogProviders(catalog.parsed))) {
        cache.writeCatalog({ instance, models, fetchedAt: catalog.fetchedAt });
      }
    }
  }
}
