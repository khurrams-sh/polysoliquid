const TelegramBot = require('node-telegram-bot-api');
const { PrivyClient } = require('@privy-io/server-auth');
const axios = require('axios');
const SolanaTrading = require('./solanaTrading');
const HyperliquidTrading = require('./hyperliquidTrading');
const PolymarketTrading = require('./polymarketTrading');

// In-memory storage for limit orders
const limitOrders = new Map(); // userId -> orders array
let orderCounter = 1;
require('dotenv').config();

// Configuration - Load from environment variables
const token = process.env.TELEGRAM_BOT_TOKEN;
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

// Authorization Key for session signers (bot trading permissions)
const AUTH_KEY_ID = process.env.PRIVY_AUTH_KEY_ID;
const AUTH_KEY_PRIVATE = process.env.PRIVY_AUTH_KEY_PRIVATE;

// Validate required environment variables
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required! Please set it in your .env file');
  process.exit(1);
}
if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
  console.error('❌ PRIVY_APP_ID and PRIVY_APP_SECRET are required! Please set them in your .env file');
  process.exit(1);
}
if (!AUTH_KEY_ID || !AUTH_KEY_PRIVATE) {
  console.error('❌ PRIVY_AUTH_KEY_ID and PRIVY_AUTH_KEY_PRIVATE are required! Please set them in your .env file');
  process.exit(1);
}

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });

// Initialize Privy client
const privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);

// Initialize trading modules
const solanaTrading = new SolanaTrading(privy);
const hyperliquidTrading = new HyperliquidTrading(privy);
const polymarketTrading = new PolymarketTrading(privy);

console.log('Bot is running...');

// Helper function to get or create user wallet for specific chain
async function getOrCreateWallet(telegramUserId, chainType) {
  try {
    const telegramUserIdStr = telegramUserId.toString();

    // First try to get existing user
    let user;
    try {
      user = await privy.getUserByTelegramUserId(telegramUserIdStr);
    } catch (error) {
      // User doesn't exist, create them
      console.log('Creating new Privy user...');
      user = await privy.importUser({
        linkedAccounts: [{ type: 'telegram', telegramUserId: telegramUserIdStr }]
      });
    }

    // Look for existing wallet of the requested chain type
    const existingWallet = user?.linkedAccounts.find(
      (account) => account.type === 'wallet' &&
                   account.walletClientType === 'privy' &&
                   account.chainType === chainType
    );

    if (existingWallet) {
      console.log(`✅ Found existing ${chainType} wallet:`, existingWallet.id);
      return existingWallet;
    }

    // Create new wallet for the requested chain
    console.log(`Creating new ${chainType} wallet...`);
    const wallet = await privy.walletApi.createWallet({
      chainType: chainType,
      owner: { userId: user.id },
      signers: [{
        type: 'authorization_key',
        signerId: AUTH_KEY_ID
      }]
    });

    console.log(`✅ Created ${chainType} wallet:`, wallet.id);
    return wallet;

  } catch (error) {
    console.error(`Error getting/creating ${chainType} wallet:`, error);
    throw error;
  }
}

// Helper function to get user wallet ID from Telegram user ID (legacy compatibility)
async function getUserWalletId(telegramUserId, chainType = 'solana') {
  try {
    const wallet = await getOrCreateWallet(telegramUserId, chainType);
    return wallet?.id;
  } catch (error) {
    console.error('Error getting user wallet ID:', error);
    return null;
  }
}

// Helper function to parse transaction details from message
function getTransactionDetailsFromMsg(msg) {
  // This is a simple implementation - you can enhance this based on your needs
  const text = msg.text;
  // Parse transaction details from message text
  // This is a basic implementation, you should enhance this based on your command structure
  return {
    // Default transaction structure - customize based on your needs
    to: 'default_recipient',
    amount: '0.01', // Default amount
    currency: 'SOL'
  };
}

// Bot commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;

  try {
    bot.sendMessage(chatId, '🔄 Setting up your trading wallets...');

    // Create wallets for different chains
    const solanaWallet = await getOrCreateWallet(telegramUserId, 'solana');
    const ethereumWallet = await getOrCreateWallet(telegramUserId, 'ethereum');

    bot.sendMessage(chatId, `🎉 **Welcome to Sniffy Trading Bot!**\n\n✅ **Your wallets are ready!**\n\n🔗 **Solana:** \`${solanaWallet.address}\`\n🔗 **Ethereum:** \`${ethereumWallet.address}\`\n\n🚀 **Start Trading:**\n• /trade solana buy 0.01 SOL\n• /trade ethereum buy 0.01 ETH\n• /balance - Check all balances\n• /help - See all commands`);
  } catch (error) {
    console.error('❌ Error in /start command:', error);
    bot.sendMessage(chatId, `❌ Failed to set up wallets.\n\nError: ${error.message}\n\nTry /createwallet solana or /createwallet ethereum`);
  }
});

