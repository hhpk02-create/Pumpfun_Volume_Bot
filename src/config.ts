import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

export const connection = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

export const userKeypair = Keypair.fromSecretKey(
    bs58.decode(process.env.PRIVATE_KEY || "")
);

export const TELEGRAM_BOT_TOKEN: string = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_ALLOWED_USER_IDS: any = (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
  .split(',')
  .map(id => id.trim())
  .map(id => (isNaN(Number(id)) ? id : Number(id)));

// CONFIGURAÇÃO PARA SALDO BAIXO (0.04 SOL)
export const DefaultCA = "EdmAYMCDaFDehrqPiv33vwmoKXFsccWKVApoacfpump"; 
export const DefaultSlippage = 0.25; // 25% para garantir que a compra passe
export const DefaultJitoTipAmountLamports = 10000; // Gorjeta mínima (0.00001 SOL)
export const DefaultDistributeAmountLamports = 5000000; // 0.005 SOL (Suficiente para 1 sub-wallet testar)