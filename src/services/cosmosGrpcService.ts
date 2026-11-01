/**
 * Cosmos SDK gRPC client, used for every chain read and write.
 *
 * Each supported chain gets one instance with its own endpoint, signer, and
 * address prefix. There is deliberately no REST or Tendermint-RPC fallback:
 * the configured gRPC endpoint is the single supported transport.
 *
 * @module services/cosmosGrpcService
 */

import {
	DirectSecp256k1HdWallet,
	encodePubkey,
	makeAuthInfoBytes,
	makeSignDoc,
} from "@cosmjs/proto-signing";
import * as grpc from "@grpc/grpc-js";
import { BaseAccount } from "cosmjs-types/cosmos/auth/v1beta1/auth";
import { QueryClientImpl as AuthQueryClientImpl } from "cosmjs-types/cosmos/auth/v1beta1/query";
import { QueryClientImpl as BankQueryClientImpl } from "cosmjs-types/cosmos/bank/v1beta1/query";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { ServiceClientImpl as TendermintServiceClientImpl } from "cosmjs-types/cosmos/base/tendermint/v1beta1/query";
import {
	BroadcastMode,
	GetTxsEventRequest,
	OrderBy,
	ServiceClientImpl as TxServiceClientImpl,
} from "cosmjs-types/cosmos/tx/v1beta1/service";
import { TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import type { Rpc } from "cosmjs-types/helpers";
import { logger } from "../utils/logger";
import { normalizeTxHash } from "../utils/txHash";

/** Configuration for one chain's gRPC client. */
export interface CosmosGrpcOptions {
	/** Human label used in logs and errors. */
	label: string;
	/** gRPC host:port (plaintext). */
	grpcUrl: string;
	/** Chain id used in the sign doc. */
	chainId: string;
	/** Bech32 address prefix. */
	addressPrefix: string;
	/** Gas price string, e.g. "0.075ujuno". */
	gasPrice: string;
	/** Gas limit for a MsgSend. */
	gasLimit: number;
	/** Fee denom, e.g. "ujuno". */
	gasDenom: string;
	/** How long to wait for a broadcast tx to be indexed. */
	confirmTimeoutMs: number;
	/** BIP39 mnemonic for signing (optional). */
	mnemonic?: string;
	/** Explicit wallet address; authoritative when set. */
	configuredAddress?: string;
}

/** A token transfer decoded from a MsgSend. */
export interface GrpcTransfer {
	denom: string;
	amountMicro: number;
	from: string;
	to: string;
}

/** A transaction as the bot needs it, independent of the transport encoding. */
export interface GrpcTransaction {
	hash: string;
	code: number;
	height: number;
	memo: string;
	transfers: GrpcTransfer[];
}

/** A deposit candidate found by the event indexer. */
export interface GrpcDeposit {
	txHash: string;
	amountMicro: number;
	fromAddress: string;
	memo: string;
	height: number;
}

/** A scan result plus the highest height that is safe to resume from. */
export interface GrpcDepositScan {
	deposits: GrpcDeposit[];
	nextHeight: number;
}

interface GrpcAccount {
	address: string;
	pubkey: Uint8Array;
	accountNumber: number;
	sequence: number;
}

export class CosmosGrpcService {
	private client: grpc.Client | null = null;
	private rpc: Rpc | null = null;
	private wallet: DirectSecp256k1HdWallet | null = null;
	private address = "";

	constructor(private readonly options: CosmosGrpcOptions) {}

	/** Create the plaintext channel and the chain-prefixed signer. */
	async initialize(): Promise<void> {
		if (!this.client) {
			this.client = new grpc.Client(
				this.options.grpcUrl,
				grpc.credentials.createInsecure(),
			);
			this.rpc = {
				request: (service, method, data) =>
					new Promise<Uint8Array>((resolve, reject) => {
						const client = this.client;
						if (!client) {
							reject(
								new Error(
									`${this.options.label} gRPC client is not initialized`,
								),
							);
							return;
						}
						client.makeUnaryRequest(
							`/${service}/${method}`,
							(value: Uint8Array) => Buffer.from(value),
							(value: Buffer) => Buffer.from(value),
							Buffer.from(data),
							new grpc.Metadata(),
							{ deadline: Date.now() + 10_000 },
							(error: grpc.ServiceError | null, value?: Buffer) => {
								if (error) reject(error);
								else resolve(value ?? Buffer.alloc(0));
							},
						);
					}),
			};
		}

		let derivedAddress = "";
		if (this.options.mnemonic) {
			try {
				const wallet = await DirectSecp256k1HdWallet.fromMnemonic(
					this.options.mnemonic,
					{ prefix: this.options.addressPrefix },
				);
				const accounts = await wallet.getAccounts();
				derivedAddress = accounts[0]?.address ?? "";
				this.wallet = wallet;
			} catch (error) {
				logger.error(
					`Failed to derive ${this.options.label} wallet from mnemonic`,
					error,
				);
			}
		}

		const configuredAddress = this.options.configuredAddress ?? "";
		this.address = configuredAddress || derivedAddress;

		// An explicit address is authoritative. A mismatch would sign from a
		// different key than the one being scanned, so refuse to sign.
		if (
			configuredAddress &&
			derivedAddress &&
			configuredAddress !== derivedAddress
		) {
			logger.error(
				`${this.options.label} configured address does not match the mnemonic-derived address; signing disabled`,
				{ configured: configuredAddress, derived: derivedAddress },
			);
			this.wallet = null;
		}

		if (this.address) {
			logger.info(`${this.options.label} gRPC service initialized`, {
				address: this.address,
				hasSigningCapability: !!this.wallet,
				endpoint: this.options.grpcUrl,
			});
		}
	}

	/** The wallet address used for deposits (empty when not configured). */
	getAddress(): string {
		return this.address;
	}

	private getRpc(): Rpc {
		if (!this.rpc) {
			throw new Error(`${this.options.label} gRPC service is not initialized`);
		}
		return this.rpc;
	}

	private bankClient(): BankQueryClientImpl {
		return new BankQueryClientImpl(this.getRpc());
	}

	private authClient(): AuthQueryClientImpl {
		return new AuthQueryClientImpl(this.getRpc());
	}

	private txClient(): TxServiceClientImpl {
		return new TxServiceClientImpl(this.getRpc());
	}

	/** Current chain height, or null when the endpoint is unreachable. */
	async getLatestHeight(): Promise<number | null> {
		try {
			const response = await new TendermintServiceClientImpl(
				this.getRpc(),
			).GetLatestBlock();
			const height = Number(response.block?.header?.height ?? 0);
			return height > 0 ? height : null;
		} catch (error) {
			logger.error(
				`Failed to query ${this.options.label} latest height via gRPC`,
				{ error },
			);
			return null;
		}
	}

	/** Balance of one denom in integer micro-units, or null on failure. */
	async getBalanceMicro(
		address: string,
		denom: string,
	): Promise<number | null> {
		try {
			const response = await this.bankClient().Balance({ address, denom });
			return response.balance
				? Number.parseInt(response.balance.amount, 10)
				: 0;
		} catch (error) {
			logger.error(`Failed to query ${this.options.label} balance via gRPC`, {
				address,
				denom,
				error,
			});
			return null;
		}
	}

	/** Fetch a transaction by hash, including its transfer events. */
	async fetchTransaction(txHash: string): Promise<GrpcTransaction | null> {
		try {
			const response = await this.txClient().GetTx({
				hash: normalizeTxHash(txHash),
			});
			const txResponse = response.txResponse;
			if (!txResponse) return null;

			return {
				hash: normalizeTxHash(txResponse.txhash || txHash),
				code: Number(txResponse.code ?? 0),
				height: Number(txResponse.height ?? 0),
				memo: response.tx?.body?.memo ?? "",
				transfers: this.transfersFromResponse(
					txResponse.events,
					response.tx?.body?.messages,
				),
			};
		} catch (error) {
			// NOT_FOUND is expected while a freshly broadcast tx is still pending.
			logger.debug(`${this.options.label} GetTx failed`, { txHash, error });
			return null;
		}
	}

	/**
	 * Scan recent transactions paying `address` through the node's tx event
	 * index. Returns oldest-first deposits at or above `lastHeight`.
	 */
	async fetchRecentDeposits(
		address: string,
		denom: string,
		lastHeight: number,
		limit = 100,
	): Promise<GrpcDepositScan> {
		if (!address) return { deposits: [], nextHeight: lastHeight };

		const deposits: GrpcDeposit[] = [];
		let highestScanned = lastHeight;

		try {
			// Scan oldest-first above the watermark. If a backlog exceeds the page
			// cap, the watermark advances to the highest row actually fetched, so
			// the next scan continues from there instead of skipping rows.
			// This node honours the top-level page/limit pair; `pagination` is
			// ignored by its tx-search implementation.
			for (let page = 0; page < 10; page++) {
				let response: Awaited<
					ReturnType<ReturnType<typeof this.txClient>["GetTxsEvent"]>
				>;
				try {
					response = await this.txClient().GetTxsEvent(
						GetTxsEventRequest.fromPartial({
							// This node exposes the newer `query` field (Cosmos SDK 0.50+).
							// The inclusive height bound re-reads a boundary block split
							// across pages; processed hashes dedupe the overlap.
							query: `transfer.recipient='${address}' AND tx.height >= ${lastHeight}`,
							page: BigInt(page + 1),
							limit: BigInt(limit),
							orderBy: OrderBy.ORDER_BY_ASC,
						}),
					);
				} catch (error) {
					// tx-search reports an error when the requested page is past the
					// end. That is a normal stop condition, not a scan failure.
					if (
						page > 0 &&
						/page should be within/i.test(
							error instanceof Error ? error.message : String(error),
						)
					) {
						break;
					}
					throw error;
				}

				const responses = response.txResponses ?? [];
				const txs = response.txs ?? [];
				if (responses.length === 0) break;

				for (let i = 0; i < responses.length; i++) {
					const txResponse = responses[i];
					const height = Number(txResponse.height ?? 0);
					highestScanned = Math.max(highestScanned, height);

					if (height < lastHeight) continue;
					if (Number(txResponse.code ?? 0) !== 0) continue;

					const transfers = this.transfersFromResponse(
						txResponse.events,
						txs[i]?.body?.messages,
					).filter(
						(transfer) => transfer.to === address && transfer.denom === denom,
					);
					if (transfers.length === 0) continue;

					const amountMicro = transfers.reduce(
						(total, transfer) => total + transfer.amountMicro,
						0,
					);
					if (amountMicro <= 0) continue;

					deposits.push({
						txHash: normalizeTxHash(txResponse.txhash),
						amountMicro,
						fromAddress: transfers[0].from,
						memo: txs[i]?.body?.memo ?? "",
						height,
					});
				}

				if (responses.length < limit) break;
				if (page === 9) {
					logger.warn(
						`${this.options.label} deposit scan hit its page cap; the next scan resumes above the highest fetched row`,
						{ address, lastHeight, scanned: deposits.length },
					);
				}
			}

			return { deposits, nextHeight: highestScanned };
		} catch (error) {
			logger.error(`Failed to scan ${this.options.label} deposits via gRPC`, {
				address,
				denom,
				error,
			});
			return { deposits, nextHeight: highestScanned };
		}
	}

	/**
	 * Sign and broadcast a MsgSend over gRPC using SYNC mode.
	 *
	 * The fee is paid in the chain's gas denom from the bot wallet. Returns the
	 * CheckTx response; callers get the hash even if inclusion is still pending.
	 */
	async sendTokens(
		toAddress: string,
		amountMicro: number,
		denom: string,
		memo = "",
	): Promise<{
		txHash: string;
		code: number;
		rawLog: string;
	}> {
		const wallet = this.wallet;
		const address = this.address;
		if (!wallet || !address) {
			throw new Error(`${this.options.label} signing wallet is not configured`);
		}

		const account = await this.getAccount(address);
		const msg = MsgSend.fromPartial({
			fromAddress: address,
			toAddress,
			amount: [{ denom, amount: amountMicro.toString() }],
		});
		const messages = [
			{
				typeUrl: "/cosmos.bank.v1beta1.MsgSend",
				value: MsgSend.encode(msg).finish(),
			},
		];
		const bodyBytes = TxBody.encode(
			TxBody.fromPartial({ messages, memo }),
		).finish();

		const pubkey = encodePubkey({
			type: "tendermint/PubKeySecp256k1",
			value: Buffer.from(account.pubkey).toString("base64"),
		});
		const feeAmount = this.computeGasFee();
		const gasBalance = await this.getBalanceMicro(
			address,
			this.options.gasDenom,
		);
		if (gasBalance === null) {
			throw new Error(
				`Unable to verify the ${this.options.label} gas balance; try again later`,
			);
		}
		if (gasBalance < feeAmount) {
			throw new Error(
				`${this.options.label} wallet has insufficient ${this.options.gasDenom} for the withdrawal gas fee`,
			);
		}
		const authInfoBytes = makeAuthInfoBytes(
			[{ pubkey, sequence: account.sequence }],
			[{ denom: this.options.gasDenom, amount: feeAmount.toString() }],
			this.options.gasLimit,
			undefined,
			undefined,
		);
		const signDoc = makeSignDoc(
			bodyBytes,
			authInfoBytes,
			this.options.chainId,
			account.accountNumber,
		);
		const { signature, signed } = await wallet.signDirect(address, signDoc);
		const txRaw = TxRaw.fromPartial({
			bodyBytes: signed.bodyBytes,
			authInfoBytes: signed.authInfoBytes,
			signatures: [Buffer.from(signature.signature, "base64")],
		});

		const response = await this.txClient().BroadcastTx({
			txBytes: TxRaw.encode(txRaw).finish(),
			mode: BroadcastMode.BROADCAST_MODE_SYNC,
		});

		const txResponse = response.txResponse;
		if (!txResponse) {
			throw new Error(`${this.options.label} broadcast returned no response`);
		}

		return {
			txHash: txResponse.txhash,
			code: Number(txResponse.code ?? 0),
			rawLog: txResponse.rawLog ?? "",
		};
	}

	/** Wait until a broadcast tx is indexed, or the timeout expires. */
	async waitForTransaction(
		txHash: string,
		timeoutMs = this.options.confirmTimeoutMs,
	): Promise<GrpcTransaction | null> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const tx = await this.fetchTransaction(txHash);
			if (tx) return tx;
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
		return null;
	}

	private transfersFromResponse(
		events?: Array<{
			type: string;
			attributes: Array<{ key: string; value: string }>;
		}>,
		messages?: Array<{ typeUrl: string; value: Uint8Array }>,
	): GrpcTransfer[] {
		const fromEvents = this.parseTransferEvents(events);
		// Events are the canonical view: they also cover MsgMultiSend and
		// authz-wrapped MsgSend, which message decoding alone would miss.
		return fromEvents.length > 0 ? fromEvents : this.parseTransfers(messages);
	}

	private parseTransferEvents(
		events?: Array<{
			type: string;
			attributes: Array<{ key: string; value: string }>;
		}>,
	): GrpcTransfer[] {
		const transfers: GrpcTransfer[] = [];
		for (const event of events ?? []) {
			if (event.type !== "transfer") continue;

			const senders: string[] = [];
			const recipients: string[] = [];
			const amounts: string[] = [];
			for (const attribute of event.attributes) {
				if (attribute.key === "sender") senders.push(attribute.value);
				else if (attribute.key === "recipient")
					recipients.push(attribute.value);
				else if (attribute.key === "amount") amounts.push(attribute.value);
			}

			for (let i = 0; i < amounts.length; i++) {
				for (const coin of amounts[i].split(",")) {
					const match = coin.match(/^(\d+)([a-zA-Z][a-zA-Z0-9/:._-]*)$/);
					if (!match) continue;
					const amountMicro = Number.parseInt(match[1], 10);
					if (!Number.isSafeInteger(amountMicro)) continue;
					transfers.push({
						denom: match[2],
						amountMicro,
						from: senders[i] ?? "",
						to: recipients[i] ?? "",
					});
				}
			}
		}
		return transfers;
	}

	private parseTransfers(
		messages?: Array<{ typeUrl: string; value: Uint8Array }>,
	): GrpcTransfer[] {
		const transfers: GrpcTransfer[] = [];
		for (const message of messages ?? []) {
			if (message.typeUrl !== "/cosmos.bank.v1beta1.MsgSend") continue;
			const send = MsgSend.decode(message.value);
			for (const coin of send.amount) {
				const amountMicro = Number.parseInt(coin.amount, 10);
				if (!Number.isSafeInteger(amountMicro)) continue;
				transfers.push({
					denom: coin.denom,
					amountMicro,
					from: send.fromAddress,
					to: send.toAddress,
				});
			}
		}
		return transfers;
	}

	private async getAccount(address: string): Promise<GrpcAccount> {
		const response = await this.authClient().Account({ address });
		const any = response.account;
		if (!any) {
			throw new Error(`${this.options.label} account not found: ${address}`);
		}
		if (any.typeUrl !== "/cosmos.auth.v1beta1.BaseAccount") {
			throw new Error(
				`Unsupported ${this.options.label} account type: ${any.typeUrl}`,
			);
		}

		const base = BaseAccount.decode(any.value);
		const wallet = this.wallet;
		if (!wallet) {
			throw new Error(`${this.options.label} signing wallet is not configured`);
		}
		const accountData = (await wallet.getAccounts()).find(
			(account) => account.address === address,
		);
		if (!accountData) {
			throw new Error(`${this.options.label} signer does not hold ${address}`);
		}

		return {
			address,
			pubkey: accountData.pubkey,
			accountNumber: Number(base.accountNumber),
			sequence: Number(base.sequence),
		};
	}

	private computeGasFee(): number {
		const match = this.options.gasPrice.match(
			/^(\d+(?:\.\d+)?)\s*([a-zA-Z][a-zA-Z0-9/:._-]*)$/,
		);
		if (!match) {
			throw new Error(
				`Invalid ${this.options.label} withdrawal gas price: ${this.options.gasPrice}`,
			);
		}
		const gasPrice = Number.parseFloat(match[1]);
		if (!Number.isFinite(gasPrice) || gasPrice < 0) {
			throw new Error(
				`${this.options.label} withdrawal gas price must be non-negative`,
			);
		}
		if (match[2] !== this.options.gasDenom) {
			throw new Error(
				`${this.options.label} withdrawal gas price must be denominated in ${this.options.gasDenom}`,
			);
		}
		return Math.ceil(gasPrice * this.options.gasLimit);
	}
}