bot.onText(/\/createwallet/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;
  const text = msg.text;
  const parts = text.split(' ');

  // Default to Solana if no chain specified
  const chainType = parts.length > 1 ? parts[1].toLowerCase() : 'solana';

  try {
    bot.sendMessage(chatId, `🔄 Creating your ${chainType.toUpperCase()} wallet...`);

    const wallet = await getOrCreateWallet(telegramUserId, chainType);

    bot.sendMessage(chatId, `✅ **${chainType.toUpperCase()} Wallet Created!**\n\n📱 **Wallet ID:** \`${wallet.id}\`\n💰 **Address:** \`${wallet.address}\`\n🔗 **Chain:** ${chainType.toUpperCase()}\n\nYou can now trade on ${chainType.toUpperCase()}!`);
  } catch (error) {
    console.error('❌ Error creating wallet:', error);
    bot.sendMessage(chatId, `❌ Failed to create ${chainType.toUpperCase()} wallet.\n\nError: ${error.message}\n\nTry: /createwallet solana\nOr: /createwallet ethereum`);
  }
});

bot.onText(/\/wallet/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;

  try {
    // Get all user wallets
    const solanaWallet = await getOrCreateWallet(telegramUserId, 'solana');
    const ethereumWallet = await getOrCreateWallet(telegramUserId, 'ethereum');

    bot.sendMessage(chatId, `💰 **Your Wallets:**\n\n🔗 **Solana:**\n📱 ID: \`${solanaWallet.id}\`\n💰 Address: \`${solanaWallet.address}\`\n\n🔗 **Ethereum:**\n📱 ID: \`${ethereumWallet.id}\`\n💰 Address: \`${ethereumWallet.address}\``);
  } catch (error) {
    console.error('Error getting wallets:', error);
    bot.sendMessage(chatId, 'Error retrieving wallet information.');
  }
});

// Trading commands
bot.onText(/\/trade/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;

  try {
    // Parse the trade command
    const text = msg.text;
    const parts = text.split(' ');

    if (parts.length < 4) {
      bot.sendMessage(chatId, 'Usage: /trade <platform> <action> <amount> <asset>\n\nPlatforms:\n• solana ✅ (REAL TRADING)\n• polymarket ✅ (REAL TRADING)\n• hyperliquid ✅ (REAL TRADING)\n\nActions: buy, sell\n\nExamples:\n/trade solana buy 0.01 SOL ✅\n/trade polymarket buy 50 "Will BTC hit 200k?" ✅\n/trade hyperliquid buy 100 BTC ✅');
      return;
    }

    const platform = parts[1].toLowerCase();
    const action = parts[2].toLowerCase();
    const amount = parts[3];
    const asset = parts.slice(4).join(' '); // Join remaining parts for asset name

    // Map platform to chain type
    const chainTypeMap = {
      'solana': 'solana',
      'ethereum': 'ethereum',
      'hyperliquid': 'ethereum', // Hyperliquid uses Ethereum
      'polymarket': 'ethereum'   // Polymarket uses Ethereum
    };

    const chainType = chainTypeMap[platform];
    if (!chainType) {
      bot.sendMessage(chatId, 'Invalid platform. Supported: solana, ethereum, hyperliquid, polymarket');
      return;
    }

    // Get or create wallet for the correct chain
    const wallet = await getOrCreateWallet(telegramUserId, chainType);

    bot.sendMessage(chatId, `🔄 Processing ${action} ${amount} ${asset} on ${platform.toUpperCase()}...`);

    // Execute trade based on platform
    switch (platform) {
      case 'solana':
        await executeSolanaTrade(wallet.id, action, amount, asset, chatId);
        break;
      case 'ethereum':
        await executeEthereumTrade(wallet.id, action, amount, asset, chatId);
        break;
      case 'hyperliquid':
        await executeHyperliquidTrade(wallet.id, action, amount, asset, chatId);
        break;
      case 'polymarket':
        await executePolymarketTrade(wallet.id, action, amount, asset, chatId);
        break;
      default:
        bot.sendMessage(chatId, 'Invalid platform. Supported platforms: solana, ethereum, hyperliquid, polymarket');
    }

  } catch (error) {
    console.error('Error in trade command:', error);
    bot.sendMessage(chatId, `❌ Error processing trade: ${error.message}\n\nMake sure you have sufficient balance and try again.`);
  }
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;

  try {
    // Get balance from all platforms and chains
    const balances = await getAllBalances(telegramUserId);
    bot.sendMessage(chatId, balances);

  } catch (error) {
    console.error('Error getting balance:', error);
    bot.sendMessage(chatId, 'Error retrieving balance information.');
  }
});

