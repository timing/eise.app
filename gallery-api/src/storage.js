export function createStorage(env) {
  if (!env.BUNNY_STORAGE_ZONE || !env.BUNNY_STORAGE_ACCESS_KEY) {
    throw new Error('BUNNY_STORAGE_ZONE and BUNNY_STORAGE_ACCESS_KEY must be set');
  }
  return new BunnyStorage(env);
}

class BunnyStorage {
  constructor(env) {
    this.zone = env.BUNNY_STORAGE_ZONE;
    this.accessKey = env.BUNNY_STORAGE_ACCESS_KEY;
    this.host = env.BUNNY_STORAGE_HOSTNAME || 'storage.bunnycdn.com';
    this.publicUrl = (env.BUNNY_STORAGE_PUBLIC_URL || `https://${this.zone}.b-cdn.net`).replace(/\/$/, '');
  }
  async put(path, body, contentType) {
    const url = `https://${this.host}/${this.zone}/${path}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { AccessKey: this.accessKey, 'Content-Type': contentType },
      body,
    });
    if (!res.ok) throw new Error(`Bunny Storage PUT failed: ${res.status} ${await res.text()}`);
    return `${this.publicUrl}/${path}`;
  }
  async delete(path) {
    const url = `https://${this.host}/${this.zone}/${path}`;
    const res = await fetch(url, { method: 'DELETE', headers: { AccessKey: this.accessKey } });
    if (!res.ok && res.status !== 404) throw new Error(`Bunny Storage DELETE failed: ${res.status}`);
  }
  publicUrlFor(path) {
    return `${this.publicUrl}/${path}`;
  }
}
