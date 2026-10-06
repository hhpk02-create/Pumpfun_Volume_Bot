import { telegramController } from './src/telegram';
import { 
    Keypair, Connection, LAMPORTS_PER_SOL, Transaction, 
    SystemProgram, sendAndConfirmTransaction, PublicKey,
    VersionedTransaction 
} from '@solana/web3.js';
import { 
    createCloseAccountInstruction, 
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    getAssociatedTokenAddress
} from '@solana/spl-token';
import * as fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as bs58Module from 'bs58';
const bs58 = (bs58Module as any).default || bs58Module;

// --- CONFIGURAÇÃO ---
const bot = telegramController.bot;
// Helius: commitment 'processed' para confirmação rápida e menor descarte de tx
const connection = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", {
    commitment: 'processed',
    confirmTransactionInitialTimeout: 60000,
});
const mainKeyPair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
const allowedUserId = "5429370200";

const PERMANENT_LOG = path.resolve(process.cwd(), 'permanent_log.txt');
const LAST_TOKEN_CA_FILE = path.resolve(process.cwd(), 'last_token_ca.txt');

let subWallets: Keypair[] = [];
let isVolumeRunning = false;
let lastTokenCA = "";
let currentWalletIndex = 0; // Usado no modo pump (sequencial)

// Modos: 'human' | 'pump'
let operationMode: 'human' | 'pump' = 'human';

// Rastreamento de PnL
let initialSubWalletsBalanceLamports = 0;
let totalSpentOnBuysSOL = 0; 

const safeSendMessage = (chatId: number, text: string) => bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() => {});

// --- 🛡️ SISTEMA DE BACKUP ---
const saveToBackup = (wallet: Keypair) => {
    const key = bs58.encode(wallet.secretKey);
    const logEntry = `[${new Date().toLocaleString()}] Pub: ${wallet.publicKey.toBase58()} | Priv: ${key}\n`;
    fs.appendFileSync(PERMANENT_LOG, logEntry, 'utf8');
};

// Regex: extrai chaves privadas (base58) ignorando datas e texto "Priv: "
const loadWalletsFromLog = () => {
    if (fs.existsSync(PERMANENT_LOG)) {
        try {
            const content = fs.readFileSync(PERMANENT_LOG, 'utf8');
            // Captura base58 (86-90 chars) - ignora datas, "Priv: ", prefixos
            const regex = /(?:Priv:?\s*)?([1-9A-HJ-NP-Za-km-z]{86,90})\b/g;
            const foundKeys = [...content.matchAll(regex)].map(m => m[1]);
            const uniqueKeys = [...new Set(foundKeys)];
            subWallets = uniqueKeys.map(key => Keypair.fromSecretKey(bs58.decode(key)));
            console.log(`✅ [MEMÓRIA] ${subWallets.length} carteiras carregadas do permanent_log.txt`);
        } catch (e) { console.log("❌ Erro ao ler log:", (e as Error).message); }
    }
};

loadWalletsFromLog();

async function getTotalSubWalletsBalanceLamports(): Promise<number> {
    let total = 0;
    for (const w of subWallets) {
        total += await connection.getBalance(w.publicKey);
    }
    return total;
}

// Envio agressivo: múltiplos retries rápidos para não descartar tx
const SELL_RETRIES = 5;
const RETRY_DELAY_MS = 150;
const MIN_SOL_FOR_GAS_LAMPORTS = Math.floor(0.001 * LAMPORTS_PER_SOL);

/** Mint Pump/SPL em PublicKey; evita throw de `new PublicKey` com CA inválido ou vazio. */
function parseMintPublicKey(tokenCA: string): PublicKey | null {
    const s = (tokenCA || "").trim();
    if (!s) return null;
    try {
        return new PublicKey(s);
    } catch {
        return null;
    }
}