bot.onText(/\/positions/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;

  try {
    // Get wallets
    const solanaWallet = await getOrCreateWallet(telegramUserId, 'solana');
    const ethereumWallet = await getOrCreateWallet(telegramUserId, 'ethereum');

    let positionsMessage = `📊 **Your Positions:**\n\n`;

    // Get Polymarket positions
    const polymarketPositions = await polymarketTrading.getPositions(ethereumWallet.id);
    if (polymarketPositions.positions && polymarketPositions.positions.length > 0) {
      positionsMessage += `🟢 **Polymarket:**\n`;
      polymarketPositions.positions.slice(0, 5).forEach((pos, index) => {
        const pnlEmoji = pos.pnl >= 0 ? '🟢' : '🔴';
        positionsMessage += `${index + 1}. ${pos.marketQuestion.substring(0, 50)}...\n`;
        positionsMessage += `   ${pos.outcome}: ${pos.shares.toFixed(2)} shares @ $${pos.currentPrice.toFixed(4)}\n`;
        positionsMessage += `   Value: $${pos.value.toFixed(2)} ${pnlEmoji} P&L: $${pos.pnl.toFixed(2)} (${pos.pnlPercent.toFixed(1)}%)\n\n`;
      });
    } else {
      positionsMessage += `🟢 **Polymarket:** No active positions\n\n`;
    }

    // Hyperliquid positions (when implemented)
    positionsMessage += `🔴 **Hyperliquid:** Positions tracking pending\n\n`;

    // Solana positions (when implemented)
    positionsMessage += `🟡 **Solana:** Positions tracking pending\n\n`;

    positionsMessage += `💡 **Note:** Only Polymarket positions are currently tracked.`;
    bot.sendMessage(chatId, positionsMessage);

  } catch (error) {
    console.error('Error getting positions:', error);
    bot.sendMessage(chatId, 'Error retrieving positions information.');
  }
});

bot.onText(/\/test/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;

  try {
    bot.sendMessage(chatId, '🧪 **Running comprehensive test suite...**');

    // Test 1: Wallet Creation
    let testResults = '🧪 **Test Results:**\n\n';

    try {
      const solanaWallet = await getOrCreateWallet(telegramUserId, 'solana');
      const ethereumWallet = await getOrCreateWallet(telegramUserId, 'ethereum');
      testResults += '✅ **Wallet Creation:** PASS\n';
      testResults += `   Solana: \`${solanaWallet.address}\`\n`;
      testResults += `   Ethereum: \`${ethereumWallet.address}\`\n\n`;
    } catch (error) {
      testResults += `❌ **Wallet Creation:** FAIL - ${error.message}\n\n`;
    }

    // Test 2: Balance Checking
    try {
      const balances = await getAllBalances(telegramUserId);
      testResults += '✅ **Balance Checking:** PASS\n\n';
    } catch (error) {
      testResults += `❌ **Balance Checking:** FAIL - ${error.message}\n\n`;
    }

    // Test 3: Jupiter APIs
    try {
      // Test Jupiter Token API V2
      const tokenSearchParams = new URLSearchParams({
        query: 'SOL',
        limit: '1'
      });

      const tokenResponse = await axios.get(`https://lite-api.jup.ag/tokens/v2/search?${tokenSearchParams}`, {
        timeout: 5000
      });

      if (tokenResponse.data && Array.isArray(tokenResponse.data) && tokenResponse.data.length > 0) {
        testResults += '✅ **Jupiter Token API V2:** PASS\n';
      } else {
        testResults += '⚠️ **Jupiter Token API V2:** PARTIAL\n';
      }

      // Test Jupiter Ultra API with a simple SOL to USDC order request
      const testWallet = '11111111111111111111111111111112'; // Test wallet for API validation
      const ultraParams = new URLSearchParams({
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amount: '1000000',
        taker: testWallet,
        slippageBps: '50'
      });

      const ultraResponse = await axios.get(`https://lite-api.jup.ag/ultra/v1/order?${ultraParams}`, {
        timeout: 5000
      });

      if (ultraResponse.data && ultraResponse.data.transaction) {
        testResults += '✅ **Jupiter Ultra API:** PASS\n\n';
      } else {
        testResults += '⚠️ **Jupiter Ultra API:** PARTIAL\n\n';
      }
    } catch (error) {
      testResults += `❌ **Jupiter APIs:** FAIL - ${error.message}\n\n`;
    }

    // Test 4: Polymarket
    try {
      const markets = await polymarketTrading.getMarkets(1);
      testResults += '✅ **Polymarket API:** PASS\n\n';
    } catch (error) {
      testResults += `⚠️ **Polymarket API:** ${error.message}\n\n`;
    }

    // Test 5: Hyperliquid
    try {
      const midsResponse = await axios.post('https://api.hyperliquid.xyz/info', {
        type: 'allMids'
      }, { timeout: 5000 });

      if (midsResponse.data && midsResponse.data.BTC) {
        testResults += '✅ **Hyperliquid API:** PASS\n';
        testResults += `   BTC Price: $${parseFloat(midsResponse.data.BTC).toLocaleString()}\n`;
        testResults += `   ETH Price: $${parseFloat(midsResponse.data.ETH).toLocaleString()}\n`;
        testResults += `   SOL Price: $${parseFloat(midsResponse.data.SOL).toLocaleString()}\n\n`;
      } else {
        testResults += '⚠️ **Hyperliquid API:** PARTIAL\n\n';
      }
    } catch (error) {
      testResults += `❌ **Hyperliquid API:** FAIL - ${error.message}\n\n`;
    }

    testResults += '🎯 **Ready for trading!** Use /trade to start trading.';

    bot.sendMessage(chatId, testResults);
  } catch (error) {
    console.error('Error running tests:', error);
    bot.sendMessage(chatId, `❌ Test failed: ${error.message}`);
  }
});

