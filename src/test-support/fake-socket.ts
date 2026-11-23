/**
 * WebSocket factice pour les tests (à poser par `vi.stubGlobal('WebSocket', FakeSocket)`) : garde chaque connexion
 * ouverte, les messages envoyés, et permet d'en recevoir. `live()` compte les connexions encore ouvertes : après un
 * changement d'actif, aucune connexion de l'ancien actif ne doit rester.
 */
export class FakeSocket {
  static all: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(m: string): void {
    this.sent.push(JSON.parse(m));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  /** Connexions pas encore fermées. */
  static live(): FakeSocket[] {
    return FakeSocket.all.filter(s => s.readyState !== 3);
  }
}

/** Stockage local factice (Map), pour `vi.stubGlobal('localStorage', memoryStorage())`. */
export function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: k => map.get(k) ?? null,
    key: i => [...map.keys()][i] ?? null,
    removeItem: k => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}
