/**
 * Osmosis gRPC client.
 *
 * Every Osmosis read and write uses Polkachu's public gRPC endpoint; there is
 * no REST, LCD, or Tendermint-RPC fallback.
 *
 * @module services/osmosisGrpcService
 */

import { config } from "../config";
import { CosmosGrpcService } from "./cosmosGrpcService";

export type {
	GrpcDeposit as OsmosisDeposit,
	GrpcDepositScan as OsmosisDepositScan,
	GrpcTransaction as OsmosisTransaction,
	GrpcTransfer as OsmosisTransfer,
} from "./cosmosGrpcService";

export const OsmosisGrpcService = new CosmosGrpcService({
	label: "Osmosis",
	grpcUrl: config.osmosis.grpcUrl,
	chainId: config.osmosis.chainId,
	addressPrefix: "osmo",
	gasPrice: config.osmosis.withdrawalGasPrice,
	gasLimit: config.osmosis.withdrawalGasLimit,
	gasDenom: "uosmo",
	confirmTimeoutMs: config.osmosis.confirmTimeoutMs,
	mnemonic: config.userFundsMnemonic,
});