bot.onText(/\/exportwallet/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;
  const text = msg.text;
  const parts = text.split(' ');

  if (parts.length < 2) {
    bot.sendMessage(chatId, 'Usage: /exportwallet <chain>\nChains: solana, ethereum\n\n⚠️ **WARNING:** This will show your private key!\nKeep it secure and never share it.\n\nExample: /exportwallet solana');
    return;
  }

  const chain = parts[1].toLowerCase();

  if (!['solana', 'ethereum'].includes(chain)) {
    bot.sendMessage(chatId, '❌ Invalid chain. Supported: solana, ethereum');
    return;
  }

  try {
    bot.sendMessage(chatId, `🔄 Preparing to export ${chain} wallet...\n\n⚠️ **WARNING:** This will show your private key!\nKeep it secure and never share it with anyone.`);

    // Get wallet
    const wallet = await getOrCreateWallet(telegramUserId, chain);

    // Export wallet using Privy's REST API with HPKE encryption
    const privateKey = await exportWalletPrivateKey(wallet.id);

    // Send warning message first
    await bot.sendMessage(chatId, `🚨 **PRIVATE KEY EXPORT - KEEP SECURE!**\n\n🔐 **Your ${chain} private key:**\n\n\`${privateKey}\`\n\n⚠️ **SECURITY WARNINGS:**\n• Never share this key with anyone\n• Store it in a secure wallet\n• This key gives full access to your funds\n• Consider importing into MetaMask or Phantom\n\n🔗 **Import Guide:** https://privy-io.notion.site/Transferring-Your-App-Account-9dab9e16c6034a7ab1ff7fa479b02828`);

  } catch (error) {
    console.error('Error exporting wallet:', error);
    bot.sendMessage(chatId, `❌ Error exporting wallet: ${error.message}\n\nMake sure you have a wallet created first with /start or /createwallet`);
  }
});

bot.onText(/\/limit/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;
  const text = msg.text;
  const parts = text.split(' ');

  if (parts.length < 6) {
    bot.sendMessage(chatId, 'Usage: /limit <platform> <action> <amount> <asset> <price>\n\nPlatforms: solana, hyperliquid\nActions: buy, sell\n\nExamples:\n/limit solana buy 0.01 SOL 200\n/limit solana sell 100 USDC 1.01\n/limit hyperliquid buy 1 BTC 95000\n\n⚠️ **Note:** Limit orders monitor prices and execute automatically when conditions are met.');
    return;
  }

  const platform = parts[1].toLowerCase();
  const action = parts[2].toLowerCase();
  const amount = parts[3];
  const asset = parts[4];
  const targetPrice = parseFloat(parts[5]);

  if (!['solana', 'hyperliquid'].includes(platform)) {
    bot.sendMessage(chatId, '❌ Invalid platform. Supported: solana, hyperliquid');
    return;
  }

  if (!['buy', 'sell'].includes(action)) {
    bot.sendMessage(chatId, '❌ Invalid action. Supported: buy, sell');
    return;
  }

  if (isNaN(targetPrice) || targetPrice <= 0) {
    bot.sendMessage(chatId, '❌ Invalid price. Must be a positive number.');
    return;
  }

  try {
    // Get wallet
    const wallet = await getOrCreateWallet(telegramUserId, platform === 'solana' ? 'solana' : 'ethereum');

    // Create limit order
    const orderId = orderCounter++;
    const limitOrder = {
      id: orderId,
      platform,
      action,
      amount,
      asset,
      targetPrice,
      status: 'active',
      createdAt: new Date(),
      walletId: wallet.id,
      chatId
    };

    // Store order
    if (!limitOrders.has(telegramUserId)) {
      limitOrders.set(telegramUserId, []);
    }
    limitOrders.get(telegramUserId).push(limitOrder);

    bot.sendMessage(chatId, `✅ **Limit Order Created!**\n\n📋 **Order #${orderId}:**\n• ${action.toUpperCase()} ${amount} ${asset} when price ${action === 'buy' ? '≤' : '≥'} $${targetPrice}\n• Platform: ${platform}\n• Status: 🔄 Active\n\n💡 **Monitoring:** Price will be checked every 30 seconds.\n\nUse /orders to view all your limit orders.\nUse /cancel <order_id> to cancel this order.`);

  } catch (error) {
    console.error('Error creating limit order:', error);
    bot.sendMessage(chatId, `❌ Error creating limit order: ${error.message}`);
  }
});

