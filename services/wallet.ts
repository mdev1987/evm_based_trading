import WalletManagerEvm from "@tetherto/wdk-wallet-evm";

import type { ChainConfig, TradingMode } from "./config";
import { config } from "./config";
import {
  createZeroExExecutionProtocol,
  executeAndWaitZeroExSwap,
  getZeroExSwapStatus,
  submitZeroExSwap,
  waitForZeroExSwap,
  type ZeroExQuoteParams,
  type ZeroExSwapResult,
  type ZeroExSwapStatus,
} from "./zero_ex";

/** WDK account type returned by the EVM wallet manager. */
export type EvmWalletAccount = Awaited<ReturnType<WalletManagerEvm["getAccount"]>>;

export type WalletBalances = {
  /** Trading-base balance in the configured base asset's smallest units. */
  baseRaw: bigint;
  /** Native gas balance in the native asset's smallest units. */
  nativeRaw: bigint;
};

/**
 * Live WDK wallet adapter.
 *
 * A separate WDK wallet manager/account is maintained per enabled chain. The
 * mnemonic remains inside the wallet library and is never persisted by this
 * application.
 */
export class EvmWalletService {
  private readonly managers = new Map<string, WalletManagerEvm>();
  private readonly accounts = new Map<string, EvmWalletAccount>();

  constructor(
    private readonly mnemonic: string,
    private readonly accountIndex: number,
    private readonly walletConfig: typeof config,
  ) {
    if (!mnemonic) throw new Error("Live wallet requires MNEMONIC");
  }

  /** Return or lazily create the configured account for one chain. */
  async getAccount(chain: ChainConfig): Promise<EvmWalletAccount> {
    const existing = this.accounts.get(chain.key);
    if (existing) return existing;

    const manager = new WalletManagerEvm(this.mnemonic, {
      provider: chain.rpcUrl,
      chainId: chain.chainId,
    });
    const account = await manager.getAccount(this.accountIndex);

    this.managers.set(chain.key, manager);
    this.accounts.set(chain.key, account);
    return account;
  }

  /** Return the public wallet address for one configured chain. */
  async getAddress(chain: ChainConfig): Promise<string> {
    return this.getAccount(chain).then((account) => account.getAddress());
  }

  /** Read the trading base balance and native gas balance. */
  async getBalances(chain: ChainConfig): Promise<WalletBalances> {
    const account = await this.getAccount(chain);
    const nativeRaw = await account.getBalance();

    if (chain.baseIsNative) {
      return { baseRaw: nativeRaw, nativeRaw };
    }

    const baseRaw = await account.getTokenBalance(chain.baseToken);
    return { baseRaw, nativeRaw };
  }

  /** Read an ERC-20 token balance for position reconciliation. */
  async getTokenBalance(chain: ChainConfig, tokenAddress: string): Promise<bigint> {
    return this.getAccount(chain).then((account) => account.getTokenBalance(tokenAddress));
  }

  /** Submit a live same-chain swap and return immediately after submission. */
  async submitSwap(
    chain: ChainConfig,
    params: Omit<ZeroExQuoteParams, "chainId">,
  ): Promise<ZeroExSwapResult> {
    const account = await this.getAccount(chain);
    return submitZeroExSwap(account, { ...params, chainId: chain.chainId });
  }

  /** Read the on-chain state of a previously submitted live swap. */
  async getSwapStatus(
    chain: ChainConfig,
    swapId: ZeroExSwapResult["id"],
  ): Promise<ZeroExSwapStatus> {
    const account = await this.getAccount(chain);
    return getZeroExSwapStatus(account, chain.chainId, swapId);
  }

  /** Wait for a previously submitted live swap using the configured timeout. */
  async waitForSwap(
    chain: ChainConfig,
    swapId: ZeroExSwapResult["id"],
  ): Promise<ZeroExSwapStatus> {
    const account = await this.getAccount(chain);
    const protocol = createZeroExExecutionProtocol(chain.chainId, account);
    return waitForZeroExSwap(
      protocol,
      swapId,
      this.walletConfig.execution.pollIntervalMs,
      this.walletConfig.execution.timeoutMs,
    );
  }

  /**
   * Submit a live same-chain swap through 0x and wait for confirmation.
   *
   * Approval handling remains inside the WDK 0x protocol module. This service
   * does not construct Settler or other approval transactions itself.
   */
  async executeSwap(
    chain: ChainConfig,
    params: Omit<ZeroExQuoteParams, "chainId">,
  ): Promise<{ result: ZeroExSwapResult; status?: ZeroExSwapStatus }> {
    const account = await this.getAccount(chain);
    return executeAndWaitZeroExSwap(
      account,
      { ...params, chainId: chain.chainId },
      {
        wait: true,
        pollIntervalMs: this.walletConfig.execution.pollIntervalMs,
        timeoutMs: this.walletConfig.execution.timeoutMs,
      },
    );
  }

  /** Dispose wallet managers and clear retained account objects. */
  dispose(): void {
    for (const manager of this.managers.values()) manager.dispose();
    this.managers.clear();
    this.accounts.clear();
  }

  /** Construct the live wallet adapter only for live mode. */
  static forMode(mode: TradingMode): EvmWalletService | undefined {
    if (mode !== "live") return undefined;
    return new EvmWalletService(config.mnemonic, config.walletAccountIndex, config);
  }
}
