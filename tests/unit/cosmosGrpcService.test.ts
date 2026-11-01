import { describe, expect, it, vi } from "vitest";
import { BaseAccount } from "cosmjs-types/cosmos/auth/v1beta1/auth";
import { QueryAccountResponse } from "cosmjs-types/cosmos/auth/v1beta1/query";
import { QueryBalanceResponse } from "cosmjs-types/cosmos/bank/v1beta1/query";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import {
	BroadcastMode,
	BroadcastTxRequest,
	BroadcastTxResponse,
} from "cosmjs-types/cosmos/tx/v1beta1/service";
import {
	AuthInfo,
	TxBody,
	TxRaw,
} from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { TxResponse } from "cosmjs-types/cosmos/base/abci/v1beta1/abci";
import { Any } from "cosmjs-types/google/protobuf/any";
import { CosmosGrpcService } from "../../src/services/cosmosGrpcService";

const ADDRESS = `juno1${"a".repeat(38)}`;
const RECIPIENT = `juno1${"b".repeat(38)}`;

describe("CosmosGrpcService.sendTokens", () => {
	it("signs and broadcasts a correctly-fee'd MsgSend over gRPC", async () => {
		const service = new CosmosGrpcService({
			label: "Juno",
			grpcUrl: "juno-grpc.example.com:12690",
			chainId: "juno-1",
			addressPrefix: "juno",
			gasPrice: "0.075ujuno",
			gasLimit: 130000,
			gasDenom: "ujuno",
			confirmTimeoutMs: 1000,
		});

		let broadcast: BroadcastTxRequest | undefined;
		let signDoc: any;
		(service as any).address = ADDRESS;
		(service as any).wallet = {
			getAccounts: vi.fn().mockResolvedValue([
				{
					address: ADDRESS,
					pubkey: new Uint8Array(33).fill(1),
				},
			]),
			signDirect: vi.fn().mockImplementation(async (_address, doc) => {
				signDoc = doc;
				return {
					signature: {
						pub_key: { type: "tendermint/PubKeySecp256k1", value: "AA==" },
						signature: Buffer.alloc(64).toString("base64"),
					},
					signed: {
						bodyBytes: doc.bodyBytes,
						authInfoBytes: doc.authInfoBytes,
					},
				};
			}),
		};
		(service as any).rpc = {
			request: vi.fn(
				async (
					serviceName: string,
					method: string,
					data: Uint8Array,
				): Promise<Uint8Array> => {
					if (serviceName === "cosmos.auth.v1beta1.Query") {
						const account = BaseAccount.fromPartial({
							address: ADDRESS,
							accountNumber: 7n,
							sequence: 3n,
						});
						return QueryAccountResponse.encode(
							QueryAccountResponse.fromPartial({
								account: Any.fromPartial({
									typeUrl: "/cosmos.auth.v1beta1.BaseAccount",
									value: BaseAccount.encode(account).finish(),
								}),
							}),
						).finish();
					}
					if (serviceName === "cosmos.bank.v1beta1.Query") {
						return QueryBalanceResponse.encode(
							QueryBalanceResponse.fromPartial({
								balance: { denom: "ujuno", amount: "1000000000" },
							}),
						).finish();
					}
					if (method === "BroadcastTx") {
						broadcast = BroadcastTxRequest.decode(data);
						return BroadcastTxResponse.encode(
							BroadcastTxResponse.fromPartial({
								txResponse: TxResponse.fromPartial({
									txhash: "ABC123",
									code: 0,
								}),
							}),
						).finish();
					}
					throw new Error(`unexpected ${serviceName}/${method}`);
				},
			),
		};

		const result = await service.sendTokens(
			RECIPIENT,
			10_000_000,
			"ujuno",
			"Withdrawal for user 1",
		);

		expect(result).toEqual({ txHash: "ABC123", code: 0, rawLog: "" });
		expect(broadcast?.mode).toBe(BroadcastMode.BROADCAST_MODE_SYNC);
		expect(signDoc.chainId).toBe("juno-1");
		expect(signDoc.accountNumber).toBe(7n);

		const txRaw = TxRaw.decode(broadcast!.txBytes);
		const body = TxBody.decode(txRaw.bodyBytes);
		expect(body.memo).toBe("Withdrawal for user 1");
		expect(body.messages).toHaveLength(1);
		expect(body.messages[0].typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
		const send = MsgSend.decode(body.messages[0].value);
		expect(send.toAddress).toBe(RECIPIENT);
		expect(send.amount).toEqual([{ denom: "ujuno", amount: "10000000" }]);

		const authInfo = AuthInfo.decode(txRaw.authInfoBytes);
		expect(authInfo.signerInfos[0].sequence).toBe(3n);
		expect(authInfo.signerInfos[0].publicKey?.typeUrl).toBe(
			"/cosmos.crypto.secp256k1.PubKey",
		);
		expect(authInfo.fee?.amount).toEqual([
			{ denom: "ujuno", amount: "9750" },
		]);
		expect(authInfo.fee?.gasLimit).toBe(130000n);
	});
});