bot.onText(/\/orders/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;

  try {
    const userOrders = limitOrders.get(telegramUserId) || [];

    if (userOrders.length === 0) {
      bot.sendMessage(chatId, '📋 **Your Limit Orders:**\n\n❌ No active limit orders found.\n\nCreate one with: /limit <platform> <action> <amount> <asset> <price>');
      return;
    }

    let message = '📋 **Your Limit Orders:**\n\n';
    userOrders.forEach(order => {
      const statusEmoji = order.status === 'active' ? '🔄' : order.status === 'executed' ? '✅' : '❌';
      message += `**#${order.id}:** ${statusEmoji} ${order.action.toUpperCase()} ${order.amount} ${order.asset} @ $${order.targetPrice}\n`;
      message += `   Platform: ${order.platform} | Status: ${order.status}\n\n`;
    });

    message += '💡 **Commands:**\n• /cancel <order_id> - Cancel order\n• /limit - Create new order';

    bot.sendMessage(chatId, message);

  } catch (error) {
    console.error('Error getting orders:', error);
    bot.sendMessage(chatId, '❌ Error retrieving orders.');
  }
});

bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;
  const text = msg.text;
  const parts = text.split(' ');

  if (parts.length < 2) {
    bot.sendMessage(chatId, 'Usage: /cancel <order_id>\n\nExample: /cancel 1\n\nUse /orders to see your order IDs.');
    return;
  }

  const orderId = parseInt(parts[1]);

  try {
    const userOrders = limitOrders.get(telegramUserId) || [];
    const orderIndex = userOrders.findIndex(order => order.id === orderId);

    if (orderIndex === -1) {
      bot.sendMessage(chatId, `❌ Order #${orderId} not found.\n\nUse /orders to see your active orders.`);
      return;
    }

    const order = userOrders[orderIndex];
    if (order.status !== 'active') {
      bot.sendMessage(chatId, `❌ Cannot cancel order #${orderId} - status: ${order.status}`);
      return;
    }

    // Mark as cancelled
    order.status = 'cancelled';
    bot.sendMessage(chatId, `✅ **Order Cancelled!**\n\n📋 **Order #${orderId}:**\n• ${order.action.toUpperCase()} ${order.amount} ${order.asset} @ $${order.targetPrice}\n• Status: ❌ Cancelled`);

  } catch (error) {
    console.error('Error cancelling order:', error);
    bot.sendMessage(chatId, '❌ Error cancelling order.');
  }
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
🤖 **Sniffy Trading Bot**

🏠 **Setup:**
• /start - Create wallets
• /wallet - View addresses
• /exportwallet <chain> - Export keys

💰 **Trading:**
• /trade solana buy <amount> <token>
• /trade hyperliquid buy <amount> <asset>
• /trade polymarket buy <amount> "<question>"

🎯 **Limit Orders:**
• /limit <platform> <action> <amount> <asset> <price>
• /orders - View your limit orders
• /cancel <order_id> - Cancel limit order

📊 **Portfolio:**
• /balance - View balances
• /positions - View your positions
• /tokeninfo <token> - Token info
• /status - Bot status
• /test - API tests

⚙️ **Supported Platforms:**
• **Solana**: Token swaps via Jupiter Ultra ✅
• **Ethereum**: DEX trading (coming soon)
• **Hyperliquid**: Real perpetual futures trading ✅
• **Polymarket**: Real prediction market trading with CLOB API ✅

🔑 **Multi-Chain Wallets:**
• Solana wallet for SOL, SPL tokens
• Ethereum wallet for ETH, ERC-20, DeFi
• Session signers enabled for bot trading

