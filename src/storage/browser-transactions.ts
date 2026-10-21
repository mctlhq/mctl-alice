import { IStorage } from "./storage-interface.js";

/** Shared, encrypted, expiring browser state. The namespace prevents cross-flow substitution. */
export class BrowserTransactions<T extends { expires: number }> {
  constructor(private storage: IStorage, private namespace: string) {}
  async set(id: string, value: T): Promise<void> {
    await this.storage.saveBrowserTransaction(`${this.namespace}:${id}`, JSON.stringify(value), value.expires);
  }
  async get(id: string): Promise<T | undefined> {
    const payload = await this.storage.getBrowserTransaction(`${this.namespace}:${id}`);
    return payload === null ? undefined : JSON.parse(payload) as T;
  }
  async delete(id: string): Promise<void> {
    await this.storage.deleteBrowserTransaction(`${this.namespace}:${id}`);
  }
}
