import { describe, expect, it, vi } from "vitest";
import { TxResponse } from "cosmjs-types/cosmos/base/abci/v1beta1/abci";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import {
	GetTxsEventRequest,
	GetTxsEventResponse,
} from "cosmjs-types/cosmos/tx/v1beta1/service";
import { Tx, TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { OsmosisGrpcService } from "../../src/services/osmosisGrpcService";
import { CAC_DENOM } from "../../src/tokens";

const ADDRESS = `osmo1${"a".repeat(38)}`;

function txAt(height: number, hash: string) {
	const send = MsgSend.fromPartial({
		fromAddress: `osmo1${"b".repeat(38)}`,
		toAddress: ADDRESS,
		amount: [{ denom: CAC_DENOM, amount: "2500000" }],
	});
	return {
		tx: Tx.fromPartial({
			body: TxBody.fromPartial({
				messages: [
					{
						typeUrl: "/cosmos.bank.v1beta1.MsgSend",
						value: MsgSend.encode(send).finish(),
					},
				],
				memo: "123456",
			}),
		}),
		response: TxResponse.fromPartial({
			height: BigInt(height),
			txhash: hash,
			code: 0,
		}),
	};
}

describe("OsmosisGrpcService transfer parsing", () => {
	it("reads transfer events even when messages are not plain MsgSend", () => {
		const transfers = (OsmosisGrpcService as any).transfersFromResponse(
			[
				{
					type: "transfer",
					attributes: [
						{ key: "sender", value: "osmo1a" },
						{ key: "recipient", value: "osmo1b" },
						{ key: "amount", value: `2500000${CAC_DENOM}` },
					],
				},
			],
			[],
		);

		expect(transfers).toEqual([
			{
				denom: CAC_DENOM,
				amountMicro: 2_500_000,
				from: "osmo1a",
				to: "osmo1b",
			},
		]);
	});
});

describe("OsmosisGrpcService.fetchRecentDeposits", () => {
	it("credits a transfer event even without a decodable MsgSend", async () => {
		(OsmosisGrpcService as any).rpc = {
			request: vi.fn(async (): Promise<Uint8Array> => {
				return GetTxsEventResponse.encode(
					GetTxsEventResponse.fromPartial({
						txs: [],
						txResponses: [
							TxResponse.fromPartial({
								height: 10n,
								txhash: "c".repeat(64),
								code: 0,
								events: [
									{
										type: "transfer",
										attributes: [
											{ key: "sender", value: "osmo1a", index: false },
											{ key: "recipient", value: ADDRESS, index: false },
											{
												key: "amount",
												value: `2500000${CAC_DENOM}`,
												index: false,
											},
										],
									},
								],
							}),
						],
					}),
				).finish();
			}),
		};

		const scan = await OsmosisGrpcService.fetchRecentDeposits(
			ADDRESS,
			CAC_DENOM,
			10,
			100,
		);

		expect(scan.deposits).toHaveLength(1);
		expect(scan.deposits[0]).toMatchObject({
			amountMicro: 2_500_000,
			fromAddress: "osmo1a",
			height: 10,
		});
	});

	it("keeps an inclusive watermark so a block split across pages is not dropped", async () => {
		const first = txAt(100, "a".repeat(64));
		const second = txAt(100, "b".repeat(64));

		(OsmosisGrpcService as any).rpc = {
			request: vi.fn(
				async (
					_service: string,
					_method: string,
					data: Uint8Array,
				): Promise<Uint8Array> => {
					const request = GetTxsEventRequest.decode(data);
					expect(request.query).toBe(
						`transfer.recipient='${ADDRESS}' AND tx.height >= 100`,
					);
					if (request.page === 1n) {
						return GetTxsEventResponse.encode(
							GetTxsEventResponse.fromPartial({
								txs: [first.tx],
								txResponses: [first.response],
							}),
						).finish();
					}
					if (request.page === 2n) {
						return GetTxsEventResponse.encode(
							GetTxsEventResponse.fromPartial({
								txs: [second.tx],
								txResponses: [second.response],
							}),
						).finish();
					}
					throw new Error("page should be within [1, 2] range, given 3");
				},
			),
		};

		const scan = await OsmosisGrpcService.fetchRecentDeposits(
			ADDRESS,
			CAC_DENOM,
			100,
			1,
		);

		expect(scan.deposits).toHaveLength(2);
		expect(scan.deposits.map((entry) => entry.height)).toEqual([100, 100]);
		expect(scan.nextHeight).toBe(100);
	});
});