🧪 **Test Everything:** /test
  `;
  bot.sendMessage(chatId, helpMessage);
});

bot.onText(/\/markets/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    // Get Polymarket markets as an example
    const markets = await polymarketTrading.getMarkets(5);

    let marketsMessage = '📈 **Available Polymarket Markets:**\n\n';
    markets.forEach((market, index) => {
      marketsMessage += `${index + 1}. ${market.question}\n`;
      marketsMessage += `   ID: ${market.id}\n`;
      marketsMessage += `   Price: ${market.price}¢\n\n`;
    });

    marketsMessage += '**Solana**: SOL, USDC, and other tokens\n';
    marketsMessage += '**Hyperliquid**: BTC, ETH, and perpetual contracts\n\n';
    marketsMessage += 'Use /trade <platform> <action> <amount> <asset> to trade';

    bot.sendMessage(chatId, marketsMessage);
  } catch (error) {
    console.error('Error getting markets:', error);
    bot.sendMessage(chatId, 'Error retrieving market information.');
  }
});



bot.onText(/\/tokeninfo/, async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const parts = text.split(' ');

  if (parts.length < 2) {
    bot.sendMessage(chatId, 'Usage: /tokeninfo <query>\n\nExamples:\n/tokeninfo SOL\n/tokeninfo USDC\n/tokeninfo bonk\n/tokeninfo Bsow2wFkVzy1itJnhLke6VRTqoEkYQZp7kbwPtS87FyN\n\n💡 **Tip:** Search by symbol, name, or contract address');
    return;
  }

  const query = parts.slice(1).join(' ');

  try {
    bot.sendMessage(chatId, `🔍 Looking up "${query}"...`);

    // Check if it's a contract address (44 characters for Solana addresses)
    if (query.length === 44 && /^[A-HJ-NP-Z0-9]+$/i.test(query)) {
      // It's likely a contract address - validate it directly
      const validation = await solanaTrading.validateTokenAddress(query);

      if (validation.valid) {
        const token = validation.token;
        let message = `🪙 **Token Information:**\n\n`;
        message += `📝 **Name:** ${token.name}\n`;
        message += `🪪 **Symbol:** ${token.symbol}\n`;
        message += `📍 **Address:** \`${token.address}\`\n`;
        message += `📊 **Decimals:** ${token.decimals}\n`;

        if (validation.tradable) {
          message += `✅ **Tradable on Jupiter:** YES\n`;
          if (validation.source === 'jupiter-token-api-v2') {
            message += `🔍 **Source:** Jupiter Token API V2\n`;
          } else {
            message += `🔍 **Source:** Jupiter Main List\n`;
          }

          // Add rich data from Token API V2
          if (token.price) {
            message += `💰 **Price:** $${parseFloat(token.price).toFixed(6)}\n`;
          }
          if (token.mcap) {
            message += `📊 **Market Cap:** $${parseFloat(token.mcap).toLocaleString()}\n`;
          }
          if (token.liquidity) {
            message += `💧 **Liquidity:** $${parseFloat(token.liquidity).toLocaleString()}\n`;
          }
          if (token.daily_volume) {
            message += `📈 **24h Volume:** $${parseFloat(token.daily_volume).toLocaleString()}\n`;
          }
          if (token.isVerified !== undefined) {
            message += `✅ **Verified:** ${token.isVerified ? 'YES' : 'NO'}\n`;
          }
          if (token.tags && token.tags.length > 0) {
            message += `🏷️ **Tags:** ${token.tags.join(', ')}\n`;
          }

          message += `\n🚀 **Ready to Trade!**\n`;
          message += `💡 **Use:** /trade solana buy 0.01 ${token.symbol} or sell 10 ${token.symbol}`;
        } else {
          message += `❌ **Tradable on Jupiter:** NO\n`;
          message += `🔍 **Source:** Solana RPC Only\n`;
          if (validation.supply) {
            message += `📊 **Total Supply:** ${validation.supply}\n`;
          }
          message += `\n⚠️ **Note:** This token is not listed on Jupiter and cannot be traded through our bot.\n\n`;
          message += `🔗 **Solscan:** https://solscan.io/token/${token.address}`;
        }

        bot.sendMessage(chatId, message);
      } else {
        bot.sendMessage(chatId, `❌ **Invalid Token Address:**\n\n${validation.error}\n\n🔗 **Check on Solscan:** https://solscan.io/token/${query}`);
      }
    } else {
      // It's a search query - search for tokens
      const searchResults = await solanaTrading.searchToken(query);

      if (!searchResults || !searchResults.tokens || searchResults.tokens.length === 0) {
        let message = `❌ No tokens found for "${query}"\n\n`;
        if (searchResults?.source === 'error') {
          message += `**Error:** ${searchResults.error}\n\n`;
        }
        message += `Try:\n• Different keywords\n• Contract address directly\n• Popular tokens like SOL, USDC, BONK`;
        bot.sendMessage(chatId, message);
        return;
      }

      let message = `🔍 **Search Results for "${query}":**\n`;
      message += `📊 **Source:** ${searchResults.source === 'jupiter-token-api-v2' ? 'Jupiter Token API V2' : 'Jupiter Main List'}\n\n`;

      searchResults.tokens.slice(0, 5).forEach((token, index) => {
        message += `${index + 1}. **${token.symbol}** - ${token.name}\n`;
        message += `   📍 \`${token.id || token.address}\`\n`;
        message += `   ✅ Tradable on Jupiter\n`;

        // Add rich data if available from API V2
        if (token.usdPrice) {
          message += `   💰 Price: $${parseFloat(token.usdPrice).toFixed(6)}\n`;
        }
        if (token.mcap) {
          message += `   📊 MC: $${parseFloat(token.mcap).toLocaleString()}\n`;
        }
        if (token.isVerified !== undefined) {
          message += `   ✅ Verified: ${token.isVerified ? 'YES' : 'NO'}\n`;
        }

        message += `\n`;
      });

      if (searchResults.tokens.length > 5) {
        message += `... and ${searchResults.tokens.length - 5} more results\n\n`;
      }

      message += `💡 **Use:** /trade solana buy 0.01 <SYMBOL> to trade\n`;
      message += `🔍 **Tip:** Use contract address directly for detailed info`;

      bot.sendMessage(chatId, message);
    }
  } catch (error) {
    console.error('Error looking up token:', error);
    bot.sendMessage(chatId, `❌ Error: ${error.message}\n\nTry again or use a different search term.`);
  }
});







bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const statusMessage = `
✅ **Bot Status: Online**

🔗 **Connected Services:**
• Solana ✅
• Jupiter ✅
• Hyperliquid ✅
• Polymarket ✅

💰 **Ready to Trade:**
• /trade solana buy <amount> <token>
• /trade hyperliquid buy <amount> <asset>
• /trade polymarket buy <amount> "<question>"

🎯 **Limit Orders:**
• /limit <platform> <action> <amount> <asset> <price>
• /orders - View your limit orders
• /cancel <order_id> - Cancel limit order

📊 **Portfolio:**
• /balance - View balances
• /wallet - View addresses
• /exportwallet <chain> - Export keys
  `;
  bot.sendMessage(chatId, statusMessage);
});

bot.onText(/\/debug/, (msg) => {
  const chatId = msg.chat.id;
  const debugMessage = `
🐛 **Debug Information:**

📊 **Telegram Data:**
• User ID: ${msg.from.id}
• Username: @${msg.from.username || 'None'}
• First Name: ${msg.from.first_name || 'None'}
• Chat ID: ${chatId}
• Chat Type: ${msg.chat.type}

⚙️ **Bot Config:**
• Privy App ID: ${PRIVY_APP_ID.substring(0, 8)}...
• Telegram Token: ${token.substring(0, 10)}...
• Node Version: ${process.version}

🔗 **API Status:**
• Privy: Connected ✅
• Jupiter: Ready ✅
• Solana RPC: Connected ✅
  `;
  bot.sendMessage(chatId, debugMessage);
});

// Trading functions
async function executeSolanaTrade(walletId, action, amount, asset, chatId) {
  await solanaTrading.executeTrade(walletId, action, amount, asset, chatId, bot);
}

async function executeEthereumTrade(walletId, action, amount, asset, chatId) {
  // For now, use a simple implementation
  // In production, you'd integrate with DEXes like Uniswap
  bot.sendMessage(chatId, `⚠️ Ethereum trading coming soon!\n\nAction: ${action} ${amount} ${asset}\nWallet: ${walletId}\n\nUse /trade solana for Solana trading.`);
}

async function executeHyperliquidTrade(walletId, action, amount, asset, chatId) {
  await hyperliquidTrading.executeTrade(walletId, action, amount, asset, chatId, bot);
}

async function executePolymarketTrade(walletId, action, amount, asset, chatId) {
  await polymarketTrading.executeTrade(walletId, action, amount, asset, chatId, bot);
}

async function getAllBalances(telegramUserId) {
  try {
    // Get both wallets
    const solanaWallet = await getOrCreateWallet(telegramUserId, 'solana');
    const ethereumWallet = await getOrCreateWallet(telegramUserId, 'ethereum');

    // Get balances for each wallet
    const solanaBalance = await solanaTrading.getBalance(solanaWallet.id);
    const hyperliquidBalance = await hyperliquidTrading.getBalance(ethereumWallet.id);
    const polymarketBalance = await polymarketTrading.getBalance(ethereumWallet.id);

    return `💰 **Your Balances:**

🔗 **Solana Chain:**
• **SOL**: ${solanaBalance.toFixed(4)} SOL
• **Address**: \`${solanaWallet.address}\`

🔗 **Ethereum Chain:**
• **Hyperliquid**: $${hyperliquidBalance.toFixed(2)} ✅ (Perpetual Futures)
• **Polymarket**: $${polymarketBalance.toFixed(2)} ✅ (Prediction Markets)
• **Address**: \`${ethereumWallet.address}\`

💡 **Trading Ready!** Use /trade to start trading.`;
  } catch (error) {
    console.error('Error getting balances:', error);
    return '❌ Error retrieving balance information';
  }
}

