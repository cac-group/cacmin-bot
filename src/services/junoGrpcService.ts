/**
 * Juno gRPC client.
 *
 * Every Juno read and write uses Polkachu's public gRPC endpoint; there is no
 * REST, LCD, or Tendermint-RPC fallback.
 *
 * @module services/junoGrpcService
 */

import { config } from "../config";
import { CosmosGrpcService } from "./cosmosGrpcService";

export type {
	GrpcDeposit as JunoDeposit,
	GrpcDepositScan as JunoDepositScan,
	GrpcTransaction as JunoTransaction,
	GrpcTransfer as JunoTransfer,
} from "./cosmosGrpcService";

export const JunoGrpcService = new CosmosGrpcService({
	label: "Juno",
	grpcUrl: config.juno.grpcUrl,
	chainId: config.juno.chainId,
	addressPrefix: "juno",
	gasPrice: config.chain.withdrawalGasPrice,
	gasLimit: config.chain.withdrawalGasLimit,
	gasDenom: "ujuno",
	confirmTimeoutMs: config.juno.confirmTimeoutMs,
	mnemonic: config.userFundsMnemonic,
	configuredAddress: config.userFundsAddress,
});