async function sendRawTransactionWithRetries(serializedTx: Buffer): Promise<string> {
    let lastError: Error | null = null;
    for (let i = 0; i < SELL_RETRIES; i++) {
        try {
            const sig = await connection.sendRawTransaction(serializedTx, {
                skipPreflight: true,
                maxRetries: 0,
                preflightCommitment: 'processed',
            });
            return sig;
        } catch (e) {
            lastError = e as Error;
            if (i < SELL_RETRIES - 1) {
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }
    throw lastError || new Error('Envio falhou após retries');
}

/** trade-local: tenta pool pump; em HTTP 400 repete com raydium (migração Pump → AMM). */
async function axiosTradeLocalWithPoolFallback(
    bodyWithoutPool: Record<string, unknown>,
    logPrefix: string
): Promise<Buffer> {
    const pools = ['pump', 'raydium'] as const;
    let lastError: unknown;
    for (const pool of pools) {
        try {
            const res = await axios.post(
                `https://pumpportal.fun/api/trade-local`,
                { ...bodyWithoutPool, pool },
                { responseType: 'arraybuffer' }
            );
            return Buffer.from(res.data);
        } catch (e: any) {
            lastError = e;
            const status = e?.response?.status;
            if (status === 400 && pool === 'pump') {
                try {
                    const d = e.response.data;
                    const detail =
                        Buffer.isBuffer(d) ? d.toString('utf8')
                        : d instanceof ArrayBuffer ? Buffer.from(new Uint8Array(d)).toString('utf8')
                        : typeof d === 'string' ? d
                        : typeof d === 'object' && d !== null ? JSON.stringify(d)
                        : String(d);
                    console.log(`${logPrefix} Detalhe do Erro 400 (pool=pump):`, detail);
                } catch {
                    console.log(`${logPrefix} Detalhe do Erro 400 (pool=pump): (corpo ilegível)`);
                }
                console.log(`${logPrefix} pool=pump rejeitado; a tentar pool=raydium...`);
                continue;
            }
            throw e;
        }
    }
    throw lastError;
}

// --- 🔥 VENDA FORÇADA (slippage 100%, priorityFee mínimo) ---
async function forceSell(wallet: Keypair, tokenCA: string) {
    const shortAddr = wallet.publicKey.toBase58().slice(0, 8);
    console.log("DEBUG: Tentando vender o token " + tokenCA);
    try {
        const mintPk = parseMintPublicKey(tokenCA);
        if (!mintPk) {
            console.log(`❌ [VENDA ${shortAddr}] Mint inválido ou vazio (PublicKey). CA: ${String(tokenCA).slice(0, 24)}`);
            return;
        }
        const solForGas = await connection.getBalance(wallet.publicKey);
        if (solForGas < MIN_SOL_FOR_GAS_LAMPORTS) {
            console.log(`⏭️ [VENDA ${shortAddr}] Não há gás suficiente (saldo < 0.001 SOL); venda ignorada.`);
            return;
        }
        const ata = await getAssociatedTokenAddress(mintPk, wallet.publicKey);
        const bal = await connection.getTokenAccountBalance(ata).catch((e) => {
            console.log(`❌ [VENDA ${shortAddr}] Falha ao obter saldo ATA: ${(e as Error).message}`);
            return { value: { amount: "0" } };
        });
        if (Number(bal.value.amount) <= 0) {
            console.log(`⏭️ [VENDA ${shortAddr}] Saldo zero, ignorando.`);
            return;
        }

        const mintBase58 = mintPk.toBase58();
        const buf = await axiosTradeLocalWithPoolFallback(
            {
                publicKey: wallet.publicKey.toBase58(),
                action: 'sell',
                mint: mintBase58,
                amount: '100%',
                denominatedInSol: 'false',
                slippage: 100,
                priorityFee: 0.0008,
            },
            `[VENDA ${shortAddr}]`
        );
        const tx = VersionedTransaction.deserialize(buf);
        tx.sign([wallet]);
        await sendRawTransactionWithRetries(Buffer.from(tx.serialize()));
        console.log(`✅ [VENDA] Wallet ${shortAddr} tx enviada.`);
    } catch (e: any) {
        const msg = e?.message || String(e);
        const reason = e?.logs ? ` | Logs: ${JSON.stringify(e.logs).slice(0, 200)}` : '';
        console.log(`❌ [VENDA ${shortAddr}] Falha: ${msg}${reason}`);
    }
}

// --- 🛒 COMPRA (100% compras reais, sem wash trade) ---
const BUY_PRIORITY_FEE_SOL = 0.0001;
/** Lamports reservados (assinatura + margem) antes do valor nominal da compra. */
const BUY_RESERVED_LAMPORTS = 2_000_000;
/** SOL extra para garantir amount um pouco abaixo do saldo − priority fee. */
const BUY_SPEND_MARGIN_SOL = 0.00005;

async function performTrade(chatId: number, tokenCA: string, buyVal: number) {
    if (!isVolumeRunning || subWallets.length === 0) return;
    const isHuman = operationMode === 'human';
    const wallet = isHuman ? subWallets[Math.floor(Math.random() * subWallets.length)] : subWallets[currentWalletIndex];
    const actualBuyVal = isHuman ? buyVal * (0.6 + Math.random() * 0.8) : buyVal; // human: ±40%, pump: fixo
    const delayMs = isHuman ? Math.floor(Math.random() * 10000 + 5000) : Math.floor(Math.random() * 2000 + 2000); // human: 5–15s, pump: 2–4s
    const shortAddr = wallet.publicKey.toBase58().slice(0, 8);
    try {
        const balance = await connection.getBalance(wallet.publicKey);
        const minTradeBalanceLamports = 0.001 * LAMPORTS_PER_SOL;
        if (balance < minTradeBalanceLamports) {
            console.log(`⏹️ [COMPRA ${shortAddr}] Saldo < 0.001 SOL — trade desta wallet cancelado (evita loop de erro 400).`);
            if (!isHuman) currentWalletIndex = (currentWalletIndex + 1) % subWallets.length;
            if (isVolumeRunning) setTimeout(() => performTrade(chatId, tokenCA, buyVal), delayMs);
            return;
        }
        const maxSafeBuy = Math.max(0, (balance - 2_000_000) / LAMPORTS_PER_SOL);
        let effectiveBuyVal = actualBuyVal;
        if (effectiveBuyVal > maxSafeBuy) effectiveBuyVal = maxSafeBuy;
        const priorityLamports = Math.ceil(BUY_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL);
        const marginLamports = Math.ceil(BUY_SPEND_MARGIN_SOL * LAMPORTS_PER_SOL);
        const maxSpendLamports = balance - BUY_RESERVED_LAMPORTS - priorityLamports - marginLamports;
        const maxAffordableSol = Math.max(0, maxSpendLamports) / LAMPORTS_PER_SOL;
        const spendSol = Math.min(effectiveBuyVal, maxAffordableSol);
        if (maxAffordableSol <= 0 || spendSol <= 0) {
            console.log(`❌ [COMPRA ${shortAddr}] Saldo insuficiente após reserva (max ~${Math.max(0, maxAffordableSol).toFixed(7)} SOL útil).`);
            if (!isHuman) currentWalletIndex = (currentWalletIndex + 1) % subWallets.length;
            if (isVolumeRunning) setTimeout(() => performTrade(chatId, tokenCA, buyVal), delayMs);
            return;
        }
        const requiredLamports = Math.ceil(spendSol * LAMPORTS_PER_SOL) + BUY_RESERVED_LAMPORTS;
        if (balance < requiredLamports) {
            console.log(`❌ [COMPRA ${shortAddr}] Saldo insuficiente: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL (precisa ≥ ${(requiredLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
            if (!isHuman) currentWalletIndex = (currentWalletIndex + 1) % subWallets.length;
            if (isVolumeRunning) setTimeout(() => performTrade(chatId, tokenCA, buyVal), delayMs);
            return;
        }
        const amountStr = spendSol.toFixed(7);
        const spendRecorded = parseFloat(amountStr);
        console.log('Comprando Token: ', tokenCA);
        const buf = await axiosTradeLocalWithPoolFallback(
            {
                publicKey: wallet.publicKey.toBase58(),
                action: 'buy',
                mint: tokenCA,
                denominatedInSol: 'true',
                amount: amountStr,
                slippage: 150,
                priorityFee: BUY_PRIORITY_FEE_SOL,
            },
            `[COMPRA ${shortAddr}]`
        );
        const tx = VersionedTransaction.deserialize(buf);
        tx.sign([wallet]);
        await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            preflightCommitment: 'processed',
        });
        totalSpentOnBuysSOL += spendRecorded;
        console.log(`🛒 [COMPRA OK] [${operationMode}] Wallet ${shortAddr} | ${amountStr} SOL | próx em ${(delayMs / 1000).toFixed(0)}s`);
    } catch (e: any) {
        if (e?.response) {
            try {
                const d = e.response.data;
                const detail =
                    Buffer.isBuffer(d) ? d.toString('utf8')
                    : d instanceof ArrayBuffer ? Buffer.from(new Uint8Array(d)).toString('utf8')
                    : typeof d === 'string' ? d
                    : typeof d === 'object' && d !== null ? JSON.stringify(d)
                    : String(d);
                console.log('Detalhe do Erro 400:', detail);
            } catch {
                console.log('Detalhe do Erro 400: (corpo não convertível)', e.response?.status);
            }
        }
        const msg = e?.message || String(e);
        const reason = e?.logs ? ` | Logs: ${JSON.stringify(e.logs).slice(0, 200)}` : '';
        console.log(`❌ [COMPRA ${shortAddr}] Falha RPC/API: ${msg}${reason}`);
    }
    if (!isHuman) currentWalletIndex = (currentWalletIndex + 1) % subWallets.length;
    if (isVolumeRunning) setTimeout(() => performTrade(chatId, tokenCA, buyVal), delayMs);
}

// --- ⌨️ COMANDOS ---

bot.onText(/\/help/, (msg) => {
    const helpText = `📖 *MENU DE COMANDOS*

━━━━━━━━━━━━━━━━━━━━
🚀 *Volume e Trades*
━━━━━━━━━━━━━━━━━━━━

\`/start_pump CA SOL\`
Inicia volume com compras reais na Pump\.fun
_Ex:_ \`/start_pump EdmAYMCDaFDehrqPiv33vwmoKXFsccWKVApoacfpump 0\.01\`

\`/stop\`
Para o volume imediatamente

\`/sell_all\`
Para o volume e vende 100% dos tokens \(último CA\) em todas as sub\-wallets\. Slippage 100%\. Exibe resumo PnL\.

━━━━━━━━━━━━━━━━━━━━
⚙️ *Modos de Operação*
━━━━━━━━━━━━━━━━━━━━

\`/mode_human\` — Hype humanizado
5–15s entre compras, valores ±40%, carteira aleatória

\`/mode_pump\` — Velocidade máxima
2–4s entre compras, valor fixo, ordem sequencial

━━━━━━━━━━━━━━━━━━━━
💰 *Wallets e Resgate*
━━━━━━━━━━━━━━━━━━━━

\`/distribute_pump qtd SOL\`
Cria sub\-wallets e distribui SOL da main
_Ex:_ \`/distribute_pump 10 0\.02\` \(admin\)

\`/collect\`
Recolhe SOL das sub\-wallets para a main\. Mantém 5k lamports em cada\. Recarrega log\.

\`/burn_everything\`
Fecha todas as ATAs, resgata Rent \(~0\.002 SOL cada\), transfere SOL para a main\. Preserva \`permanent\_log\.txt\` \(admin\)

━━━━━━━━━━━━━━━━━━━━
📊 *Info*
━━━━━━━━━━━━━━━━━━━━

\`/status\`
Saldo main, qtd de wallets, modo ativo e intensidade de hype

\`/help\`
Exibe este menu`;
    safeSendMessage(msg.chat.id, helpText);
});

function setOperationMode(mode: 'human' | 'pump') {
    operationMode = mode;
    const label = mode === 'human' ? 'Humanizado' : 'Pump';
    const desc = mode === 'human' ? '5–15s | ±40% valor | aleatório' : '2–4s | valor fixo | sequencial';
    console.log(`\n🔄 [MODO] Alterado para: ${label} (${desc})\n`);
}

bot.onText(/\/mode_human/, (msg) => {
    setOperationMode('human');
    safeSendMessage(msg.chat.id, "🧑 Modo *Humanizado* ativo.\n_Intervalo 5–15s | Valores ±40% | Carteira aleatória_");
});

bot.onText(/\/mode_pump/, (msg) => {
    setOperationMode('pump');
    safeSendMessage(msg.chat.id, "⚡ Modo *Pump* ativo.\n_Intervalo 2–4s | Valor fixo | Carteiras sequenciais_");
});

// 100% compras reais — sem wash trade, sem simulação
bot.onText(/\/start_pump ([a-zA-Z0-9]+) (\d+\.?\d*)/, async (msg, match) => {
    lastTokenCA = match![1].trim();
    try {
        fs.writeFileSync(LAST_TOKEN_CA_FILE, lastTokenCA, 'utf8');
    } catch (e) {
        console.log('⚠️ Falha ao gravar last_token_ca.txt:', (e as Error).message);
    }
    isVolumeRunning = true;
    currentWalletIndex = 0;
    totalSpentOnBuysSOL = 0;
    initialSubWalletsBalanceLamports = await getTotalSubWalletsBalanceLamports();
    performTrade(msg.chat.id, lastTokenCA, parseFloat(match![2]));
    safeSendMessage(msg.chat.id, `🚀 Volume Iniciado \\(modo: *${operationMode === 'human' ? 'Humanizado' : 'Pump'}*\\)`);
});

bot.onText(/\/stop/, (msg) => {
    isVolumeRunning = false;
    safeSendMessage(msg.chat.id, "⏹️ Volume parado.");
});

bot.onText(/\/sell_all/, async (msg) => {
    let mintForSell = lastTokenCA.trim();
    if (!mintForSell) {
        try {
            if (fs.existsSync(LAST_TOKEN_CA_FILE)) {
                mintForSell = fs.readFileSync(LAST_TOKEN_CA_FILE, 'utf8').trim();
            }
        } catch (e) {
            console.log('⚠️ Erro ao ler last_token_ca.txt:', (e as Error).message);
        }
    }
    if (!parseMintPublicKey(mintForSell)) {
        safeSendMessage(
            msg.chat.id,
            '⚠️ *Nenhum CA de token definido.*\n\nExecute antes \\`/start_pump\\` com o mint e o valor em SOL, depois \\`/sell_all\\`\\. Se o bot reiniciou, o último mint gravado em disco é recuperado quando o arquivo existe; caso contrário, inicie o pump novamente com o CA correto.'
        );
        return;
    }
    lastTokenCA = mintForSell;
    isVolumeRunning = false;
    const balanceBeforeSells = await getTotalSubWalletsBalanceLamports();
    for (const w of subWallets) await forceSell(w, mintForSell);
    await new Promise(r => setTimeout(r, 5000));
    const balanceAfterSells = await getTotalSubWalletsBalanceLamports();
    const receivedLamports = balanceAfterSells - balanceBeforeSells;
    const receivedSOL = receivedLamports / LAMPORTS_PER_SOL;
    const spentSOL = totalSpentOnBuysSOL;
    const pnlSOL = receivedSOL - spentSOL;
    const pnlPct = spentSOL > 0 ? (pnlSOL / spentSOL) * 100 : 0;
    const pnlEmoji = pnlSOL >= 0 ? "📈" : "📉";
    const summaryMsg = `✅ *Fim da venda*

💰 *Resumo PnL*
• Gastos na compra: \`${spentSOL.toFixed(6)}\` SOL
• Recebidos na venda: \`${receivedSOL.toFixed(6)}\` SOL
• ${pnlEmoji} *PnL:* \`${pnlSOL >= 0 ? "+" : ""}${pnlSOL.toFixed(6)}\` SOL (\`${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%\`)`;
    safeSendMessage(msg.chat.id, summaryMsg);
    console.log(`\n📊 [PnL] Gastos: ${spentSOL.toFixed(6)} SOL | Recebidos: ${receivedSOL.toFixed(6)} SOL | ${pnlEmoji} PnL: ${pnlSOL >= 0 ? "+" : ""}${pnlSOL.toFixed(6)} SOL (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n`);
});

const MIN_FEE_LAMPORTS = 10000; // 0.00001 SOL mínimo para taxa
const GAS_FUNDING_LAMPORTS = 100000; // 0.0001 SOL que Main envia se sub-wallet zerada
const RENT_LEAVE_LAMPORTS = 1_500_000; // 0.0015 SOL na conta (acima do rent 0.00089)
const MIN_BAL_TO_TRANSFER = 2_000_000; // 0.002 SOL — só transfere se bal > isso

// Entra em cada carteira do permanent_log.txt, fecha todas as ATAs (Rent) e envia SOL para a Main
bot.onText(/\/burn_everything/, async (msg) => {
    if (msg.from?.id.toString() !== allowedUserId) return;
    isVolumeRunning = false;
    loadWalletsFromLog();
    const walletsToProcess = [...subWallets];
    if (walletsToProcess.length === 0) {
        safeSendMessage(msg.chat.id, "⚠️ Nenhuma carteira em \`permanent_log.txt\` para processar.");
        return;
    }
    safeSendMessage(msg.chat.id, `🔥 Processando ${walletsToProcess.length} carteiras do permanent_log...`);
    let totalAtasClosed = 0;
    let totalSolToMain = 0;
    const mainBefore = await connection.getBalance(mainKeyPair.publicKey);
    for (const wallet of walletsToProcess) {
        const shortAddr = wallet.publicKey.toBase58().slice(0, 8);
        try {
            const [splAccounts, token2022Accounts, balanceLamports] = await Promise.all([
                connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }),
                connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
                connection.getBalance(wallet.publicKey)
            ]);
            const allAtas: { pubkey: PublicKey; programId: typeof TOKEN_PROGRAM_ID | typeof TOKEN_2022_PROGRAM_ID }[] = [];
            for (const a of splAccounts.value) allAtas.push({ pubkey: a.pubkey, programId: TOKEN_PROGRAM_ID });
            for (const a of token2022Accounts.value) allAtas.push({ pubkey: a.pubkey, programId: TOKEN_2022_PROGRAM_ID });
            if (allAtas.length > 0 && balanceLamports < MIN_FEE_LAMPORTS) {
                const fundTx = new Transaction().add(
                    SystemProgram.transfer({ fromPubkey: mainKeyPair.publicKey, toPubkey: wallet.publicKey, lamports: GAS_FUNDING_LAMPORTS })
                );
                await sendAndConfirmTransaction(connection, fundTx, [mainKeyPair]);
                console.log(`🔥 [BURN] Wallet ${shortAddr} | Main enviou 0.0001 SOL para gás`);
            }
            const BATCH = 5;
            for (let i = 0; i < allAtas.length; i += BATCH) {
                const batch = allAtas.slice(i, i + BATCH);
                const closeTx = new Transaction();
                for (const acc of batch) {
                    closeTx.add(createCloseAccountInstruction(acc.pubkey, mainKeyPair.publicKey, wallet.publicKey, [], acc.programId));
                }
                try {
                    await sendAndConfirmTransaction(connection, closeTx, [wallet]);
                    totalAtasClosed += batch.length;
                    console.log(`🔥 [BURN] Wallet ${shortAddr} | ${batch.length} ATA(s) fechada(s), Rent → Main`);
                } catch (txErr: any) {
                    if (txErr?.logs) console.log(`❌ [BURN ${shortAddr}] Logs (fechar ATA):\n${txErr.logs.join('\n')}`);
                    throw txErr;
                }
            }
            const bal = await connection.getBalance(wallet.publicKey);
            if (bal > MIN_BAL_TO_TRANSFER) {
                const lamportsToSend = bal - RENT_LEAVE_LAMPORTS;
                const transferTx = new Transaction().add(
                    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: mainKeyPair.publicKey, lamports: lamportsToSend })
                );
                try {
                    await sendAndConfirmTransaction(connection, transferTx, [wallet]);
                    totalSolToMain += lamportsToSend / LAMPORTS_PER_SOL;
                    console.log(`🔥 [BURN] Wallet ${shortAddr} | ${(lamportsToSend / LAMPORTS_PER_SOL).toFixed(6)} SOL → Main (restou 0.0015 SOL)`);
                } catch (txErr: any) {
                    if (txErr?.logs) console.log(`❌ [BURN ${shortAddr}] Logs (transfer SOL):\n${txErr.logs.join('\n')}`);
                    throw txErr;
                }
            } else if (bal > 0) {
                console.log(`🔥 [BURN] Wallet ${shortAddr} | Saldo residual mantido para evitar erro de Rent (${(bal / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
            }
        } catch (e: any) {
            console.log(`❌ [BURN ${shortAddr}] Falha: ${e?.message || e}`);
            if (e?.logs) console.log(`❌ [BURN ${shortAddr}] Logs completos:\n${e.logs.join('\n')}`);
        }
    }
    const mainAfter = await connection.getBalance(mainKeyPair.publicKey);
    const receivedTotal = (mainAfter - mainBefore) / LAMPORTS_PER_SOL;
    const summary = `✅ *Burn concluído*

📋 Carteiras processadas: ${walletsToProcess.length}
🔒 ATAs fechadas: ${totalAtasClosed}
💰 SOL enviado à Main: \`${totalSolToMain.toFixed(6)}\` SOL
📈 Main recebeu no total: \`${receivedTotal.toFixed(6)}\` SOL

\`permanent_log.txt\` preservado\.`;
    safeSendMessage(msg.chat.id, summary);
    subWallets = [];
    loadWalletsFromLog();
});

bot.onText(/\/distribute_pump (\d+) (\d+\.?\d*)/, async (msg, match) => {
    if (msg.from?.id.toString() !== allowedUserId) return;
    subWallets = [];
    const qtd = parseInt(match![1]); const amount = parseFloat(match![2]);
    for (let i = 0; i < qtd; i++) {
        const nw = Keypair.generate(); saveToBackup(nw);
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: mainKeyPair.publicKey, toPubkey: nw.publicKey, lamports: Math.floor(amount * LAMPORTS_PER_SOL)}));
        const { blockhash } = await connection.getLatestBlockhash(); tx.recentBlockhash = blockhash;
        await sendAndConfirmTransaction(connection, tx, [mainKeyPair]);
        subWallets.push(nw);
    }
    safeSendMessage(msg.chat.id, `✅ ${qtd} Wallets Prontas.`);
});

bot.onText(/\/collect/, async (msg) => {
    isVolumeRunning = false;
    for (const w of subWallets) {
        try {
            const bal = await connection.getBalance(w.publicKey);
            if (bal > 5000) {
                const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: mainKeyPair.publicKey, lamports: bal - 5000 }));
                await sendAndConfirmTransaction(connection, tx, [w]);
            }
        } catch (e) {}
    }
    subWallets = [];
    loadWalletsFromLog();
    safeSendMessage(msg.chat.id, "🏁 Resgate concluído.");
});

bot.onText(/\/status/, async (msg) => {
    const bal = await connection.getBalance(mainKeyPair.publicKey);
    const modoLabel = operationMode === 'human' ? 'Humanizado' : 'Pump';
    const intensidade = operationMode === 'human' ? 'Baixa (5–15s)' : 'Alta (2–4s)';
    safeSendMessage(msg.chat.id, `🤖 *STATUS*

💰 Main: \`${(bal/LAMPORTS_PER_SOL).toFixed(6)}\` SOL
👥 Wallets: ${subWallets.length}

📌 Modo: *${modoLabel}*
📊 Intensidade Hype: \`${intensidade}\``);
});

console.log("\n🚀 CÓDIGO COMPLETO COM /BURN_EVERYTHING ONLINE!");