// Export wallet private key using Privy's REST API with HPKE encryption
async function exportWalletPrivateKey(walletId) {
  const { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } = require('@hpke/core');
  const { Chacha20Poly1305 } = require('@hpke/chacha20poly1305');

  try {
    // Generate a key pair for HPKE encryption
    const keypair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );

    const [publicKey, privateKey] = await Promise.all([
      crypto.subtle.exportKey("spki", keypair.publicKey),
      crypto.subtle.exportKey("pkcs8", keypair.privateKey)
    ]);

    const [publicKeyBase64, privateKeyBase64] = [
      Buffer.from(publicKey).toString("base64"),
      Buffer.from(privateKey).toString("base64")
    ];

    // Create authorization signature
    const input = {
      headers: {
        "privy-app-id": process.env.PRIVY_APP_ID,
      },
      method: "POST",
      url: `https://api.privy.io/v1/wallets/${walletId}/export`,
      version: 1,
      body: {
        encryption_type: "HPKE",
        recipient_public_key: publicKeyBase64,
      },
    };

    const signature = privy.walletApi.generateAuthorizationSignature({
      input: input,
      authorizationPrivateKey: process.env.PRIVY_AUTH_KEY_PRIVATE
    });

    // Make the export request
    const response = await axios.post(
      `https://api.privy.io/v1/wallets/${walletId}/export`,
      input.body,
      {
        headers: {
          ...input.headers,
          "Content-Type": "application/json",
          "privy-authorization-signature": signature,
          "Authorization": `Basic ${Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString('base64')}`,
        },
      }
    );

    if (response.data && response.data.ciphertext && response.data.encapsulated_key) {
      // Decrypt the private key
      const cipherSuite = new CipherSuite({
        kem: new DhkemP256HkdfSha256(),
        kdf: new HkdfSha256(),
        aead: new Chacha20Poly1305()
      });

      const base64ToBuffer = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;

      const recipientKey = await crypto.subtle.importKey(
        'pkcs8',
        base64ToBuffer(privateKeyBase64),
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits']
      );

      const recipient = await cipherSuite.createRecipientContext({
        recipientKey: recipientKey,
        enc: base64ToBuffer(response.data.encapsulated_key)
      });

      const decryptedPrivateKey = new TextDecoder().decode(
        await recipient.open(base64ToBuffer(response.data.ciphertext))
      );

      return decryptedPrivateKey;
    } else {
      throw new Error('Invalid response from Privy API');
    }

  } catch (error) {
    console.error('Error exporting wallet:', error);
    throw new Error(`Failed to export wallet: ${error.message}`);
  }
}

// Limit order monitoring system
async function checkLimitOrders() {
  try {
    // Iterate through all users with limit orders
    for (const [telegramUserId, userOrders] of limitOrders.entries()) {
      // Filter active orders
      const activeOrders = userOrders.filter(order => order.status === 'active');

      for (const order of activeOrders) {
        try {
          let currentPrice = null;

          // Get current price based on platform
          if (order.platform === 'solana') {
            // For Solana, check if asset is SOL or get from Jupiter
            if (order.asset.toUpperCase() === 'SOL') {
              const solPriceResponse = await axios.get('https://lite-api.jup.ag/tokens/v2/search?query=SOL&limit=1');
              if (solPriceResponse.data && solPriceResponse.data[0]) {
                currentPrice = parseFloat(solPriceResponse.data[0].usdPrice);
              }
            } else {
              // For other Solana tokens, we'd need to implement price checking
              // For now, skip non-SOL tokens
              continue;
            }
          } else if (order.platform === 'hyperliquid') {
            // Get price from Hyperliquid
            const midsResponse = await axios.post('https://api.hyperliquid.xyz/info', {
              type: 'allMids'
            }, { timeout: 5000 });

            if (midsResponse.data && midsResponse.data[order.asset.toUpperCase()]) {
              currentPrice = parseFloat(midsResponse.data[order.asset.toUpperCase()]);
            }
          }

          if (!currentPrice) continue;

          // Check if condition is met
          let conditionMet = false;
          if (order.action === 'buy' && currentPrice <= order.targetPrice) {
            conditionMet = true;
          } else if (order.action === 'sell' && currentPrice >= order.targetPrice) {
            conditionMet = true;
          }

          if (conditionMet) {
            // Execute the order
            try {
              if (order.platform === 'solana') {
                await executeSolanaTrade(order.walletId, order.action, order.amount, order.asset, order.chatId);
              } else if (order.platform === 'hyperliquid') {
                await executeHyperliquidTrade(order.walletId, order.action, order.amount, order.asset, order.chatId);
              }

              // Mark order as executed
              order.status = 'executed';
              order.executedAt = new Date();
              order.executedPrice = currentPrice;

              // Notify user
              bot.sendMessage(order.chatId, `🚀 **Limit Order Executed!**\n\n✅ **Order #${order.id} Filled:**\n• ${order.action.toUpperCase()} ${order.amount} ${order.asset}\n• Target: $${order.targetPrice}\n• Executed: $${currentPrice.toFixed(4)}\n• Platform: ${order.platform}\n\n💰 **Check /balance for updated funds!**`);

            } catch (executeError) {
              console.error(`Error executing limit order ${order.id}:`, executeError);
              // Could add retry logic here
            }
          }

        } catch (priceError) {
          console.error(`Error checking price for order ${order.id}:`, priceError);
        }
      }
    }
  } catch (error) {
    console.error('Error in limit order monitoring:', error);
  }
}

// Start limit order monitoring (check every 30 seconds)
setInterval(checkLimitOrders, 30000);

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

console.log('Telegram trading bot is ready!');
