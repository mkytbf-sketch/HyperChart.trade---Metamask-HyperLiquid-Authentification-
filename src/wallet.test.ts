/**
 * EXTRAIT de app/src/core.test.ts : les blocs consacrés à MetaMask, recopiés tels quels
 * (lignes 890–976, lignes 1013–1025). Seules les importations sont réécrites.
 */
import { describe, expect, it } from 'vitest';
import { ExchangeClient } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import { agentName, limitWire, metamaskSigner, permittedIn, revokeNamedAgent } from './hyperliquid';

describe('autorisation de l’agent Hyperliquid par MetaMask', () => {
  it('demande la signature directement à MetaMask, avec le type exigé par Hyperliquid', async () => {
    const owner = '0x1111111111111111111111111111111111111111';
    const calls: { method: string; params?: unknown[] }[] = [];
    const eth = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        calls.push({ method, params });
        if (method === 'eth_chainId') return '0xa4b1';
        if (method === 'eth_signTypedData_v4') return `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
        throw new Error(method);
      },
    };
    const sent: unknown[] = [];
    const transport = {
      isTestnet: false,
      request: async (_e: string, payload: unknown) => (sent.push(payload), { status: 'ok', response: { type: 'default' } }),
    };
    const master = new ExchangeClient({ transport: transport as never, wallet: metamaskSigner(eth as never, owner) });
    await master.approveAgent({ agentAddress: '0x2222222222222222222222222222222222222222', agentName: 'HyperDashboard' });
    const sign = calls.find(c => c.method === 'eth_signTypedData_v4')!;
    expect(sign.params![0]).toBe(owner);
    const typed = JSON.parse(sign.params![1] as string);
    expect(typed.primaryType).toBe('HyperliquidTransaction:ApproveAgent');
    expect(typed.domain.chainId).toBe(42161);
    expect(typed.message).toMatchObject({
      hyperliquidChain: 'Mainnet',
      agentAddress: '0x2222222222222222222222222222222222222222',
      agentName: 'HyperDashboard',
    });
    expect(sent[0]).toMatchObject({
      action: { type: 'approveAgent', signatureChainId: '0xa4b1', hyperliquidChain: 'Mainnet' },
      signature: { v: 27 },
    });
  });

  it('révoque l’agent en le remplaçant, sous le même nom, par un agent à la clé jetée', async () => {
    const owner = '0x1111111111111111111111111111111111111111';
    const eth = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0xa4b1';
        if (method === 'eth_signTypedData_v4') return `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
        throw new Error(method);
      },
    };
    const sent: { action: { type: string; agentAddress: string; agentName: string } }[] = [];
    const transport = {
      isTestnet: false,
      request: async (_e: string, payload: never) => (sent.push(payload), { status: 'ok', response: { type: 'default' } }),
    };
    const master = new ExchangeClient({ transport: transport as never, wallet: metamaskSigner(eth as never, owner) });
    const now = 1_800_000_000_000;
    await revokeNamedAgent(master, now);
    await revokeNamedAgent(master, now);
    expect(sent).toHaveLength(2);
    for (const { action } of sent) {
      expect(action.type).toBe('approveAgent');
      // Même nom que l'agent de trading : Hyperliquid désinscrit alors l'ancien. Validité d'une heure.
      expect(action.agentName).toBe(`HyperDashboard valid_until ${now + 3_600_000}`);
      expect(action.agentName).toBe(agentName(now + 3_600_000));
      expect(action.agentAddress).toMatch(/^0x[0-9a-f]{40}$/);
      expect(action.agentAddress).not.toBe(`0x${'0'.repeat(40)}`);
      expect(action.agentAddress).not.toBe(owner);
    }
    // Une clé neuve à chaque révocation, que personne ne garde.
    expect(sent[0].action.agentAddress).not.toBe(sent[1].action.agentAddress);
  });

  it('ne dit pas l’agent révoqué quand Hyperliquid refuse', async () => {
    const master = { approveAgent: async () => Promise.reject(new Error('refus')) };
    await expect(revokeNamedAgent(master as never)).rejects.toThrow('refus');
  });

  it('signe un ordre avec le portefeuille agent local, sans appel réseau', async () => {
    const sent: { signature: { r: string; s: string; v: number } }[] = [];
    const transport = {
      isTestnet: false,
      request: async (_e: string, payload: unknown) => (
        sent.push(payload as never),
        { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 1 } }] } } }
      ),
    };
    const agent = new ExchangeClient({ transport: transport as never, wallet: privateKeyToAccount(`0x${'ab'.repeat(32)}`) });
    const r = await agent.order({ orders: [limitWire({ index: 0, szDecimals: 5, maxLeverage: 40 }, true, 0.001, 60000)], grouping: 'na' });
    expect(r.response.data.statuses[0]).toEqual({ resting: { oid: 1 } });
    expect(sent[0].signature.r).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('Comptes connectés à MetaMask', () => {
  it('lit toutes les adresses autorisées dans la permission eth_accounts, en forme normalisée', () => {
    const a = '0x00000000000000000000000000000000000000aa';
    const b = '0x00000000000000000000000000000000000000bb';
    const perms = [
      { parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [a, b, 'pas une adresse'] }] },
      { parentCapability: 'endowment:permitted-chains', caveats: [{ type: 'restrictNetworkSwitching', value: ['0x1'] }] },
    ];
    expect(permittedIn(perms)).toEqual([getAddress(a), getAddress(b)]);
    expect(permittedIn(null)).toEqual([]);
    expect(permittedIn([{ parentCapability: 'eth_accounts' }])).toEqual([]);
  });
});
