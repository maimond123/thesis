declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
      isMetaMask?: boolean;
    };
  }
}

export interface AnchorResult {
  txHash: string;
  chainId: string;
  from: string;
}

export async function anchorHashOnChain(commitHash: string): Promise<AnchorResult> {
  if (!window.ethereum) {
    throw new Error('No wallet found. Install MetaMask or another browser wallet.');
  }

  // Request account access
  const accounts = (await window.ethereum.request({
    method: 'eth_requestAccounts',
  })) as string[];

  if (!accounts || accounts.length === 0) {
    throw new Error('No account connected');
  }

  const from = accounts[0];

  // Get current chain
  const chainId = (await window.ethereum.request({
    method: 'eth_chainId',
  })) as string;

  // Send 0-value tx to self with commitment hash as calldata
  // Prefix with 0x if not already
  const data = commitHash.startsWith('0x') ? commitHash : `0x${commitHash}`;

  const txHash = (await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{
      from,
      to: from,
      value: '0x0',
      data,
    }],
  })) as string;

  return { txHash, chainId, from };
}

export function explorerUrl(txHash: string, chainId: string): string {
  const id = parseInt(chainId, 16);
  switch (id) {
    case 1: return `https://etherscan.io/tx/${txHash}`;
    case 8453: return `https://basescan.org/tx/${txHash}`;
    case 10: return `https://optimistic.etherscan.io/tx/${txHash}`;
    case 42161: return `https://arbiscan.io/tx/${txHash}`;
    case 137: return `https://polygonscan.com/tx/${txHash}`;
    case 11155111: return `https://sepolia.etherscan.io/tx/${txHash}`;
    case 84532: return `https://sepolia.basescan.org/tx/${txHash}`;
    default: return '';
  }
}

export function chainName(chainId: string): string {
  const id = parseInt(chainId, 16);
  switch (id) {
    case 1: return 'Ethereum';
    case 8453: return 'Base';
    case 10: return 'Optimism';
    case 42161: return 'Arbitrum';
    case 137: return 'Polygon';
    case 11155111: return 'Sepolia';
    case 84532: return 'Base Sepolia';
    default: return `Chain ${id}`;
  }
}
