# Telegram Crypto Trading Bot

A Telegram bot for trading across multiple platforms including Solana, Hyperliquid, and Polymarket.

## Features

- Multi-platform trading (Solana, Hyperliquid, Polymarket)
- Limit orders with automated execution
- Secure wallet management via Privy
- Real-time price data and balance tracking
- Private key export with encryption

## Installation

1. Clone the repository:
   ```bash
   git clone <your-repo-url>
   cd telegram-crypto-trading-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

4. Start the bot:
   ```bash
   npm start
   ```

## Usage

- `/start` - Initialize wallets
- `/trade <platform> <buy/sell> <amount> <asset>` - Execute trades
- `/balance` - Check balances
- `/orders` - View limit orders
- `/help` - Show all commands

## Supported Platforms

- **Solana** - Token swaps via Jupiter Ultra
- **Hyperliquid** - Perpetual futures (supports testnet)
- **Polymarket** - Prediction markets

## Configuration

Required environment variables:
- `TELEGRAM_BOT_TOKEN` - Your Telegram bot token
- `PRIVY_APP_ID` - Privy application ID
- `PRIVY_APP_SECRET` - Privy application secret
- `PRIVY_AUTH_KEY_ID` - Privy authorization key ID
- `PRIVY_AUTH_KEY_PRIVATE` - Privy authorization key

Optional:
- `HYPERLIQUID_TESTNET=true` - Use Hyperliquid testnet
- `JUPITER_API_KEY` - Jupiter API key for higher rate limits

## Disclaimer

This software is for educational purposes only. Trading cryptocurrencies involves significant risk of loss. Use at your own risk and test thoroughly before trading with real funds.
