import TelegramBot from 'node-telegram-bot-api';
import * as dotenv from 'dotenv';
import path from 'path';

// Força o carregamento do .env da raiz do projeto
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export class TelegramController {
    public bot: TelegramBot;
    private static instance: TelegramController;

    private constructor() {
        // AJUSTADO PARA O NOME DO SEU .ENV
        const token = process.env.TELEGRAM_BOT_TOKEN; 
        
        if (!token) {
            throw new Error("TELEGRAM_BOT_TOKEN não encontrado. Verifique seu arquivo .env");
        }

        this.bot = new TelegramBot(token, { polling: true });

        this.bot.on('polling_error', (error: any) => {
            if (!error.message.includes('409 Conflict')) {
                console.error(`[Telegram Error]: ${error.message}`);
            }
        });

        console.log("✅ TelegramController initialized.");
    }

    public static getInstance(): TelegramController {
        if (!TelegramController.instance) {
            TelegramController.instance = new TelegramController();
        }
        return TelegramController.instance;
    }
}

export const telegramController = TelegramController.getInstance();